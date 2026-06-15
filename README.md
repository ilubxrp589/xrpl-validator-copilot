# XRPL Validator Ops Copilot

An advisory, **read-only** health copilot for any XRP Ledger validator (rippled /
xrpld). It computes a **deterministic health verdict in code** and uses an LLM only
to explain it — so the model can't hallucinate "all good" while a signal is red. It
never restarts, wipes, signs, or changes anything: it diagnoses and advises, you act.

## Two tiers
- **Generic core** — works on ANY node using standard `server_info`: `server_state`,
  **amendment status** (blocked now, or unsupported/approaching → upgrade warning),
  validated-ledger age, history gaps, peers, load, consensus,
  whether it's a configured validator. Point it at your rippled and go.
- **Optional FFI enhancement** — if your node also exposes a custom validator API
  with an FFI shadow-verifier (state-hash match streak, apply/shadow divergence,
  state.rocks misses), COP auto-detects it and layers deeper correctness signals on top.

`get_health_summary().tier` tells you which you're running (`generic` or `generic+ffi`).

## Quick start
```bash
git clone https://github.com/ilubxrp589/xrpl-validator-copilot
cd xrpl-validator-copilot && npm install
export COPILOT_RIPPLED_RPC=http://YOUR-NODE:5005   # your validator's JSON-RPC
node healthcheck.mjs                                 # deterministic verdict — no LLM, no key
```

LLM answers, two ways to reach a model:
- **Claude account (no API key):** if the `claude` CLI is logged in, it's the default —
  `node cli.mjs "is my validator healthy?"`
- **Anthropic API:** `COPILOT_PROVIDER=api ANTHROPIC_API_KEY=sk-... node cli.mjs "..."`

As a service (free `/health` + `/trend`, PIN-gated `/copilot`):
```bash
echo 'your-pin' > .copilot-pin
node server.mjs        # :3780 — GET /health, GET /trend (free); POST /copilot (LLM, PIN-gated + rate-limited)
```

## Ask it things like
Most of these go in the dashboard's Ask box or `node cli.mjs "…"`. The ones that read
your source use **investigate** mode (`POST /investigate`).

**Health & change**
- "Is the validator healthy right now?" / "Anything I should worry about?"
- "What's changed in the last hour?" / "Is divergence growing, or steady?"
- "Has the miss rate or ledger lag been creeping up?"
- "Is the host low on memory — any OOM/halt risk?" (host RAM is a `host_memory` signal)

**Amendments & upgrades**
- "Am I current on amendments — will I get amendment-blocked?"
- "How do I run a rippled/xrpld upgrade safely?"

**Consensus & UNL**
- "Is my UNL healthy — when does my validator list expire?" (`validator_list` signal)
- "What's my quorum and how many trusted validators do I have?"
- "Am I issuing validations and agreeing with the network?" (`validation` signal)
- "How many validators am I hearing from each ledger?"

**Forensics** (FFI nodes)
- "Have there been any divergences? What kind?"
- "Explain my historical divergences — what diverged and why?"

**Recovery**
- "If the node drifted or fell behind, how would I recover?"

**Investigate** (reads the source — `POST /investigate`)
- "Why is `<some metric>` behaving this way?"
- "Where is the state-hash comparison done in the code?"

It's read-only: ask it to restart / wipe / resync and it will refuse and explain why.

## Configure
Everything is overridable by env or a gitignored `config.local.json` (see `.env.example`):

| Var | What |
|-----|------|
| `COPILOT_RIPPLED_RPC` | your node's JSON-RPC (required) |
| `COPILOT_API_BASE` | optional custom FFI validator API (empty if none) |
| `COPILOT_RIPPLED_WS` | validations-stream WS (empty → derived from RPC; `off` to disable) |
| `COPILOT_METRICS_BASE` | optional host-metrics sidecar |
| `COPILOT_MODEL` | default `claude-opus-4-8`; `claude-sonnet-4-6` for cheaper/faster |
| `COPILOT_PROVIDER` | `cli` (claude account, default) or `api` (needs `ANTHROPIC_API_KEY`) |

The `.copilot-pin` file (or `COPILOT_PIN`) gates the paid `/copilot` endpoint; `/health`
and `/trend` stay open. A per-IP rate limit caps spend even if the PIN is shared.

Optional `node-profile.md` (gitignored): jot your node's *known-normal* and
*known-issues*, and COP weaves it into its health context and investigate mode — so it
stops re-flagging quirks you already understand.

## Verdict
`HEALTHY · WATCH · SYNCING · DEGRADED · AMENDMENT_BLOCKED · HALT_SUSPECTED · UNREACHABLE`,
computed deterministically in `assess.mjs`. The LLM reports it; it doesn't invent it.

## Alerts (watchdog)
Run as a service and the watchdog pushes an alert when the verdict degrades or a
trend goes wrong — reactively (verdict flips) and predictively (divergence growing,
match-streak stalled) — plus a recovery note when it clears. Debounced, cooldown'd,
and read-only. Configure a channel (Telegram, or a generic webhook for Slack /
Discord / ntfy / custom) via env or `config.local.json` (see `.env.example`). Test
delivery with `GET /alert-test` (PIN-gated).

## Investigate (code eyes)
Point `codeRoot` at your validator's source and COP can investigate root causes by
*reading* the code (Read / Grep / Glob only — no Bash / Edit / Write) via
`POST /investigate` (PIN-gated). It explains likely causes with file:line references
and never edits or runs anything. Opt-in and off by default; note it grants COP
read access to `codeRoot`, so point it at source, not a tree full of secrets.

## Safety
Every tool only reads. There is no code path from the copilot to a node mutation.
Recovery guidance always comes from a loaded runbook, framed as steps for a human.

## Layout
```
assess.mjs       deterministic two-tier verdict (generic core + optional FFI)
tools.mjs        read-only tools: rippled reader, FFI auto-detect, divergence forensics
trend.mjs        rolling trend memory — rate-of-change over time
watchdog.mjs     predictive alert watchdog (Telegram / webhook)
copilot.mjs      provider dispatch (claude CLI ↔ Anthropic SDK)
claude-cli.mjs   account-auth provider (claude -p) + investigate mode
agent.mjs        API provider (Anthropic SDK tool-use loop)
server.mjs       HTTP service: /health, /trend, /alert-test (free), /copilot, /investigate
cli.mjs          ask from the terminal · healthcheck.mjs   no-LLM verdict
runbooks/        operator SOPs (see note below)
system-prompt.md the copilot's instructions
```

## Notes
The `runbooks/` reflect the author's own deployment — treat them as example operator
SOPs and adapt them to your setup. Architecture: deterministic verdict + LLM explainer,
advisory and read-only by design.
