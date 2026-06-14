# Runbook: rippled / xrpld upgrades

ADVISORY. Human runs every step. Build and prove on **m3060 first** — never
touch .39 until the new build hash-matches.

## Point releases (e.g. 3.1.2 → 3.1.3) — proven ~15 min
- Install the new rippled .deb.
- Rebuild the FFI shim against the new libxrpl; cmake target is `xrpl.libxrpl`.
- Watch the stale-libxrpl trap: make sure the shim links the NEW libxrpl, not a
  cached copy, or you get silent version-mismatch behavior.
- Bring up, confirm hash-match before declaring done.

## 3.2.0 / rippled→xrpld — MAJOR, not just a rename
- Non-upgraded nodes fall OUT of consensus — this is not optional once activated.
- Higher divergence risk: new amendments and tx-types mean the FFI engine can
  diverge on transactions it has never seen. Re-verify shadow-hash match across a
  range of ledgers, not just a handful.
- Expect FFI shim + libxrpl rebuild, and script renames (rippled → xrpld).
- Sequence: build m3060 → hash-match a sustained window → only then plan .39.

## Always
- Build host is m3060 (.39 lacks libxrpl.a + has a Boost incompatibility).
- One change at a time; verify compilation; keep .39 rippled alive throughout.
