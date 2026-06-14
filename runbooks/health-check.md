# Runbook: Health check

ADVISORY. The copilot presents this; a human interprets and acts. Trust the
deterministic verdict from `get_health_summary` over impressions.

## The rule
"Producing validations" is NOT the same as healthy. A node can look busy while it's
amendment-blocked, lagging, or (on FFI nodes) silently diverging. A validator is
healthy only when all of these hold at once:

1. **server_state** — `full` / `proposing` / `validating` (not `connected` /
   `tracking` / `syncing` / `disconnected`).
2. **not amendment-blocked** — an amendment-blocked node is OUT of consensus until
   upgraded. The single most important generic signal.
3. **ledger currency** — the last validated ledger is seconds old, not minutes; the
   node is keeping up with the network.
4. **history** — `complete_ledgers` is contiguous (no gaps).
5. **peers / load** — enough peers, server not overloaded (`load_factor` ≈ 1).
6. **(FFI nodes only)** — state-hash match streak climbing, no growing divergence.

## How to read it
- `get_health_summary` → the rolled-up verdict, the tier, and every signal.
- `get_trend` → whether anything is *moving* (lag creeping, divergence growing).
- Drill in: `get_rippled_status` (any node), or `get_engine_detail` /
  `get_state_hash_detail` (FFI nodes only).

## Don't
- Don't declare "healthy" off one signal (especially raw validation activity).
- Don't react to a single noisy reading — re-check and look for a trend.
