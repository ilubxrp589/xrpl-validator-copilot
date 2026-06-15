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
  const div = s.divergences;
  const rec = {
    ts: Date.now(),
    verdict: a.verdict,
    cm: s.state_integrity?.consecutive_matches ?? null,   // FFI, cumulative
    mm: s.state_integrity?.total_mismatches ?? null,      // FFI, cumulative
    lag: s.ffi_lag?.lag ?? null,                          // FFI, level
    div: div ? (div.live_apply_diverged ?? 0) + (div.silent ?? 0) + (div.mutation ?? 0) + (div.shadow_hash_mismatched ?? 0) : null, // FFI, cumulative
    miss: s.state_rocks?.miss_rate ?? null,               // FFI, level
    state: s.server_state?.server_state ?? null,          // generic
    age: s.ledger?.age ?? null,                           // generic — ledger currency
    peers: s.peers?.peers ?? null,                        // generic
    host_avail: s.host_memory?.available_pct ?? null,     // generic — host mem % (OOM watch)
    ram,
  };
  ring.push(rec);
  while (ring.length > MAX) ring.shift();
  try { appendFileSync(FILE, JSON.stringify(rec) + '\n'); } catch { /* ignore */ }
  if (++appendsSinceCompact >= 200) compact();
  return a;
}

let timer = null;
export function startSampler(intervalMs = INTERVAL_MS, onSample) {
  ensureLoaded();
  const run = () => sample().then((a) => onSample?.(a)).catch(() => {});
  run();                                    // immediate first sample
  if (timer) clearInterval(timer);
  timer = setInterval(run, intervalMs);
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
  const ffi = last.cm != null;
  const ages = recs.map((r) => r.age).filter((x) => x != null);
  return {
    window_minutes: windowMinutes,
    span_minutes: +spanMin.toFixed(1),
    samples: recs.length,
    current_verdict: last.verdict,
    verdict_flips: flips,
    // generic (every node)
    ledger_age_secs: ages.length ? { min: Math.min(...ages), max: Math.max(...ages), last: last.age } : null,
    rippled_state: { from: first.state, to: last.state, changed: first.state !== last.state },
    peers: { from: first.peers, to: last.peers },
    host_memory_pct: (() => { const v = recs.map((r) => r.host_avail).filter((x) => x != null); return v.length ? { from: first.host_avail, to: last.host_avail, delta: +((last.host_avail ?? 0) - (first.host_avail ?? 0)).toFixed(1), note: 'host available-memory %; a sustained drop is an OOM/halt early signal' } : null; })(),
    // FFI tier (only when the custom API is present)
    match_streak: ffi ? { from: first.cm, to: last.cm, delta: (last.cm ?? 0) - (first.cm ?? 0), per_min: perMin(first.cm, last.cm), stalled: (last.cm ?? 0) - (first.cm ?? 0) === 0 } : null,
    new_mismatches: ffi ? (last.mm ?? 0) - (first.mm ?? 0) : null,
    new_divergences: ffi ? (last.div ?? 0) - (first.div ?? 0) : null,   // rate-of-divergence (not cumulative)
    divergences_per_min: ffi ? perMin(first.div, last.div) : null,
    miss_rate: ffi ? { from: first.miss, to: last.miss, direction: last.miss > first.miss ? 'rising' : last.miss < first.miss ? 'falling' : 'flat' } : null,
    ledger_lag: lags.length ? { min: Math.min(...lags), max: Math.max(...lags), last: last.lag } : null,
    validator_ram_gb: rams.length ? { from: first.ram, to: last.ram, delta: +((last.ram ?? 0) - (first.ram ?? 0)).toFixed(2), per_min: perMin(first.ram, last.ram), note: 'validator-process RAM; a sustained climb = memory pressure worth watching' } : null,
  };
}
