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
  // PRIMARY source — standard rippled/xrpld JSON-RPC (server_info). Every XRPL
  // validator exposes this, so point COP at YOUR node's RPC; it drives the
  // generic health verdict that works on any node.
  rippledRpc: process.env.COPILOT_RIPPLED_RPC || LOCAL.rippledRpc || 'http://localhost:5005',

  // OPTIONAL — WebSocket endpoint for the live `validations` stream (network
  // participation + this node's own validation reliability). Empty → derived from
  // rippledRpc (admin RPC :5005 commonly pairs with WS :6006). Set to 'off' to disable.
  rippledWs: process.env.COPILOT_RIPPLED_WS || LOCAL.rippledWs || '',

  // OPTIONAL — a custom validator API exposing an FFI shadow-verifier
  // (/api/engine, /api/state-hash, ...). Most nodes don't have this; leave empty.
  // If set and its /api/engine responds, COP layers deeper correctness signals on top.
  apiBase: process.env.COPILOT_API_BASE || LOCAL.apiBase || '',

  // OPTIONAL — a system-resources sidecar (cpu/ram/disk/net). Empty if none.
  metricsBase: process.env.COPILOT_METRICS_BASE || LOCAL.metricsBase || '',

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

  // Phase 4 — investigate mode lets COP READ the validator source (Read/Grep/Glob,
  // no Bash/Edit/Write) to chase root causes. Empty disables it. Investigate grants
  // read access to this tree (deployment-specific → config.local.json/env), so point
  // it at the source dir and don't fill that tree with unrelated secrets.
  codeRoot: process.env.COPILOT_CODE_ROOT || LOCAL.codeRoot || '',

  // Phase 2 — watchdog alerts. channel '' disables it. SECRETS (telegram token,
  // webhook URL) belong in gitignored config.local.json or env — never committed.
  alerts: {
    channel: process.env.COPILOT_ALERT_CHANNEL || LOCAL.alerts?.channel || '',   // 'telegram' | 'webhook'
    telegram: {
      token: process.env.COPILOT_TG_TOKEN || LOCAL.alerts?.telegram?.token || '',
      chatId: process.env.COPILOT_TG_CHAT || LOCAL.alerts?.telegram?.chatId || '',
    },
    webhookUrl: process.env.COPILOT_ALERT_WEBHOOK || LOCAL.alerts?.webhookUrl || '',
    webhookFormat: process.env.COPILOT_ALERT_FORMAT || LOCAL.alerts?.webhookFormat || 'json', // json|slack|discord|ntfy
    cooldownMin: Number(process.env.COPILOT_ALERT_COOLDOWN_MIN || 15),
    // Scheduled health digest pushed to the same channel: 'off' (default), 'daily',
    // or 'weekly', fired at digestHourUtc. Incident counts make it a real recap.
    digest: process.env.COPILOT_DIGEST || LOCAL.alerts?.digest || 'off',
    digestHourUtc: Number(process.env.COPILOT_DIGEST_HOUR_UTC ?? LOCAL.alerts?.digestHourUtc ?? 14),
  },

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
    // Peer count. This node accepts NO inbound peers — TCP 51235 is not
    // forwarded on the router (verified 2026-07-31: 8 peers, inbound=0), so it
    // is limited to outbound slots against saturated public hubs. 4-8 is its
    // known steady state, and the old hardcoded `p >= 5 ? ok` flapped straight
    // through it, firing WATCH 18 times in 7 days on a node that was `full`,
    // in consensus, and closing ledgers at offset 0.
    //
    // Same reasoning as missRate above: gate at genuinely abnormal levels. The
    // acute failure is starvation, not scarcity — 2026-07-31 saw 0 peers for
    // two hours, which cascaded into an unfillable ws-sync gap and cost a
    // validator wipe+resync (project_validator_peer_starvation_2026_07_31).
    // Those thresholds still catch it loudly.
    //
    // THE REAL FIX is forwarding the peer port to the node's LAN address on the router; with
    // inbound peers this node would hold 20-40 and never starve. Raise these
    // back toward 10/5 once that is done.
    peersWatch: 3,          // <= this many peers → WATCH
    peersDegraded: 1,       // <= this many peers → DEGRADED
  },

  // Ledger-store volume + online_delete window, for the store_pruning signal.
  // Sizing rule this guards (learned 2026-08-25): online_delete keeps TWO store
  // generations resident (the archive is only removed at the NEXT rotation), so
  // peak NuDB footprint is ~2x the window; SQLite transaction.db on the same
  // volume prunes rows but never shrinks. Under 512 MB free, xrpld stops ITSELF
  // cleanly ("Out of transaction DB space", exit 0) and Restart=on-failure
  // will not bring it back. Watching free space is the fix.
  store: {
    mount: process.env.COPILOT_STORE_MOUNT || LOCAL.store?.mount || '/var/lib/xrpld',
    // [node_db] online_delete from the node's config; null disables the width check.
    onlineDeleteWindow: Number(process.env.COPILOT_ONLINE_DELETE_WINDOW || LOCAL.store?.onlineDeleteWindow) || null,
  },
};
