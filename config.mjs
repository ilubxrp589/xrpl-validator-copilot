// Central config for the validator ops copilot.
// Every value is overridable by env, or by a gitignored config.local.json for
// host-specific values (real hostnames/IPs/paths) — so the committed defaults
// stay generic and a running instance keeps its real wiring out of git.

import { readFileSync } from 'node:fs';

function localCfg() {
  try { return JSON.parse(readFileSync(new URL('./config.local.json', import.meta.url), 'utf8')); }
  catch { return {}; }
}
const LOCAL = localCfg();

export const config = {
  // Validator API (/api/engine, /api/consensus, /api/state-hash, /api/peers).
  // Point this DIRECTLY at the validator's API host so the copilot doesn't depend
  // on a dashboard proxy being up — a health monitor must work when other things
  // are flaky. Set via COPILOT_API_BASE or config.local.json.
  apiBase: process.env.COPILOT_API_BASE || LOCAL.apiBase || 'http://localhost:3777',

  // System-resources sidecar (cpu/ram/disk/net) on the validator host.
  metricsBase: process.env.COPILOT_METRICS_BASE || LOCAL.metricsBase || 'http://localhost:3779',

  // Local rippled JSON-RPC — the source node whose health gates our sync.
  // (The 2026-05 halt saga root cause: this node OOM'd → incomplete pulls.)
  rippledRpc: process.env.COPILOT_RIPPLED_RPC || 'http://localhost:5005',

  // Historical divergence sample log (NOT the live signal — that's the FFI
  // counters in /api/engine). Used only for sample context.
  divergencesLog:
    process.env.COPILOT_DIVERGENCES_LOG || LOCAL.divergencesLog ||
    './logs/divergences.jsonl',

  // Anthropic
  model: process.env.COPILOT_MODEL || 'claude-opus-4-8', // max capability
  maxTokens: Number(process.env.COPILOT_MAX_TOKENS || 1500),
  apiKey: process.env.ANTHROPIC_API_KEY || '',

  // Provider: 'cli' shells out to the `claude` binary using YOUR Claude Code
  // account auth (no API key needed) — this is the default. 'api' uses the
  // Anthropic SDK with ANTHROPIC_API_KEY. Auto: api if a key is present, else cli.
  provider: process.env.COPILOT_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'api' : 'cli'),
  claudeBin: process.env.COPILOT_CLAUDE_BIN || 'claude',

  // Network timeout for a single endpoint read (ms).
  fetchTimeoutMs: Number(process.env.COPILOT_FETCH_TIMEOUT_MS || 6000),

  // Tolerances for the deterministic health verdict (see assess.mjs).
  thresholds: {
    // Lag = network edge − FFI round ledger (the live edge-tracking position,
    // not the frozen top-level engine.ledger_seq). Normally ~0.
    ledgerLagWatch: 25,     // ledgers behind network edge → WATCH (~90s)
    ledgerLagDegraded: 150, // → DEGRADED (~9 min / cascade territory)
    // state.rocks miss rate is an EFFICIENCY metric under active optimization
    // (see project_validator_state_rocks_miss_reduction), not an acute health
    // signal. ~7-8% is this node's known steady state. Gate only at genuinely
    // abnormal levels; trend matters far more than the absolute number.
    missRateWatch: 0.15,    // state.rocks miss rate (fallbacks / total db reads)
    missRateDegraded: 0.30,
    spinupGraceLedgers: 45, // ignore mismatch noise for N ledgers after a sync
  },
};
