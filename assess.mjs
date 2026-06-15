// Deterministic health assessment — TWO TIERS.
//
//   • Generic core — works on ANY rippled/xrpld validator using only standard
//     JSON-RPC (server_info). Every XRPL validator exposes this, so this tier
//     runs for everyone: server_state, amendment-blocked, ledger currency,
//     history gaps, peers, load, consensus, validating.
//   • FFI enhancement — if the node ALSO exposes a custom validator API with an
//     FFI shadow-verifier (state-hash matches, apply/shadow divergence, state.rocks),
//     those deeper correctness signals are layered on top. Absent on a stock node;
//     the generic core stands on its own.
//
// The overall verdict and every per-signal status are computed HERE, in code,
// from the raw numbers — the LLM reports them, it does not invent or soften them.

import { config } from './config.mjs';

const T = config.thresholds;
const sev = (s) => ({ ok: 0, syncing: 1, unknown: 1, watch: 2, degraded: 3 }[s] ?? 1);
const HEALTHY_STATES = ['full', 'proposing', 'validating'];
const SYNC_STATES = ['syncing', 'connected', 'tracking'];

// --- Generic tier: standard rippled signals (works on any node) ------------
function genericSignals(r) {
  const s = {};
  if (!r || r.unreachable) {
    s.node = { status: 'degraded', detail: `rippled RPC unreachable${r?.error ? ` (${r.error})` : ''}` };
    return s;
  }
  const st = r.server_state;
  s.server_state = {
    status: HEALTHY_STATES.includes(st) ? 'ok' : SYNC_STATES.includes(st) ? 'syncing' : 'degraded',
    detail: `server_state=${st}${HEALTHY_STATES.includes(st) ? '' : SYNC_STATES.includes(st) ? ' (catching up)' : ' (unhealthy)'} · rippled ${r.build_version ?? '?'}`,
    server_state: st,
  };
  // amendments signal is computed in assess() — it also needs the `feature` pipeline data.
  if (r.validated_seq == null) {
    s.ledger = { status: 'degraded', detail: 'no validated ledger — not following the network' };
  } else {
    const a = r.validated_age ?? 0;
    s.ledger = {
      status: a <= 10 ? 'ok' : a <= 60 ? 'watch' : 'degraded',
      detail: `last validated ledger ${a}s ago (seq ${r.validated_seq})${a > 10 ? ' — falling behind' : ''}`,
      age: a, seq: r.validated_seq,
    };
  }
  s.history = completeLedgers(r.complete_ledgers);
  const p = r.peers ?? 0;
  s.peers = { status: p >= 5 ? 'ok' : p >= 1 ? 'watch' : 'degraded', detail: `${p} peer(s)`, peers: p };
  const lf = r.load_factor ?? 1;
  s.load = { status: lf <= 1 ? 'ok' : lf <= 10 ? 'watch' : 'degraded', detail: `load_factor=${lf}${lf > 1 ? ' (under load)' : ''}`, load_factor: lf };
  if (r.last_close) {
    s.consensus = { status: 'ok', informational: true, detail: `last close: ${r.last_close.proposers} proposers, converged ${r.last_close.converge_time_s}s; quorum ${r.validation_quorum ?? '?'}` };
  }
  const isVal = r.pubkey_validator && r.pubkey_validator !== 'none';
  s.validating = {
    status: 'ok', informational: true,
    detail: isVal ? (st === 'proposing' ? 'configured validator, actively proposing' : `validator key set, server_state=${st}`) : 'not a validator (full/tracking node)',
    is_validator: !!isVal,
  };
  return s;
}

function completeLedgers(cl) {
  if (!cl || cl === 'empty') return { status: 'degraded', detail: 'no ledger history (empty) — still acquiring' };
  const ranges = String(cl).split(',');
  if (ranges.length > 1) return { status: 'watch', detail: `ledger history has gaps (${ranges.length} ranges)` };
  return { status: 'ok', detail: `contiguous ledger history (${cl})` };
}

