# Copilot — ideas / parking lot

Captured 2026-06-14. Not built — pick what's worth it.

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
  say "this matches the 2026-05-30 OOM-halt signature."
- **Upstream root cause (read-only).** Investigate why the validator's Rust emits a
  frozen top-level `engine.ledger_seq` and `tracked_validators: 0` / `agreement: null`.

## Bigger / later
- **Cross-node view.** Fold the .39 source rippled health in as a first-class signal
  (its OOM is the #1 documented halt cause).
- **Daily digest.** `/schedule` a morning health summary.
- **Approval-gated actions.** COP proposes a step, human taps approve, it runs. NOTE:
  conflicts with the no-auto-recovery design — listed for completeness, not recommended.
