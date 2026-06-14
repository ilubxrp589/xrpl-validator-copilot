# XRPL Validator Ops Copilot

An **advisory, read-only** assistant for the validator. It reads the same live
signals the dashboard reads, computes a **deterministic health verdict in code**,
and uses an LLM only to explain the numbers and walk you through runbooks. It
cannot restart, wipe, resync, sign, or change anything — by design.

Why it's built this way: the verdict (`HEALTHY`/`WATCH`/`SYNCING`/`DEGRADED`/
`HALT_SUSPECTED`) comes from `assess.mjs`, not the model, so the LLM can never
hallucinate "all good" while a signal is red — directly addressing the
"signing ≠ health / state.rocks rots behind a green gate" failure mode. And there
is no auto-recovery (those loops death-spiral); the copilot proposes, a human acts.

## Layout
```
system-prompt.md   ← the centerpiece: 8-layer ops system prompt (priority order,
                     read-live-not-recall, health model, hard limits, runbooks)
assess.mjs         ← deterministic verdict over the live signals ("do the math")
tools.mjs          ← READ-ONLY tool layer (live readers + tool dispatch)
copilot.mjs        ← provider dispatcher (cli ↔ api)
claude-cli.mjs     ← DEFAULT provider: `claude -p` via your account (context injection)
agent.mjs          ← api provider: Anthropic SDK tool-use loop
healthcheck.mjs    ← no-LLM verdict CLI (zero deps, no key)
server.mjs         ← tiny HTTP service: GET /health (free), POST /copilot (LLM)
cli.mjs            ← ask questions from the terminal
runbooks/          ← health-check, drift-recovery, upgrade, spin-up SOPs
integration/       ← dashboard rewrite + <CopilotPanel/> drop-in
config.mjs         ← endpoints + thresholds (all env-overridable)
```

## Quick start
No API key needed for the deterministic verdict:
```bash
cd copilot
node healthcheck.mjs            # human-readable verdict + signals
node healthcheck.mjs --json     # machine-readable (exit 0 if HEALTHY/WATCH/SYNCING)
```
LLM answers — by default uses YOUR `claude` account auth (no API key), model Opus 4.8:
```bash
node cli.mjs "is the validator healthy?"
node cli.mjs "why is the state.rocks miss rate where it is?"
node cli.mjs --dry-run            # verdict + config, no model call
```
As a service:
```bash
node server.mjs                            # :3780  (pm2 start server.mjs --name validator-copilot)
curl localhost:3780/health                 # free deterministic verdict (no model call)
curl -XPOST localhost:3780/copilot -H content-type:application/json -d '{"question":"is it healthy?"}'
```
Prefer the Anthropic SDK instead of your account?
`COPILOT_PROVIDER=api ANTHROPIC_API_KEY=sk-... node cli.mjs "..."`

## Data sources (verified reachable from .39)
- Validator API **directly on m3060:3777** (`/api/engine`, `/api/consensus`,
  `/api/state-hash`, `/api/peers`) — read direct, NOT via the dashboard, so the
  copilot keeps working when the dashboard is down.
- Local **rippled :5005** for the network edge + source-node health.
- Host metrics from the sidecar on **m3060:3779**.
- Lag is measured from `ffi_verifier.round_ledger_seq` (the live edge-tracking
  field), not top-level `engine.ledger_seq` (a separate counter that can freeze).
All overridable in `config.mjs` / env.

## Safety invariants
- Every tool only reads. There is no code path from the copilot to a node mutation.
- The LLM is handed the code-computed verdict and instructed to report it verbatim.
- Recovery guidance always comes from a loaded runbook, framed as steps for a human.
- The default `claude -p` path runs with all mutating tools disabled (and `-p`
  denies unapproved tools anyway), so the account-auth provider can't touch the node either.

## Integration
See `integration/dashboard-integration.md` — run the service, add one rewrite,
drop in `CopilotPanel.tsx`. No new dashboard dependencies.

## Tuning
- Provider: default `cli` (your claude account, no key); set `COPILOT_PROVIDER=api` + `ANTHROPIC_API_KEY` for the SDK path.
- Model: `COPILOT_MODEL` (default `claude-opus-4-8`; `claude-sonnet-4-6` for cheaper/faster).
- Verdict thresholds (ledger lag, miss-rate bands): `config.mjs`. state.rocks
  miss rate is treated as an efficiency metric (~7-8% normal here), not an acute
  failure — gated only at genuinely abnormal levels.