// --- FFI tier: custom shadow-verifier signals (only when the API is present) -
function ffiSignals(ffi, rippled) {
  const s = {};
  const { engine, stateHash } = ffi;
  const bulk = stateHash?.bulk_sync || {};
  const syncing = !!bulk.running;

  if (stateHash) {
    const mm = stateHash.total_mismatches ?? 0, cm = stateHash.consecutive_matches ?? 0, ready = !!stateHash.ready_to_sign;
    if (syncing) s.state_integrity = { status: 'syncing', detail: `bulk_sync running (${bulk.objects_synced ?? 0} objs); mismatch checks paused`, consecutive_matches: cm, total_mismatches: mm };
    else if (mm > 0 && cm < 3) s.state_integrity = { status: 'degraded', detail: `recent state-hash mismatch broke the streak (consecutive=${cm}, total=${mm}), not syncing — possible halt; diagnose the source node first`, consecutive_matches: cm, total_mismatches: mm, halt_suspected: true };
    else if (mm > 0) s.state_integrity = { status: 'watch', detail: `${mm} historical mismatch(es), currently matching (consecutive=${cm})`, consecutive_matches: cm, total_mismatches: mm };
    else if (!ready) s.state_integrity = { status: 'watch', detail: `0 mismatches but ready_to_sign=false (consecutive=${cm}, need ≥3)`, consecutive_matches: cm, total_mismatches: mm };
    else s.state_integrity = { status: 'ok', detail: `${cm.toLocaleString()} consecutive state-hash matches, 0 mismatches, ready_to_sign`, consecutive_matches: cm, total_mismatches: mm };

    if (syncing) s.sync = { status: 'syncing', detail: `bulk_sync: ${bulk.objects_synced ?? 0} objs @ ${Math.round(bulk.rate ?? 0)}/s`, ...bulk };
    else if (bulk.verified === false) s.sync = { status: 'watch', detail: 'last bulk_sync did NOT verify' };
    else s.sync = { status: 'ok', detail: 'steady state (last sync verified)' };
  }

  const v = engine?.ffi_verifier;
  const ours = v?.round_ledger_seq || engine?.ledger_seq;
  const edge = rippled?.validated_seq;
  if (ours && edge) {
    const lag = edge - ours;
    s.ffi_lag = {
      status: syncing ? 'syncing' : lag >= T.ledgerLagDegraded ? 'degraded' : lag >= T.ledgerLagWatch ? 'watch' : 'ok',
      detail: lag <= 0 ? `FFI engine at the network edge (round ${ours})` : `FFI engine ${lag} ledger(s) behind edge`,
      lag,
    };
  }
  if (v) {
    const tot = (v.live_apply_diverged ?? 0) + (v.live_apply_silent_diverged ?? 0) + (v.live_apply_mutation_diverged ?? 0) + (v.shadow_hash_mismatched ?? 0);
    s.divergences = {
      status: tot === 0 ? 'ok' : 'watch',
      detail: tot === 0 ? 'no divergences (apply + shadow-hash clean since start)' : `cumulative divergences: ${tot} — use get_trend to see if still growing`,
      live_apply_diverged: v.live_apply_diverged ?? 0, silent: v.live_apply_silent_diverged ?? 0, mutation: v.live_apply_mutation_diverged ?? 0, shadow_hash_mismatched: v.shadow_hash_mismatched ?? 0,
    };
    const hits = v.db_hits ?? 0, miss = v.db_rpc_fallbacks ?? 0, tr = hits + miss;
    if (tr > 0) {
      const rate = miss / tr;
      s.state_rocks = { status: rate >= T.missRateDegraded ? 'degraded' : rate >= T.missRateWatch ? 'watch' : 'ok', detail: `state.rocks miss rate ${(rate * 100).toFixed(3)}% — efficiency metric (trend matters more than absolute)`, miss_rate: rate };
    }
  }
  return s;
}

// Amendment health: reactive (amendment_blocked) + predictive (unsupported amendments
// from the `feature` pipeline). Active-unsupported = blocked now; approaching/future =
// upgrade-before-it-bites warnings.
function amendmentSignal(r, am) {
  if (r?.amendment_blocked) return { status: 'degraded', detail: 'AMENDMENT-BLOCKED — out of consensus until upgraded', blocked: true };
  if (am?.available) {
    const unsup = am.unsupported || [];
    const active = unsup.filter((a) => a.enabled);
    const approaching = unsup.filter((a) => !a.enabled && a.majority);
    const future = unsup.filter((a) => !a.enabled && !a.majority);
    if (active.length) return { status: 'degraded', detail: `does NOT support ${active.length} ACTIVE amendment(s): ${active.map((a) => a.name).join(', ')} — upgrade now`, blocked: true };
    if (approaching.length) return { status: 'watch', detail: `amendment(s) with majority this node does NOT support: ${approaching.map((a) => a.name).join(', ')} — activates ~2 weeks after majority; upgrade before then or be blocked` };
    if (future.length) return { status: 'watch', detail: `does not yet support ${future.length} amendment(s): ${future.map((a) => a.name).join(', ')} — no majority yet; upgrade to stay safe` };
    return { status: 'ok', detail: `not amendment-blocked; supports all ${am.total} known amendments` };
  }
  return { status: 'ok', detail: 'not amendment-blocked' };
}

