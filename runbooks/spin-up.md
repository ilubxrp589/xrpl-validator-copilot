# Runbook: Spin-up grace window

ADVISORY. Context for interpreting a freshly-(re)synced node.

## What's normal right after a sync
After a node finishes syncing, it needs a short window of live operation before it
settles into steady state. During that window:
- Early mismatch / "catching up" noise is EXPECTED, not a fault.
- (FFI nodes) the match streak is low and `ready_to_sign` may be false — that's the
  streak rebuilding, not an error.

## What to do
- Wait out the grace window before judging health.
- Do NOT trigger recovery, wipe, or a code investigation on noise seen inside it.
- Once it settles, apply the normal health-check rules.

## Red flag (not normal)
- Problems persisting AFTER the grace window — mismatches that won't clear, a streak
  that can't climb, or the node never reaching a healthy `server_state` — escalate to
  the drift-recovery runbook (diagnose the upstream/source first).
