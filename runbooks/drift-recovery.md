# Runbook: Drift / mismatch recovery

ADVISORY ONLY. There is **no auto-recovery by design** — automatic re-sync loops
death-spiral. The copilot proposes; a HUMAN decides and runs every step below.
The copilot must never claim it executed any of this.

## Step 0 — Diagnose before touching anything
The validator is usually the VICTIM, not the bug. The 2026-05 halts were both
caused by the **source rippled (.39) being starved** (OOM-killed → incomplete
`ledger_entry` pulls → state-hash strikes → halt), not by validator logic.

So first: `get_rippled_status`.
- rippled unhealthy / not `full` / gaps in `complete_ledgers` / recently OOM'd
  → the fix is to **keep .39 alive**, not to wipe the validator. Stabilize the
  source first, then re-sync.
- rippled healthy → proceed to consider a canonical wipe + resync.

## Step 1 — Canonical recovery (human runs, on the validator host m3060)
- Wipe `state.rocks` + sync markers, then a fresh `bulk_sync`.
- Always wipe + resync on restart; do not restart on top of a dirty state dir.

## Known transients — retry, don't investigate
- The FIRST `bulk_sync` after a fresh rippled boot often comes up SHORT. That is
  a transient: just re-run wipe + resync. Do NOT start a code investigation over it.

## Hard don'ts
- NEVER delete in-progress sync DOWNLOADS / data files mid-sync.
- NEVER pile on multiple fixes at once — one change, observe, then decide.
- NEVER re-sync reflexively without the Step 0 diagnosis.
- Verify the build compiles before deploying any code fix; test before declaring stable.

## After recovery
Expect a ~42-45 ledger spin-up before steady-state matching; early MISMATCH noise
is expected (see the spin-up runbook). Don't re-trigger recovery inside that window.