// Validator-list / UNL health. An expired or non-refreshing trusted list quietly
// drops a node out of consensus (it loses its trusted set). Generic — any node that
// follows consensus has a UNL. Omitted entirely when the admin RPC isn't available,
// so a public/stock RPC node isn't gated on a reading it can't take.
function validatorListSignal(v) {
  if (!v?.available) return null;
  const tk = v.trusted_keys ?? 0;
  const soon = v.soonest_days;
  const exp = v.soonest_expiry ? String(v.soonest_expiry).split(' ')[0] : null;   // date only, drop time/nanos
  if (tk === 0) return { status: 'degraded', detail: 'no trusted validator keys — node cannot follow consensus (UNL empty or unreachable)' };
  if (soon != null && soon < 0) return { status: 'degraded', detail: `validator list EXPIRED ${Math.abs(soon)}d ago — node has lost its trusted set; restore publisher-list reachability`, soonest_days: soon };
  if (v.any_list_unavailable) return { status: 'watch', detail: `a validator list is unavailable (not refreshing) — ${tk} trusted keys, quorum ${v.validation_quorum ?? '?'}; check publisher reachability` };
  if (soon != null && soon < 3) return { status: 'watch', detail: `validator list expires in ${soon}d (${exp}) — should auto-refresh; flag if it doesn't`, soonest_days: soon };
  return { status: 'ok', detail: `${v.publisher_lists?.length ?? 0} validator list(s), ${tk} trusted keys, quorum ${v.validation_quorum ?? '?'}; soonest expiry ${soon != null ? `${soon}d (${exp})` : 'n/a'}`, soonest_days: soon };
}

// Live validation reliability (from the validations-stream monitor). For a validator:
// are we issuing full validations and agreeing with the network? For a non-validator:
// network participation observation only (informational). Omitted until the monitor
// has a window. `warming up` avoids false alarms before the window fills.
function validationSignal(snap, rippled, vals) {
  if (!snap?.available) return null;
  const quorum = vals?.validation_quorum ?? rippled?.validation_quorum ?? null;
  const netRecent = snap.network?.recent_avg ?? snap.network?.avg_validators_per_ledger ?? null;
  const netStr = `~${netRecent ?? '?'} validators/ledger${quorum ? ` (quorum ${quorum})` : ''} over ${snap.window_ledgers} ledger(s)`;

  if (snap.is_validator && snap.reliability) {
    const r = snap.reliability;
    if (r.window_ledgers < 8) return { status: 'ok', detail: `validation monitor warming up (${r.window_ledgers} ledger(s) observed)`, ...r };
    if (r.recent_window > 0 && r.recent_issued === 0) return { status: 'degraded', detail: `configured validator but issued NO validations in the last ${r.recent_window} ledgers — check server_state=proposing and the validator key`, ...r };
    if (r.agreement_pct != null && r.agreement_pct < 100) return { status: 'degraded', detail: `our validations DISAGREE with the network on ${(100 - r.agreement_pct).toFixed(1)}% of ledgers (agreement ${r.agreement_pct}%) — possible fork / amendment gap`, ...r };
    if (r.reliability_pct < 90) return { status: 'watch', detail: `issuing validations on only ${r.reliability_pct}% of ledgers (${r.issued}/${r.window_ledgers}) — missing some`, ...r };
    return { status: 'ok', detail: `issuing full validations · reliability ${r.reliability_pct}% · agreement ${r.agreement_pct ?? 100}% over ${r.window_ledgers} ledgers`, ...r };
  }
  // non-validator: observe consensus visibility only (never gates the verdict)
  const low = quorum && netRecent != null && netRecent < quorum;
  return { status: low ? 'watch' : 'ok', informational: true, detail: `observing ${netStr} — consensus visibility${low ? ' BELOW quorum (low visibility)' : ' healthy'} (this node isn't a validator)` };
}

