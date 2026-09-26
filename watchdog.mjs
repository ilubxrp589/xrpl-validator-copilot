// Phase 2 — predictive watchdog (READ-ONLY).
//
// Watches COP's own deterministic verdict + the trend buffer and pushes an alert
// when something goes wrong — reactively (verdict flips to a bad state) AND
// predictively (trends that signal trouble before the verdict tips). It only
// READS and NOTIFIES; it never touches the node. De-bounced (must persist 2 ticks);
// a warning pages once per episode (again only when a new signal joins it), a
// critical condition repeats after the cooldown, and it sends a recovery note on
// clear, so it won't spam.

import { config } from './config.mjs';
import { recordIncident, countOfKind } from './incidents.mjs';
import { readFileSync, existsSync } from 'node:fs';

const A = config.alerts;
const state = new Map(); // key -> { count, alerted, lastAlertAt, level, paged, mutedRecorded }

// Mute switch (2026-09-11): a `MUTE` file beside config.local.json silences pages
// and recovery notes while it exists — incidents are still recorded, conditions
// still tracked, so the first tick after unmute pages anything still present.
// Empty file (or "on") = muted until removed; otherwise its first line is an
// expiry: epoch seconds or an ISO datetime. Toggle with ./mute.sh on|off|<min>.
// Meant for rapid deploy cycles, where every relaunch reads DEGRADED for a while.
const MUTE_FILE = new URL('./MUTE', import.meta.url);
let muteLogged = null;
function muteState() {
  if (!existsSync(MUTE_FILE)) { if (muteLogged !== false) { muteLogged = false; console.log('[watchdog] alerts LIVE'); } return { muted: false }; }
  let until = null;
  try {
    const raw = readFileSync(MUTE_FILE, 'utf8').split('\n')[0].trim();
    if (raw && raw !== 'on') { const n = Number(raw); until = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(raw); }
  } catch { /* unreadable → treat as muted */ }
  const muted = until == null || Number.isNaN(until) || Date.now() < until;
  if (muted && muteLogged !== true) { muteLogged = true; console.log(`[watchdog] alerts MUTED${until ? ` until ${new Date(until).toISOString()}` : ' until MUTE is removed'}`); }
  if (!muted && muteLogged !== false) { muteLogged = false; console.log('[watchdog] alerts LIVE (mute expired)'); }
  return { muted, until };
}

const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// The names of the gating signals that are off (triggers read "<signal>:<status>").
const triggerNames = (a) => (a.triggers || []).map((t) => t.split(':')[0]);

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
  else if (v === 'DEGRADED') out.push({ key: 'degraded', level: 'critical', title: '🔴 DEGRADED', detail: signalDetails(a) || a.one_liner, signals: triggerNames(a) });
  else if (v === 'WATCH') out.push({ key: 'watch', level: 'warning', title: '🟡 WATCH', detail: signalDetails(a) || a.one_liner, signals: triggerNames(a) });

  // Predictive — trend-based; can fire even when the snapshot verdict still looks OK.
  // (Tier-aware: these fields are null on a stock node, so they simply don't fire.)
  if (trend && !trend.note) {
    // 2026-08-26: defer to the snapshot signal's CLASSIFICATION. The known
    // seq-order shadow-feeder residue (tefPAST_SEQ/terPRE_SEQ, state hashes
    // clean) grows steadily and reads status 'ok' in assess.mjs — its growth
    // must not page. Any unexplained divergence class flips that signal to
    // 'watch', which re-arms this predictive alert automatically.
    if (trend.new_divergences > 0 && a.signals?.divergences?.status !== 'ok') out.push({ key: 'divergence_growing', level: 'warning', title: '🟡 Divergence growing', detail: `+${trend.new_divergences} new in ${trend.span_minutes}m (${trend.divergences_per_min}/min) — investigate before it escalates` });
    if (trend.match_streak && trend.match_streak.stalled && v !== 'SYNCING') out.push({ key: 'streak_stalled', level: 'warning', title: '🟡 Match streak stalled', detail: `state-hash match streak not advancing over ${trend.span_minutes}m while not syncing` });
  }
  return out;
}

/**
 * One tick of one present condition: its next state, and what to do about it — null (nothing),
 * 'new' (rising edge), 'changed' (a signal no earlier page of this episode named has joined it),
 * 'repeat' (critical, still present after the cooldown) or 'muted' (would page; record it instead).
 *
 * A warning does not repeat: a slow condition such as store pruning (days until the next rotation)
 * reads WATCH for days with numbers that change every tick, and on 2026-09-26 repeating it every
 * cooldown paged 21 times in five hours. While muted nothing pages and nothing is marked paged, so
 * the first live tick pages whatever is still there; the incident is recorded once.
 */
export function advance(prev, c, now, cooldownMs, muted = false) {
  const st = prev ? { ...prev, paged: new Set(prev.paged) } : { count: 0, alerted: false, lastAlertAt: 0, paged: new Set(), mutedRecorded: false };
  st.count += 1; st.level = c.level;
  if (st.count < 2) return { st, action: null };   // debounce: must persist ≥2 ticks
  const signals = c.signals || [];
  const action = !st.alerted ? 'new'
    : signals.some((s) => !st.paged.has(s)) ? 'changed'
    : c.level === 'critical' && now - st.lastAlertAt > cooldownMs ? 'repeat'
    : null;
  if (!action) return { st, action };
  if (muted) {
    if (st.mutedRecorded) return { st, action: null };
    st.mutedRecorded = true;
    return { st, action: 'muted' };
  }
  st.alerted = true; st.lastAlertAt = now;
  for (const s of signals) st.paged.add(s);
  return { st, action };
}

/** Called on every sample. Diffs conditions vs prior state and fires alerts. */
export async function tick(a) {
  if (!A.channel) return; // alerts disabled
  const { muted } = muteState();
  let trend = null;
  try { const { getTrend } = await import('./trend.mjs'); trend = getTrend(30); } catch { /* ignore */ }
  const current = conditions(a, trend);
  const curKeys = new Set(current.map((c) => c.key));
  const now = Date.now();

  // rising edges, new signals, critical repeats (see advance)
  for (const c of current) {
    const { st, action } = advance(state.get(c.key), c, now, A.cooldownMin * 60_000, muted);
    state.set(c.key, st);
    if (action === 'muted') recordIncident({ kind: c.key, level: c.level, verdict: a.verdict, detail: `${c.detail} [muted]` });
    else if (action === 'repeat') await send(`${c.title} (still present)\n${c.detail}`);
    else if (action) {
      recordIncident({ kind: c.key, level: c.level, verdict: a.verdict, detail: c.detail });
      const n = countOfKind(c.key);
      const ctx = n > 1 ? ` (${ordinal(n)} in 7d)` : '';
      await send(`${c.title}${ctx}\n${c.detail}`);
    }
  }
  // falling edges (cleared → recovery note)
  for (const [key, st] of [...state]) {
    if (!curKeys.has(key)) {
      if (st.alerted && !muted) await send(`🟢 RESOLVED — ${key.replace(/_/g, ' ')} cleared.\n${a.one_liner}`);
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
