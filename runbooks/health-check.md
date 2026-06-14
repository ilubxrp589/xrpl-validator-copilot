# Runbook: Health check

ADVISORY. The copilot presents this; a human interprets and acts. The verdict
in `get_health_summary` is computed deterministically — trust it over vibes.

## The rule
"Validations are happening" is NOT health. The signing gate can stay green while
state.rocks quietly rots underneath. A node is healthy only when ALL of these
are green at once:

1. **state-hash integrity** — `consecutive_matches` climbing, `total_mismatches`
   flat at 0, `ready_to_sign` true. A mismatch that breaks the streak while NOT
   syncing is the halt-class signature → treat as serious.
2. **ledger lag vs network edge** — our `ledger_seq` within a few of the local
   rippled's `validated_ledger.seq`. Growing lag = falling behind.
3. **divergences** — FFI `live_apply_diverged` / `silent_diverged` /
   `mutation_diverged` / `shadow_hash_mismatched`. Post-fix these are 0. Counters
   are cumulative since start, so what matters is whether they are *still growing*
   (a delta), not merely nonzero.
4. **state.rocks miss rate** — efficiency metric, ~7-8% is normal here; watch the
   *trend*, not the absolute. Not an acute failure on its own.
5. **source rippled (.39)** — `server_state=full`, contiguous `complete_ledgers`,
   peers > 0. This node is the sync source; its health gates everything.

## How to read it
- `get_health_summary` → the rolled-up verdict + every signal.
- Drill in with `get_engine_detail`, `get_state_hash_detail`, `get_rippled_status`.
- Spin-up grace: for ~42-45 ledgers after a `bulk_sync` verifies, early MISMATCH
  noise is EXPECTED — do not raise the alarm or trigger recovery in that window
  (see the spin-up runbook).

## Do not
- Do not declare "stable" off a single signal (especially signing activity).
- Do not act on one noisy reading — re-check, look for a trend.
