# Runbook: rippled / xrpld upgrades

ADVISORY. A human runs every step. Prove the upgrade on a NON-production node
first; never upgrade your live validator until you've verified the new build.

## Why it matters
- New releases activate **amendments**. If the network activates an amendment your
  node doesn't support, the node goes **amendment-blocked** — out of consensus until
  upgraded. Staying current is not optional.
- New amendments and transaction types can change behavior. If you run custom tooling
  on top of the node, re-verify across a range of ledgers, not just a handful.

## Sequence
1. Install or build the new version on a test/spare node.
2. Rebuild any custom tooling (e.g. an FFI shim) against the new library.
3. Bring it up; confirm it stays in consensus and — if you verify hashes — matches
   the network over a sustained window.
4. Only then upgrade the production validator, one node at a time.

## Watch for
- Stale linkage: make sure custom tooling links the NEW library, not a cached copy.
- Config/script renames between major versions.
- One change at a time; keep your source/upstream node alive throughout.
