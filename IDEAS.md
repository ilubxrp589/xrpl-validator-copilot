# Copilot — ideas / parking lot

Captured 2026-06-14. Not built — pick what's worth it.

**Update 2026-06-15:** most of the list below shipped — trend memory, proactive alerts
(Telegram), per-tx divergence deep-dive, incident memory, upstream root-cause (investigate
found the frozen-`engine.ledger_seq` `break` bug), and the daily digest are all built.
Plus host-memory OOM signal, UNL/validator-list health, and live validation-stream
monitoring. Remaining / new ideas below.

## Planned — design approved (not yet built)
- **Amendment vote board.** Read-only dashboard section: every amendment × our vote stance
  (YES / abstain) × live network status (enabled / in-voting+majority / not-yet), with a
  flag where an active amendment is one we abstain on. Copilot serves a free `GET /amendments`
  (full feature set joined to our committed vote list); dashboard renders the board. v1 is
  self-contained (no external support-% / ETA). Evolves at the 3.2.0 port: regenerate the
  vote list from `features.macro`, and expose the validator's *actual* live votes via the
  FFI API as the truth-source. Design spec lives in the validator repo's
  `docs/superpowers/specs/`.

## High value (recommended next)
- **Trend memory.** The service keeps a rolling buffer of verdicts/signals so COP can
  answer "is divergence *growing*?" / "has lag been *climbing*?" — fixes the current
  snapshot-only limit (cumulative counters need a delta to mean anything). In-memory
  ring + optional jsonl; expose a `get_trend` tool.
- **Proactive alerts.** COP watches `/health` on a timer; on a flip to DEGRADED /
  HALT_SUSPECTED, push to Slack / ntfy / existing alerting. Highest-value ops feature —
  catches the halt class early instead of waiting to be asked. Pure read-only.

## Medium
- **Per-tx divergence deep-dive.** Paste a tx hash → COP explains the TER / mutation
  mismatch from the FFI samples (+ optional local rippled tx lookup).
- **Incident pattern recall.** Index `divergences.jsonl` + past halt events so COP can
  say "this matches a known past incident signature."
- **Upstream root cause (read-only).** Investigate why the validator's Rust emits a
  frozen top-level `engine.ledger_seq` and `tracked_validators: 0` / `agreement: null`.

## Bigger / later
- **Cross-node view.** Fold the source/upstream rippled health in as a first-class
  signal (an unhealthy source is a common halt cause).
- **Daily digest.** `/schedule` a morning health summary.
- **Approval-gated actions.** COP proposes a step, human taps approve, it runs. NOTE:
  conflicts with the no-auto-recovery design — listed for completeness, not recommended.
