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
    const vl = info.validated_ledger || {};
    return {
      server_state: info.server_state,
      amendment_blocked: info.amendment_blocked ?? false,
      complete_ledgers: info.complete_ledgers,
      validated_seq: vl.seq ?? null,
      validated_age: vl.age ?? null,
      validated_hash: vl.hash ?? null,
      peers: info.peers,
      load_factor: info.load_factor,
      validation_quorum: info.validation_quorum,
      pubkey_validator: info.pubkey_validator,
      last_close: info.last_close,
      build_version: info.build_version,
      uptime: info.uptime,
    };
  } catch (e) {
    return { unreachable: true, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// Amendment awareness — read the node's `feature` data (admin RPC), cached ~5 min
// (amendments move over days). Flags amendments this node does NOT support, so COP
// can warn before the node falls out of consensus.
let _amend = null;
async function getAmendments() {
  if (_amend && Date.now() - _amend.ts < 300_000) return _amend.data;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  let data;
  try {
    const res = await fetch(config.rippledRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'feature' }), signal: ctrl.signal });
    const r = (await res.json())?.result;
    if (!r || r.error || !r.features) {
      data = { available: false, note: r?.error ? `feature: ${r.error} (admin RPC required)` : 'no amendment data' };
    } else {
      const all = Object.values(r.features);
      const unsupported = all.filter((a) => a.supported === false).map((a) => ({ name: a.name, enabled: !!a.enabled, majority: a.majority ?? null }));
      data = { available: true, total: all.length, enabled: all.filter((a) => a.enabled).length, supports_all: unsupported.length === 0, unsupported };
    }
  } catch (e) { data = { available: false, note: String(e?.message || e) }; }
  finally { clearTimeout(t); }
  _amend = { data, ts: Date.now() };
  return data;
}

// Operator's local "known-normal + known-issues" notes for THIS node (gitignored).
let _profile = null;
export async function nodeProfile() {
  if (_profile !== null) return _profile;
  try { _profile = (await readFile(new URL('./node-profile.md', import.meta.url), 'utf8')).trim(); }
  catch { _profile = ''; }
  return _profile;
}

/**
 * Read both tiers. The generic core (rippled server_info) ALWAYS runs. The FFI
 * tier is fetched only when config.apiBase is set AND its /api/engine responds —
 * so a stock validator gets the core, and a node with the custom FFI API gets both.
 * @returns { rippled, ffi:{engine,consensus,stateHash,peers}|null, ffiAvailable, errors }
 */
export async function readAll() {
  const errors = [];
  const [rippled, amendments] = await Promise.all([rippledInfo(), getAmendments()]);

  let ffi = null, ffiAvailable = false;
  if (config.apiBase) {
    const grab = async (path, key) => {
      try { return await getJson(`${config.apiBase}${path}`); }
      catch (e) { errors.push(`${key}: ${e?.message || e}`); return null; }
    };
    const [engine, consensus, stateHash, peersRaw] = await Promise.all([
      grab('/api/engine', 'engine'),
      grab('/api/consensus', 'consensus'),
      grab('/api/state-hash', 'state-hash'),
      grab('/api/peers', 'peers'),
    ]);
    if (engine || stateHash) {
      ffiAvailable = true;
      ffi = { engine, consensus, stateHash, peers: peersRaw?.connected ?? peersRaw?.peers ?? null };
    }
  }
  return { rippled, amendments, ffi, ffiAvailable, errors };
}

async function nodeResources() {
  if (!config.metricsBase) return { error: 'no metrics sidecar configured' };
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

// --- Divergence forensics (Phase 3, FFI nodes only) ------------------------
async function rippledTx(hash) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.fetchTimeoutMs);
  try {
    const res = await fetch(config.rippledRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'tx', params: [{ transaction: hash, binary: false }] }), signal: ctrl.signal });
    const r = (await res.json())?.result;
    if (!r || r.error) return { found: false, error: r?.error || 'no result', note: r?.error === 'txnNotFound' ? 'not found — likely older than this node retains' : undefined };
    return { found: true, tx_type: r.TransactionType, account: r.Account, ledger_index: r.ledger_index, network_result: r.meta?.TransactionResult, validated: r.validated };
  } catch (e) { return { found: false, error: String(e?.message || e) }; }
  finally { clearTimeout(t); }
}

let _logSummary = null;
async function divergenceLogSummary() {
  if (_logSummary) return _logSummary;
  try {
    const lines = (await readFile(config.divergencesLog, 'utf8')).trimEnd().split('\n').filter(Boolean);
    const byType = {}, byTer = {}; let lo = Infinity, hi = -Infinity; const samples = [];
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        byType[o.tx_type] = (byType[o.tx_type] || 0) + 1;
        byTer[o.our_ter] = (byTer[o.our_ter] || 0) + 1;
        if (o.ledger_seq) { lo = Math.min(lo, o.ledger_seq); hi = Math.max(hi, o.ledger_seq); }
        if (samples.length < 5) samples.push({ tx_hash: o.tx_hash, tx_type: o.tx_type, our_ter: o.our_ter, ledger_seq: o.ledger_seq });
      } catch { /* skip */ }
    }
    _logSummary = { total: lines.length, by_tx_type: byType, by_our_ter: byTer, ledger_range: lo === Infinity ? null : [lo, hi], samples, note: 'historical sample log — these txs are likely older than the local rippled retains, so per-tx network lookup may return not-found' };
    return _logSummary;
  } catch (e) { return { error: String(e?.message || e), note: 'no divergence log configured' }; }
}