// Host memory of the box the copilot (ideally the node too) runs on. Low available
// memory is an OOM precursor, and OOM on a node's host causes incomplete data → halt.
function hostMemorySignal(h) {
  if (!h?.available) return null;
  const pct = h.available_pct, gb = h.available_gb;
  const status = (pct < 7 || gb < 1.5) ? 'degraded' : pct < 15 ? 'watch' : 'ok';
  const swap = h.swap_total_gb ? `, swap ${h.swap_used_gb}/${h.swap_total_gb}GB` : '';
  return {
    status,
    detail: `host memory ${gb}GB available (${pct}% of ${h.total_gb}GB)${swap}, load ${h.load1 ?? '?'}/${h.cores}c${status !== 'ok' ? ' — LOW: OOM/halt risk' : ''}`,
    available_pct: pct, available_gb: gb,
  };
}

/** @param bundle { rippled, amendments, host, ffi:{engine,stateHash,consensus,peers}|null, ffiAvailable, errors } */
export function assess(bundle) {
  const { rippled, ffi, ffiAvailable, errors = [] } = bundle;
  const signals = { ...genericSignals(rippled) };
  signals.amendments = amendmentSignal(rippled, bundle.amendments);
  const vList = validatorListSignal(bundle.validators);
  if (vList) signals.validator_list = vList;
  const vSig = validationSignal(bundle.validations, rippled, bundle.validators);
  if (vSig) signals.validation = vSig;
  const hostMem = hostMemorySignal(bundle.host);
  if (hostMem) signals.host_memory = hostMem;
  if (ffiAvailable && ffi) Object.assign(signals, ffiSignals(ffi, rippled));

  const gating = Object.entries(signals).filter(([, x]) => !x.informational);
  const worst = gating.reduce((m, [, x]) => Math.max(m, sev(x.status)), 0);
  const anySync = gating.some(([, x]) => x.status === 'syncing');
  const haltSuspected = !!signals.state_integrity?.halt_suspected;
  const blocked = !!signals.amendments?.blocked;

  let verdict;
  if (signals.node?.status === 'degraded') verdict = 'UNREACHABLE';
  else if (haltSuspected) verdict = 'HALT_SUSPECTED';
  else if (blocked) verdict = 'AMENDMENT_BLOCKED';
  else if (worst >= 3) verdict = 'DEGRADED';
  else if (anySync) verdict = 'SYNCING';
  else if (worst === 2) verdict = 'WATCH';
  else verdict = 'HEALTHY';

  const triggers = gating.filter(([, x]) => sev(x.status) >= 2).map(([k, x]) => `${k}:${x.status}`);
  return {
    verdict,
    tier: ffiAvailable ? 'generic+ffi' : 'generic',
    halt_suspected: haltSuspected,
    one_liner: oneLiner(verdict, signals, triggers, ffiAvailable),
    triggers,
    signals,
    read_errors: errors,
    note: 'Verdict computed deterministically from live signals. Report it verbatim; do not soften.',
  };
}

function oneLiner(verdict, s, triggers, ffi) {
  if (verdict === 'HEALTHY') {
    if (ffi && s.state_integrity?.consecutive_matches != null) return `HEALTHY — ${s.state_integrity.consecutive_matches.toLocaleString()} consecutive state-hash matches, 0 mismatches, ${s.peers?.peers ?? '?'} peers, all signals green.`;
    return `HEALTHY — server_state=${s.server_state?.server_state}, last ledger ${s.ledger?.age ?? '?'}s ago, ${s.peers?.peers ?? '?'} peers, not amendment-blocked.`;
  }
  if (verdict === 'AMENDMENT_BLOCKED') return 'AMENDMENT_BLOCKED — node is out of consensus; upgrade rippled/xrpld to support the activated amendment(s).';
  if (verdict === 'SYNCING') return `SYNCING — ${s.sync?.detail || s.server_state?.detail || 'catching up'}.`;
  if (verdict === 'UNREACHABLE') return 'UNREACHABLE — could not reach the rippled RPC.';
  return `${verdict} — triggered by: ${triggers.join(', ') || 'see signals'}.`;
}
