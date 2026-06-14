// Deterministic health assessment over live validator signals.
//
// This is the epistemic core of the copilot: the overall verdict and every
// per-signal status are computed HERE, in code, from the raw numbers. The LLM
// is handed this object and must report it verbatim. It cannot optimistically
// override a red signal — which is exactly the failure mode the operator cares
// about ("validations are happening" is NOT health; the signing gate can stay
// green while state.rocks rots underneath).
//
// Signal statuses: 'ok' | 'watch' | 'degraded' | 'syncing' | 'unknown'.

import { config } from './config.mjs';

const T = config.thresholds;

function sev(status) {
  return { ok: 0, syncing: 1, unknown: 1, watch: 2, degraded: 3 }[status] ?? 1;
}

/**
 * @param {object} raw  { engine, consensus, stateHash, peers, rippled, errors }
 * @returns assessment object with .verdict and .signals
 */
export function assess(raw) {
  const { engine, stateHash, consensus, peers, rippled, errors = [] } = raw;
  const signals = {};

  // Are we mid-sync? Sync suppresses mismatch alarms (early-ledger noise).
  const bulk = stateHash?.bulk_sync || {};
  const syncing = !!bulk.running;

  // --- Signal 1: state-hash integrity (the core correctness signal) ---------
  if (!stateHash) {
    signals.state_integrity = { status: 'unknown', detail: 'no /api/state-hash data' };
  } else {
    const mm = stateHash.total_mismatches ?? 0;
    const cm = stateHash.consecutive_matches ?? 0;
    const ready = !!stateHash.ready_to_sign;
    if (syncing) {
      signals.state_integrity = {
        status: 'syncing',
        detail: `bulk_sync running (${bulk.objects_synced ?? 0} objs); mismatch checks paused`,
        consecutive_matches: cm, total_mismatches: mm,
      };
    } else if (mm > 0 && cm < 3) {
      // A recent mismatch broke the streak and we are NOT syncing → this is the
      // halt-class signature. Flag it hard; do not self-soothe.
      signals.state_integrity = {
        status: 'degraded',
        detail: `recent state-hash mismatch broke the match streak (consecutive=${cm}, total_mismatches=${mm}), not syncing — possible halt; investigate before any action`,
        consecutive_matches: cm, total_mismatches: mm, ready_to_sign: ready,
        halt_suspected: true,
      };
    } else if (mm > 0) {
      signals.state_integrity = {
        status: 'watch',
        detail: `${mm} historical mismatch(es) but currently matching (consecutive=${cm})`,
        consecutive_matches: cm, total_mismatches: mm, ready_to_sign: ready,
      };
    } else if (!ready) {
      signals.state_integrity = {
        status: 'watch',
        detail: `0 mismatches but ready_to_sign=false (consecutive=${cm}, need ≥3)`,
        consecutive_matches: cm, total_mismatches: mm, ready_to_sign: ready,
      };
    } else {
      signals.state_integrity = {
        status: 'ok',
        detail: `${cm.toLocaleString()} consecutive matches, 0 mismatches, ready_to_sign`,
        consecutive_matches: cm, total_mismatches: mm, ready_to_sign: ready,
      };
    }
  }

  // --- Signal 2: sync state --------------------------------------------------
  if (!stateHash) {
    signals.sync = { status: 'unknown', detail: 'no state-hash data' };
  } else if (syncing) {
    const rem = bulk.estimated_remaining_secs;
    signals.sync = {
      status: 'syncing',
      detail: `bulk_sync in progress: ${bulk.objects_synced ?? 0} objs @ ${Math.round(bulk.rate ?? 0)}/s${rem != null ? `, ~${Math.round(rem)}s left` : ''}`,
      ...bulk,
    };
  } else if (bulk.verified === false) {
    signals.sync = { status: 'watch', detail: 'last bulk_sync did NOT verify', ...bulk };
  } else {
    signals.sync = { status: 'ok', detail: 'steady state (no active sync, last sync verified)' };
  }

  // --- Signal 3: ledger lag vs network edge ---------------------------------
  // Use the FFI verifier's round ledger — the live edge-tracking position.
  // The top-level engine.ledger_seq is a different counter that can freeze, so
  // it's the wrong thing to measure lag against.
  const ours = engine?.ffi_verifier?.round_ledger_seq || engine?.ledger_seq || 0;
  const edge = rippled?.validated_seq ?? 0;
  if (!ours || !edge) {
    signals.ledger_lag = { status: 'unknown', detail: 'missing our seq or network edge', ours, edge };
  } else {
    const lag = edge - ours;
    let status = 'ok';
    if (syncing) status = 'syncing';
    else if (lag >= T.ledgerLagDegraded) status = 'degraded';
    else if (lag >= T.ledgerLagWatch) status = 'watch';
    signals.ledger_lag = {
      status,
      detail: lag <= 0
        ? `at the network edge (FFI round ${ours} ≥ local rippled validated ${edge})`
        : `${lag} ledger(s) behind network edge (FFI round=${ours}, edge=${edge}, ~${(lag * 3.5).toFixed(0)}s)`,
      lag, ours, edge,
    };
  }

  // --- Signal 4: FFI divergences (apply identically to the network?) ---------
  const v = engine?.ffi_verifier;
  if (!v) {
    signals.divergences = { status: 'unknown', detail: 'no ffi_verifier data' };
  } else {
    const live = v.live_apply_diverged ?? 0;
    const silent = v.live_apply_silent_diverged ?? 0;
    const mut = v.live_apply_mutation_diverged ?? 0;
    const shadowMm = v.shadow_hash_mismatched ?? 0;
    const total = live + silent + mut + shadowMm;
    // Counters are cumulative since process start, so a nonzero value is not
    // automatically "now" — but post-fix these should all be 0. Treat >0 as
    // WATCH and tell the operator to check whether it is still growing.
    signals.divergences = {
      status: total === 0 ? 'ok' : 'watch',
      detail: total === 0
        ? 'no divergences (apply + shadow-hash clean since start)'
        : `cumulative-since-start: live=${live} silent=${silent} mutation=${mut} shadow_mismatch=${shadowMm} — confirm whether still growing (delta), not just nonzero`,
      live_apply_diverged: live, silent, mutation: mut, shadow_hash_mismatched: shadowMm,
    };
  }

  // --- Signal 5: state.rocks miss rate (the rot the signing gate masks) ------
  if (!v) {
    signals.state_rocks = { status: 'unknown', detail: 'no ffi_verifier data' };
  } else {
    const hits = v.db_hits ?? 0;
    const miss = v.db_rpc_fallbacks ?? 0;
    const totalReads = hits + miss;
    if (totalReads === 0) {
      signals.state_rocks = { status: 'unknown', detail: 'no db reads recorded yet', db_hits: hits, db_rpc_fallbacks: miss };
    } else {
      const rate = miss / totalReads;
      let status = 'ok';
      if (rate >= T.missRateDegraded) status = 'degraded';
      else if (rate >= T.missRateWatch) status = 'watch';
      signals.state_rocks = {
        status,
        detail: `state.rocks miss rate ${(rate * 100).toFixed(3)}% (${miss.toLocaleString()} fallbacks / ${totalReads.toLocaleString()} reads). Efficiency metric (cumulative since start) under active optimization — trend matters more than the absolute; ~7-8% is normal for this node.`,
        miss_rate: rate, db_hits: hits, db_rpc_fallbacks: miss,
      };
    }
  }

  // --- Signal 6: source rippled (.39) health (the OOM→halt guard) -----------
  if (!rippled || rippled.unreachable) {
    signals.source_rippled = { status: 'degraded', detail: 'local rippled unreachable — sync source at risk (this caused the 05-30 halt)' };
  } else {
    const st = rippled.server_state;
    const good = ['full', 'validating', 'proposing'].includes(st);
    signals.source_rippled = {
      status: good ? 'ok' : 'watch',
      detail: `rippled server_state=${st}, ${rippled.peers ?? '?'} peers, validated ${edge || '?'}`,
      server_state: st, peers: rippled.peers, complete_ledgers: rippled.complete_ledgers,
    };
  }

  // --- Informational: signing activity (NOT a health gate) ------------------
  if (stateHash) {
    signals.signing_info = {
      status: 'ok',
      informational: true,
      detail: `sig_ok=${engine?.sig_ok ?? '?'}, skipped_not_ready=${stateHash.validations_skipped_not_ready ?? 0}, skipped_zero_hash=${stateHash.validations_skipped_zero_hash ?? 0} (NOTE: signing ≠ health)`,
    };
  }

  // --- Roll up overall verdict ----------------------------------------------
  const gating = Object.entries(signals).filter(([, s]) => !s.informational);
  const worst = gating.reduce((acc, [, s]) => Math.max(acc, sev(s.status)), 0);
  const anySyncing = gating.some(([, s]) => s.status === 'syncing');
  const haltSuspected = !!signals.state_integrity?.halt_suspected;

  let verdict;
  if (errors.length && gating.every(([, s]) => s.status === 'unknown')) verdict = 'UNREACHABLE';
  else if (haltSuspected) verdict = 'HALT_SUSPECTED';
  else if (worst >= 3) verdict = 'DEGRADED';
  else if (anySyncing) verdict = 'SYNCING';
  else if (worst === 2) verdict = 'WATCH';
  else verdict = 'HEALTHY';

  const triggers = gating
    .filter(([, s]) => sev(s.status) >= 2)
    .map(([k, s]) => `${k}:${s.status}`);

  return {
    verdict,
    halt_suspected: haltSuspected,
    one_liner: buildOneLiner(verdict, signals, triggers),
    triggers,
    signals,
    read_errors: errors,
    note: 'Verdict computed deterministically from live signals. The LLM must report it verbatim and must NOT soften it.',
  };
}

function buildOneLiner(verdict, signals, triggers) {
  if (verdict === 'HEALTHY') {
    const cm = signals.state_integrity?.consecutive_matches ?? 0;
    return `HEALTHY — ${cm.toLocaleString()} consecutive state-hash matches, 0 mismatches, all signals green.`;
  }
  if (verdict === 'SYNCING') return `SYNCING — ${signals.sync?.detail || 'bulk sync in progress'}.`;
  if (verdict === 'UNREACHABLE') return 'UNREACHABLE — could not read validator signals.';
  return `${verdict} — triggered by: ${triggers.join(', ') || 'see signals'}.`;
}
