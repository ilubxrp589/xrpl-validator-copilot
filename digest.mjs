// Phase 3 — scheduled health digest.
//
// Pushes a periodic (daily/weekly) recap to the alert channel: current verdict, the
// incidents that happened over the period (from incident memory), and a few trend /
// signal highlights. Opt-in: config.alerts.digest = 'daily' | 'weekly' ('off' = no
// digest). Read-only — it only reads signals and notifies.

import { config } from './config.mjs';
import { readAll } from './tools.mjs';
import { assess } from './assess.mjs';
import { getTrend } from './trend.mjs';
import { incidentSummary } from './incidents.mjs';
import { notify } from './watchdog.mjs';

const isWeekly = () => config.alerts.digest === 'weekly';
const periodHours = () => (isWeekly() ? 168 : 24);

export async function buildDigest() {
  const a = assess(await readAll());
  const hrs = periodHours();
  const days = Math.max(1, Math.round(hrs / 24));
  const inc = incidentSummary(hrs);
  const trend = getTrend(Math.min(hrs * 60, 1440));   // trend buffer holds ~24h
  const sig = a.signals || {};
  const lines = [`📋 ${isWeekly() ? 'Weekly' : 'Daily'} validator digest — ${a.verdict}`, a.one_liner];

  if (inc.quiet) lines.push(`\n✅ No incidents in the last ${days}d.`);
  else {
    const parts = Object.entries(inc.by_kind).map(([k, n]) => `${n}× ${k.replace(/_/g, ' ')}`).join(', ');
    lines.push(`\n⚠️ ${inc.total} incident(s) in ${days}d: ${parts}.`);
    if (inc.last_incident) lines.push(`Last: ${inc.last_incident.kind} (${inc.last_incident.verdict || '?'}) ${inc.last_incident.ago_min}m ago.`);
  }

  const hi = [];
  if (trend && !trend.note) {
    if (trend.new_divergences != null) hi.push(`divergences +${trend.new_divergences} over ${trend.span_minutes}m`);
    if (trend.match_streak) hi.push(`match streak +${trend.match_streak.delta}`);
    if (trend.host_memory_pct) hi.push(`host mem ${trend.host_memory_pct.to}% (${trend.host_memory_pct.delta >= 0 ? '+' : ''}${trend.host_memory_pct.delta})`);
  }
  if (sig.validation?.detail) hi.push(sig.validation.detail.split(' — ')[0]);
  if (sig.validator_list?.soonest_days != null) hi.push(`UNL expiry ${sig.validator_list.soonest_days}d`);
  if (hi.length) lines.push('\n' + hi.map((x) => `• ${x}`).join('\n'));

  return lines.join('\n');
}

export async function sendDigestNow() {
  if (config.alerts.digest === 'off' || !config.alerts.channel) return { skipped: true, note: 'digest is off or no alert channel configured' };
  return notify(await buildDigest());
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(config.alerts.digestHourUtc, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + (isWeekly() ? 7 : 1));
  return next - now;
}

let timer = null;
export function startDigest() {
  if (config.alerts.digest === 'off' || !config.alerts.channel) return false;
  const schedule = () => {
    timer = setTimeout(async () => { try { await sendDigestNow(); } catch { /* ignore */ } schedule(); }, msUntilNextRun());
    timer.unref?.();
  };
  schedule();
  return true;
}
