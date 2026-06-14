// READ-ONLY tool layer for the validator ops copilot.
//
// HARD INVARIANT: every function here only READS. Nothing in this file (or
// reachable from it) can restart, wipe, resync, sign, or mutate the node in any
// way. That invariant is what makes the copilot safe to point at production.

import { readFile } from 'node:fs/promises';
import { config } from './config.mjs';
import { assess } from './assess.mjs';

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function rippledInfo() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(config.rippledRpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'server_info', params: [{}] }),
      signal: ctrl.signal,
    });
    const j = await res.json();
    const info = j?.result?.info || {};
    return {
      server_state: info.server_state,
      complete_ledgers: info.complete_ledgers,
      validated_seq: info.validated_ledger?.seq,
      peers: info.peers,
      uptime: info.uptime,
    };
  } catch (e) {
    return { unreachable: true, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

/** Fetch every live signal in parallel and return the merged raw bundle. */
export async function readAll() {
  const errors = [];
  const grab = async (path, key) => {
    try { return await getJson(`${config.apiBase}${path}`); }
    catch (e) { errors.push(`${key}: ${e?.message || e}`); return null; }
  };
  const [engine, consensus, stateHash, peersRaw, rippled] = await Promise.all([
    grab('/api/engine', 'engine'),
    grab('/api/consensus', 'consensus'),
    grab('/api/state-hash', 'state-hash'),
    grab('/api/peers', 'peers'),
    rippledInfo(),
  ]);
  const peers = peersRaw?.connected ?? peersRaw?.peers ?? null;
  return { engine, consensus, stateHash, peers, rippled, errors };
}

async function nodeResources() {
  try { return await getJson(`${config.metricsBase}/metrics`); }
  catch (e) { return { error: String(e?.message || e) }; }
}

async function tailDivergences(n = 10) {
  try {
    const txt = await readFile(config.divergencesLog, 'utf8');
    const lines = txt.trimEnd().split('\n').filter(Boolean);
    const last = lines.slice(-Math.max(1, Math.min(n, 100)));
    return {
      total_lines: lines.length,
      note: 'This file is a historical SAMPLE log, not the live divergence signal. The live signal is the FFI counters in get_health_summary / get_engine_detail. Do not infer current divergence from this file alone.',
      samples: last.map((l) => { try { return JSON.parse(l); } catch { return l; } }),
    };
  } catch (e) {
    return { error: String(e?.message || e), note: 'no divergence sample log found' };
  }
}

// --- Runbooks: load an SOP before recommending a procedure ------------------
const RUNBOOKS = {
  'health-check': 'health-check.md',
  'drift-recovery': 'drift-recovery.md',
  'upgrade': 'upgrade.md',
  'spin-up': 'spin-up.md',
};

async function getRunbook(name) {
  const file = RUNBOOKS[name];
  if (!file) return { error: `unknown runbook '${name}'`, available: Object.keys(RUNBOOKS) };
  try {
    const url = new URL(`./runbooks/${file}`, import.meta.url);
    return { name, content: await readFile(url, 'utf8') };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// --- Tool schema exposed to the Anthropic API (all read-only) ---------------
export const toolDefs = [
  {
    name: 'get_health_summary',
    description:
      'Primary tool. Reads all live signals and returns the DETERMINISTIC health verdict (.verdict: HEALTHY|WATCH|SYNCING|DEGRADED|HALT_SUSPECTED|UNREACHABLE) plus per-signal breakdown. Always call this before making any claim about whether the validator is healthy. Report .verdict and .one_liner verbatim.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_trend',
    description:
      'Time-series view over a recent window (default 60 min) from sampled history: new divergences IN the window (not cumulative-since-start), match-streak growth/stall, miss-rate direction, ledger-lag range, rippled state changes, validator RAM slope, and any verdict flips. Use this for any question about CHANGE — "is X growing/climbing", "what changed", "when did it start" — because the raw engine/FFI counters are cumulative and cannot express a rate.',
    input_schema: { type: 'object', properties: { windowMinutes: { type: 'integer', description: 'lookback window in minutes (default 60)' } }, additionalProperties: false },
  },
  {
    name: 'get_engine_detail',
    description: 'Raw /api/engine payload: ledger_seq, sig counts, and the full ffi_verifier (shadow-hash match/mismatch, db_hits vs db_rpc_fallbacks = state.rocks misses, apply/silent/mutation divergence counters, per-type breakdowns). Use when the operator wants specifics behind a signal.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_state_hash_detail',
    description: 'Raw /api/state-hash: computed vs network hash, consecutive/total matches & mismatches, ready_to_sign, the signing-gate skip counters, and bulk_sync progress. Use for sync/signing questions.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_rippled_status',
    description: 'Local rippled (source node) server_info: server_state, complete_ledgers, validated seq, peers. This is the sync source whose health gates the validator (its OOM caused the 2026-05-30 halt).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_node_resources',
    description: 'Host CPU/RAM/disk/net for the validator machine (m3060) from the metrics sidecar.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tail_divergences',
    description: 'Last N entries from the historical divergence sample log. SAMPLE/context only — not the live divergence signal.',
    input_schema: { type: 'object', properties: { n: { type: 'integer', description: 'how many entries (default 10, max 100)' } }, additionalProperties: false },
  },
  {
    name: 'get_runbook',
    description: "Load an operator SOP BEFORE recommending any procedure. Names: 'health-check', 'drift-recovery', 'upgrade', 'spin-up'. Base recovery steps on the runbook text; never improvise destructive steps.",
    input_schema: { type: 'object', properties: { name: { type: 'string', enum: Object.keys(RUNBOOKS) } }, required: ['name'], additionalProperties: false },
  },
];

/** Dispatch a tool call by name. Returns a JSON-serialisable result. */
export async function runTool(name, input = {}) {
  switch (name) {
    case 'get_health_summary': return assess(await readAll());
    case 'get_trend': { const { getTrend } = await import('./trend.mjs'); return getTrend(input.windowMinutes ?? 60); }
    case 'get_engine_detail': { const r = await readAll(); return r.engine ?? { error: 'engine unreachable', read_errors: r.errors }; }
    case 'get_state_hash_detail': { const r = await readAll(); return r.stateHash ?? { error: 'state-hash unreachable', read_errors: r.errors }; }
    case 'get_rippled_status': return rippledInfo();
    case 'get_node_resources': return nodeResources();
    case 'tail_divergences': return tailDivergences(input.n ?? 10);
    case 'get_runbook': return getRunbook(input.name);
    default: return { error: `unknown tool '${name}'` };
  }
}
