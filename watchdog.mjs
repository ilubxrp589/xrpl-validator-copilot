// Phase 2 — predictive watchdog (READ-ONLY).
//
// Watches COP's own deterministic verdict + the trend buffer and pushes an alert
// when something goes wrong — reactively (verdict flips to a bad state) AND
// predictively (trends that signal trouble before the verdict tips). It only
// READS and NOTIFIES; it never touches the node. De-bounced (must persist 2 ticks)
// and de-duped (cooldown between repeats), and it sends a recovery note on clear,
// so it won't spam.

import { config } from './config.mjs';
import { recordIncident, countOfKind } from './incidents.mjs';

const A = config.alerts;
const state = new Map(); // key -> { count, alerted, lastAlertAt, level }

const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// The detail of each gating signal that's off — the human reason for WATCH/DEGRADED.
function signalDetails(a) {
  return (a.triggers || []).map((t) => {
    const k = t.split(':')[0];
    const s = a.signals?.[k];
    return s?.detail ? `• ${s.detail}` : `• ${t}`;
  }).join('\n');
}

/** The set of alert conditions implied by the current assessment + trend. */
export function conditions(a, trend) {
  const out = [];
  const v = a.verdict;

  // Reactive — from the deterministic verdict
  if (v === 'AMENDMENT_BLOCKED') out.push({ key: 'amendment_blocked', level: 'critical', title: '🔴 AMENDMENT-BLOCKED', detail: a.one_liner });
  else if (v === 'HALT_SUSPECTED') out.push({ key: 'halt_suspected', level: 'critical', title: '🔴 HALT SUSPECTED', detail: a.one_liner });
  else if (v === 'UNREACHABLE') out.push({ key: 'unreachable', level: 'critical', title: '🔴 NODE UNREACHABLE', detail: a.one_liner });
  else if (v === 'DEGRADED') out.push({ key: 'degraded', level: 'critical', title: '🔴 DEGRADED', detail: signalDetails(a) || a.one_liner });
  else if (v === 'WATCH') out.push({ key: 'watch', level: 'warning', title: '🟡 WATCH', detail: signalDetails(a) || a.one_liner });

  // Predictive — trend-based; can fire even when the snapshot verdict still looks OK.
  // (Tier-aware: these fields are null on a stock node, so they simply don't fire.)
  if (trend && !trend.note) {
    if (trend.new_divergences > 0) out.push({ key: 'divergence_growing', level: 'warning', title: '🟡 Divergence growing', detail: `+${trend.new_divergences} new in ${trend.span_minutes}m (${trend.divergences_per_min}/min) — investigate before it escalates` });
    if (trend.match_streak && trend.match_streak.stalled && v !== 'SYNCING') out.push({ key: 'streak_stalled', level: 'warning', title: '🟡 Match streak stalled', detail: `state-hash match streak not advancing over ${trend.span_minutes}m while not syncing` });
  }
  return out;
}

/** Called on every sample. Diffs conditions vs prior state and fires alerts. */
export async function tick(a) {
  if (!A.channel) return; // alerts disabled
  let trend = null;
  try { const { getTrend } = await import('./trend.mjs'); trend = getTrend(30); } catch { /* ignore */ }
  const current = conditions(a, trend);
  const curKeys = new Set(current.map((c) => c.key));
  const now = Date.now();

  // rising edges (debounce: must persist ≥2 ticks; cooldown between repeats)
  for (const c of current) {
    const st = state.get(c.key) || { count: 0, alerted: false, lastAlertAt: 0, level: c.level };
    st.count += 1; st.level = c.level;
    const cooled = now - st.lastAlertAt > A.cooldownMin * 60_000;
    if (st.count >= 2 && (!st.alerted || cooled)) {
      recordIncident({ kind: c.key, level: c.level, verdict: a.verdict, detail: c.detail });
      const n = countOfKind(c.key);
      const ctx = n > 1 ? ` (${ordinal(n)} in 7d)` : '';
      await send(`${c.title}${ctx}\n${c.detail}`);
      st.alerted = true; st.lastAlertAt = now;
    }
    state.set(c.key, st);
  }
  // falling edges (cleared → recovery note)
  for (const [key, st] of [...state]) {
    if (!curKeys.has(key)) {
      if (st.alerted) await send(`🟢 RESOLVED — ${key.replace(/_/g, ' ')} cleared.\n${a.one_liner}`);
      state.delete(key);
    }
  }
}

export async function sendTest() {
  return send('✅ Validator Copilot watchdog online — test alert. You\'ll get a push here when the verdict degrades or a trend goes wrong.');
}

async function send(text) {
  try {
    if (A.channel === 'telegram') return await sendTelegram(text);
    if (A.channel === 'webhook') return await sendWebhook(text);
  } catch (e) { return { error: String(e?.message || e) }; }
  return { error: `no/unknown alert channel '${A.channel}'` };
}

// Same channel, for the scheduled digest (and anything else that wants to push).
export const notify = (text) => send(text);

async function sendTelegram(text) {
  const { token, chatId } = A.telegram;
  if (!token || !chatId) return { error: 'telegram token/chatId not set' };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return res.ok ? { ok: true } : { error: `telegram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
}

async function sendWebhook(text) {
  if (!A.webhookUrl) return { error: 'webhook url not set' };
  const f = A.webhookFormat;
  const body = f === 'slack' ? JSON.stringify({ text }) : f === 'discord' ? JSON.stringify({ content: text }) : f === 'ntfy' ? text : JSON.stringify({ text });
  const headers = f === 'ntfy' ? {} : { 'content-type': 'application/json' };
  const res = await fetch(A.webhookUrl, { method: 'POST', headers, body });
  return res.ok ? { ok: true } : { error: `webhook HTTP ${res.status}` };
}
