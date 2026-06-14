// Phase 1 — trend memory.
//
// Samples the deterministic verdict + key signals on an interval into a ring
// buffer (+ trend.jsonl so it survives restarts), and exposes getTrend() which
// turns that raw history into deltas/rates over a window. This is what lets COP
// answer "is X *growing*?" / "when did it start?" instead of staring at the
// cumulative-since-start counters, which can't express a rate.
//
// Read-only: it only reads the same signals COP already reads, and writes one
// local jsonl. Nothing here can touch the node.

import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { readAll, runTool } from './tools.mjs';
import { assess } from './assess.mjs';

const FILE = new URL('./trend.jsonl', import.meta.url);
const MAX = Number(process.env.COPILOT_TREND_MAX || 2880);          // ~24h @ 30s
const INTERVAL_MS = Number(process.env.COPILOT_TREND_INTERVAL_MS || 30_000);

const ring = [];
let appendsSinceCompact = 0;
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const recs = readFileSync(FILE, 'utf8').trimEnd().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    ring.push(...recs.slice(-MAX));
    if (recs.length > MAX) compact();
  } catch { /* no file yet */ }
}

function compact() {
  try { writeFileSync(FILE, ring.map((r) => JSON.stringify(r)).join('\n') + '\n'); appendsSinceCompact = 0; } catch { /* ignore */ }
}

/** Take one sample now: verdict + the signals worth tracking over time. */
export async function sample() {
  ensureLoaded();
  const a = assess(await readAll());
  let ram = null;
  try { const res = await runTool('get_node_resources'); ram = res?.validator_ram_gb ?? null; } catch { /* ignore */ }
  const s = a.signals;
  const d = s.divergences || {};
  const rec = {
    ts: Date.now(),
    verdict: a.verdict,
    cm: s.state_integrity?.consecutive_matches ?? null,   // cumulative
    mm: s.state_integrity?.total_mismatches ?? null,      // cumulative
    lag: s.ledger_lag?.lag ?? null,                       // level
    div: (d.live_apply_diverged ?? 0) + (d.silent ?? 0) + (d.mutation ?? 0) + (d.shadow_hash_mismatched ?? 0), // cumulative
    miss: s.state_rocks?.miss_rate ?? null,               // level
    state: s.source_rippled?.server_state ?? null,
    peers: s.source_rippled?.peers ?? null,
    ram,                                                  // m3060 validator-process RAM (GB)
  };
  ring.push(rec);
  while (ring.length > MAX) ring.shift();
  try { appendFileSync(FILE, JSON.stringify(rec) + '\n'); } catch { /* ignore */ }
  if (++appendsSinceCompact >= 200) compact();
  return rec;
}

let timer = null;
export function startSampler(intervalMs = INTERVAL_MS) {
  ensureLoaded();
  sample().catch(() => {});                 // immediate first sample
  if (timer) clearInterval(timer);
  timer = setInterval(() => { sample().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return timer;
}

/** Turn the history over the last `windowMinutes` into deltas and rates. */
export function getTrend(windowMinutes = 60) {
  ensureLoaded();
  const now = Date.now();
  const winMs = Math.max(1, windowMinutes) * 60_000;
  const recs = ring.filter((r) => now - r.ts <= winMs);
  if (recs.length < 2) {
    return {
      window_minutes: windowMinutes,
      samples: recs.length,
      note: `insufficient history (need >=2 samples in window, have ${recs.length}). Sampler runs every ${Math.round(INTERVAL_MS / 1000)}s; check back shortly.`,
      latest: ring[ring.length - 1] || null,
    };
  }
  const first = recs[0], last = recs[recs.length - 1];
  const spanMin = (last.ts - first.ts) / 60_000;
  const perMin = (a, b) => (spanMin > 0 ? +(((b ?? 0) - (a ?? 0)) / spanMin).toFixed(2) : 0);
  const flips = [];
  for (let i = 1; i < recs.length; i++) if (recs[i].verdict !== recs[i - 1].verdict) flips.push({ ts: recs[i].ts, from: recs[i - 1].verdict, to: recs[i].verdict });
  const lags = recs.map((r) => r.lag).filter((x) => x != null);
  const rams = recs.map((r) => r.ram).filter((x) => x != null);
  return {
    window_minutes: windowMinutes,
    span_minutes: +spanMin.toFixed(1),
    samples: recs.length,
    current_verdict: last.verdict,
    verdict_flips: flips,
    match_streak: { from: first.cm, to: last.cm, delta: (last.cm ?? 0) - (first.cm ?? 0), per_min: perMin(first.cm, last.cm), stalled: (last.cm ?? 0) - (first.cm ?? 0) === 0 },
    new_mismatches: (last.mm ?? 0) - (first.mm ?? 0),
    new_divergences: (last.div ?? 0) - (first.div ?? 0),   // THE rate-of-divergence answer (not cumulative)
    divergences_per_min: perMin(first.div, last.div),
    miss_rate: { from: first.miss, to: last.miss, direction: last.miss > first.miss ? 'rising' : last.miss < first.miss ? 'falling' : 'flat' },
    ledger_lag: lags.length ? { min: Math.min(...lags), max: Math.max(...lags), last: last.lag } : null,
    rippled_state: { from: first.state, to: last.state, changed: first.state !== last.state },
    peers: { from: first.peers, to: last.peers },
    validator_ram_gb: rams.length ? { from: first.ram, to: last.ram, delta: +((last.ram ?? 0) - (first.ram ?? 0)).toFixed(2), per_min: perMin(first.ram, last.ram), note: 'm3060 validator-process RAM; a sustained climb = memory pressure worth watching' } : null,
  };
}
