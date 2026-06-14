# Runbook: Drift / fell-behind / mismatch recovery

ADVISORY ONLY. The copilot proposes; a HUMAN decides and runs every step. Treat
recovery as a deliberate operator action — automatic resync loops can death-spiral,
so there is no safe "auto-heal."

## Step 0 — Diagnose before touching anything
A validator that's drifting or mismatching is often the VICTIM of a bad input, not
buggy itself. Check the cheap things first:
- Is the node **amendment-blocked**? → the fix is to upgrade, not to wipe.
- Is `server_state` unhealthy, or are there **`complete_ledgers` gaps**? → it's
  syncing/degraded, not necessarily corrupt.
- Is the **upstream / source** the node syncs from healthy? A starved or OOM'd
  source feeding incomplete data can cause downstream mismatches. Stabilize the
  source first.

## Step 1 — Recovery (operator runs)
If the local state is genuinely corrupt, the canonical recovery is: stop the node,
clear the corrupt local state per your deployment, resync from a healthy source,
then verify before trusting it again.

## Known transients — retry, don't investigate
- The FIRST resync after a fresh restart can come up short. That's often transient:
  re-run the resync before opening a code investigation.

## Hard don'ts
- NEVER delete in-progress sync data mid-resync.
- NEVER pile on multiple fixes at once — one change, observe, then decide.
- NEVER resync reflexively without the Step 0 diagnosis.
- Verify any rebuild compiles before deploying; test before declaring stable.

## After recovery
Expect a brief spin-up window before steady state (see the spin-up runbook); early
noise is normal — don't re-trigger recovery inside it.
