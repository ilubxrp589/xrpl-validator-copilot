// Phase 2b — live validation-stream monitor.
//
// Opens ONE persistent WebSocket to the node's `validations` stream and keeps a
// small rolling window of per-ledger observations, so COP can answer:
//   • network  — how many distinct validators are we hearing from each ledger
//                (consensus visibility from this node's vantage), vs quorum
//   • reliability (only if THIS node is a validator) — are WE issuing a validation
//                every ledger, is it `full`, and does our ledger_hash AGREE with the
//                network's modal hash (disagreement = fork / amendment-gap risk)
//
// Read-only and best-effort: if the WS can't connect it just reports
// available:false and nothing else in COP is affected. Bounded memory (small ring),
// auto-reconnect with backoff, unref'd timers. A node identifies its OWN validations
// by master_key / validation_public_key matching its configured validator key.

import { config } from './config.mjs';

const WINDOW = 64;     // finalized ledgers retained for rate stats
const LIVE_CAP = 24;   // max in-flight (unfinalized) ledger_index entries
const SETTLE = 3;      // a ledger_index is finalized once we're >= this many ahead
                       // (gives slow stragglers time so the per-ledger count is complete)
const EDGE_TOL = 256;  // ignore validations this far below the live edge — the stream
                       // also carries stray/foreign validations (e.g. forks or other
                       // networks reusing network_id 0) tens of millions of ledgers
                       // back; counting those 1-validator ledgers would halve the avg.

const live = new Map();        // ledger_index -> { keys:Set, hashes:Map<hash,count>, our:{hash,full}|null }
const finalized = [];          // ring of { idx, validators, our_validated, our_full, agreed }
let ourKeys = new Set();       // our validator master/ephemeral keys (from server_info)
let started = false, maxIdx = 0, backoff = 1000, connectIdx = null;
const state = { connected: false, since: 0, lastMsgTs: 0, seen: 0, note: 'not started' };

/** Tell the monitor which validator key(s) are "ours" so it can tag our validations. */
export function setOurValidatorKeys(keys) {
  ourKeys = new Set((keys || []).filter((k) => k && k !== 'none'));
}

function wsUrl() {
  if (config.rippledWs === 'off') return '';
  if (config.rippledWs) return config.rippledWs;
  try {
    const u = new URL(config.rippledRpc);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = u.port === '5005' ? '6006' : (u.port || (proto === 'wss:' ? '443' : '80'));
    return `${proto}//${u.hostname}:${port}`;
  } catch { return ''; }
}

function finalize(idx) {
  const e = live.get(idx);
  live.delete(idx);
  if (!e) return;
  if (connectIdx !== null && idx <= connectIdx) return;   // ledger was already in flight when we subscribed — partial, don't count
  let modal = null, modalN = -1;
  for (const [h, n] of e.hashes) if (n > modalN) { modal = h; modalN = n; }
  finalized.push({ idx, validators: e.keys.size, our_validated: !!e.our, our_full: e.our?.full ?? null, agreed: e.our ? e.our.hash === modal : null });
  while (finalized.length > WINDOW) finalized.shift();
}

function onValidation(m) {
  const idx = Number(m.ledger_index);
  if (!Number.isFinite(idx)) return;
  // Track the live edge. On a big forward jump (cold start or a real edge after some
  // foreign noise), DROP now-stale live entries without finalizing them — they're
  // foreign/partial, not real ledgers we observed fully.
  if (idx > maxIdx) {
    if (maxIdx && idx - maxIdx > EDGE_TOL) for (const k of [...live.keys()]) if (k < idx - EDGE_TOL) live.delete(k);
    maxIdx = idx;
  }
  if (idx < maxIdx - EDGE_TOL) return;          // foreign / stale-replay validation — ignore
  if (connectIdx === null) connectIdx = maxIdx; // first real ledger seen; it's partial → skip it on finalize
  state.seen++; state.lastMsgTs = Date.now();
  let e = live.get(idx);
  if (!e) { e = { keys: new Set(), hashes: new Map(), our: null }; live.set(idx, e); }
  const id = m.master_key || m.validation_public_key;        // count distinct validators by permanent identity
  if (id) e.keys.add(id);
  if (m.ledger_hash) e.hashes.set(m.ledger_hash, (e.hashes.get(m.ledger_hash) || 0) + 1);
  if ((m.master_key && ourKeys.has(m.master_key)) || (m.validation_public_key && ourKeys.has(m.validation_public_key))) {
    e.our = { hash: m.ledger_hash, full: m.full !== false };
  }
  for (const k of [...live.keys()]) if (k <= maxIdx - SETTLE) finalize(k);
  while (live.size > LIVE_CAP) finalize(Math.min(...live.keys()));
}

function connect() {
  const url = wsUrl();
  if (!url) { state.note = "no WS url (set rippledWs, or 'off' to disable)"; return; }
  let sock;
  try { sock = new WebSocket(url); } catch (e) { state.note = `ws construct failed: ${e?.message || e}`; return schedule(); }
  sock.onopen = () => { backoff = 1000; connectIdx = null; state.connected = true; state.since = Date.now(); state.note = `connected ${url}`; sock.send(JSON.stringify({ command: 'subscribe', streams: ['validations'] })); };
  sock.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.type === 'validationReceived') onValidation(m); } catch { /* ignore */ } };
  sock.onerror = () => { state.note = `ws error (${url})`; };
  sock.onclose = () => { state.connected = false; if (started) schedule(); };
}

function schedule() {
  backoff = Math.min(backoff * 2, 30_000);
  setTimeout(() => { if (started) connect(); }, backoff).unref?.();
}

export function startValidationMonitor() {
  if (started) return;
  started = true;
  connect();
}

/** Read-only snapshot of the rolling validation window (raw numbers; assess() grades it). */
export function validationSnapshot() {
  const n = finalized.length;
  if (!state.connected && n === 0) return { available: false, connected: false, note: state.note };
  const avg = (arr) => (arr.length ? +(arr.reduce((s, r) => s + r.validators, 0) / arr.length).toFixed(1) : null);
  const recent = finalized.slice(-10);
  const isValidator = ourKeys.size > 0;
  let reliability = null;
  if (isValidator && n) {
    const issued = finalized.filter((r) => r.our_validated).length;
    const agreed = finalized.filter((r) => r.our_validated && r.agreed).length;
    reliability = {
      window_ledgers: n,
      issued,
      reliability_pct: +(100 * issued / n).toFixed(1),
      agreement_pct: issued ? +(100 * agreed / issued).toFixed(1) : null,
      recent_issued: recent.filter((r) => r.our_validated).length,
      recent_window: recent.length,
    };
  }
  return {
    available: true,
    connected: state.connected,
    window_ledgers: n,
    validations_seen: state.seen,
    network: { avg_validators_per_ledger: avg(finalized), recent_avg: avg(recent) },
    is_validator: isValidator,
    reliability,
    note: isValidator ? undefined : 'this node has no validator key — network observation only (not issuing validations)',
  };
}