async function findInLog(hash) {
  try {
    for (const l of (await readFile(config.divergencesLog, 'utf8')).split('\n')) {
      if (l.includes(hash)) { try { return JSON.parse(l); } catch { /* */ } }
    }
  } catch { /* */ }
  return null;
}

const hashOf = (s) => (typeof s === 'string' ? (s.match(/[0-9A-Fa-f]{64}/)?.[0] || s) : null);

/** Live divergence counts/maps (from FFI) + historical log summary. */
export async function divergenceBreakdownFrom(raw) {
  const v = raw?.ffi?.engine?.ffi_verifier;
  if (!v) return { ffiAvailable: false, note: 'divergence forensics require the custom FFI validator API (absent on a stock node)' };
  return {
    ffiAvailable: true,
    live: {
      apply_diverged: v.live_apply_diverged ?? 0,
      silent_diverged: v.live_apply_silent_diverged ?? 0,
      mutation_diverged: v.live_apply_mutation_diverged ?? 0,
      shadow_hash_mismatched: v.shadow_hash_mismatched ?? 0,
      by_type: v.live_diverged_by_type || {},
      mutation_by_type: v.mutation_diverged_by_type || {},
      silent_by_pair: v.silent_diverged_by_pair || {},
      samples: [...(v.diverged_tx_samples || []), ...(v.mutation_diverged_samples || []), ...(v.silent_diverged_samples || [])].slice(0, 10),
    },
    historical: await divergenceLogSummary(),
  };
}

async function explainDivergence(txHash) {
  const raw = await readAll();
  const v = raw?.ffi?.engine?.ffi_verifier;
  if (!v) return { error: 'FFI not available — divergence forensics need the custom validator API' };
  let hash = txHash, meta = null;
  if (!hash) {
    const live = [...(v.diverged_tx_samples || []), ...(v.mutation_diverged_samples || []), ...(v.silent_diverged_samples || [])];
    if (live.length) hash = hashOf(live[0]);
    else { const s = await divergenceLogSummary(); meta = s.samples?.[0] || null; hash = meta?.tx_hash; }
  }
  if (!hash) return { note: 'no divergences to explain (live counters 0 and no log samples)' };
  if (!meta) meta = await findInLog(hash);
  return { tx_hash: hash, divergence_meta: meta, network_lookup: await rippledTx(hash), hint: 'Explain WHY the engine diverged: compare our_ter to the network result, and what the tx type/class implies.' };
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
      'Primary tool. Reads all live signals and returns the DETERMINISTIC verdict (.verdict: HEALTHY|WATCH|SYNCING|DEGRADED|AMENDMENT_BLOCKED|HALT_SUSPECTED|UNREACHABLE), the .tier (generic, or generic+ffi if the node exposes the custom FFI API), and a per-signal breakdown. Always call this before claiming anything about health. Report .verdict and .one_liner verbatim.',
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
    description: 'Standard rippled/xrpld server_info for the node COP is pointed at: server_state, amendment_blocked, complete_ledgers, validated-ledger age, peers, load_factor, validation_quorum, and whether it is a configured validator. The generic-core signal source — works on any XRPL node.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_amendments',
    description: 'Amendment status: total amendments, how many are enabled, and any this node does NOT support (with whether each is already active or approaching). Use for "am I current on amendments / will I get amendment-blocked / what should I upgrade for". Requires admin RPC; returns available:false otherwise.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_node_resources',
    description: 'Host CPU/RAM/disk/net from an optional metrics sidecar (only if one is configured).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tail_divergences',
    description: 'Last N entries from the historical divergence sample log. SAMPLE/context only — not the live divergence signal.',
    input_schema: { type: 'object', properties: { n: { type: 'integer', description: 'how many entries (default 10, max 100)' } }, additionalProperties: false },
  },
  {
    name: 'get_divergence_breakdown',
    description: '(FFI nodes only) The divergence picture: live apply/silent/mutation/shadow-hash counts + by-type / by-pair maps + sample hashes, AND a summary of the historical divergence log (counts by tx_type and by our_ter, ledger range). Use for "what diverges / what diverged / which tx types".',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'explain_divergence',
    description: '(FFI nodes only) Deep-dive one diverged transaction: picks a sample (or the given txHash), pulls its recorded divergence metadata (our_ter, tx_type, ledger), and looks the tx up on the local rippled. Explain why the engine diverged from the network result. Old txs may be beyond node retention (network_lookup.found=false).',
    input_schema: { type: 'object', properties: { txHash: { type: 'string', description: 'optional specific tx hash; omit to auto-pick a sample' } }, additionalProperties: false },
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
    case 'get_engine_detail': { const r = await readAll(); return r.ffi?.engine ?? { error: 'FFI engine API not available on this node (generic-core mode)', read_errors: r.errors }; }
    case 'get_state_hash_detail': { const r = await readAll(); return r.ffi?.stateHash ?? { error: 'FFI state-hash API not available on this node (generic-core mode)', read_errors: r.errors }; }
    case 'get_rippled_status': return rippledInfo();
    case 'get_amendments': return getAmendments();
    case 'get_node_resources': return nodeResources();
    case 'tail_divergences': return tailDivergences(input.n ?? 10);
    case 'get_divergence_breakdown': return divergenceBreakdownFrom(await readAll());
    case 'explain_divergence': return explainDivergence(input.txHash);
    case 'get_runbook': return getRunbook(input.name);
    default: return { error: `unknown tool '${name}'` };
  }
}
