# Runbook: Spin-up grace window

ADVISORY. Context for interpreting a freshly-(re)synced node.

## What's normal right after a sync
After `bulk_sync` reports `verified: true`, the validator needs roughly
**42-45 ledgers** of live application before it settles into steady-state
hash matching.

During that window:
- Early `MISMATCH` lines are EXPECTED noise, not a real divergence.
- `consecutive_matches` will be low and `ready_to_sign` may be false — that is
  the streak rebuilding, not a fault.

## What to do
- Wait out the grace window before judging health.
- Do NOT trigger drift-recovery, wipe, or a code investigation on mismatch noise
  seen inside this window.
- After ~45 clean ledgers, apply the normal health-check rules.

## Red flag (not normal)
- Mismatches still appearing AFTER the grace window, with the match streak unable
  to climb, and not syncing → escalate to the drift-recovery runbook (diagnose
  the source rippled first).
