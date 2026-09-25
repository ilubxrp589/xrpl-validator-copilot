// Regression tests for the sync signal.
//
// 2026-09-25: the validator's first WARM restart resumed from its own stored state, verified against the
// network's account hash, instead of bulk-syncing. /api/state-hash then reports bulk_sync at its
// never-ran defaults (objects_synced 0, elapsed 0, verified false), and this signal read `verified: false`
// as "the last bulk sync failed verification" — a watch on a node matching every ledger. A bulk sync that
// never ran is not a failed one; one that ran and did not verify still is. Run: npm run test:sync

import assert from 'node:assert/strict';
import { assess } from './assess.mjs';

const neverRan = {
  elapsed_secs: 0, errors: 0, estimated_remaining_secs: 0, objects_synced: 0, pages_fetched: 0,
  rate: 0, running: false, verified: false, workers_done: 0, workers_total: 0,
};
const sync = (bulk_sync) => assess({
  rippled: {},
  ffiAvailable: true,
  ffi: { stateHash: { ready_to_sign: true, consecutive_matches: 419, total_mismatches: 0, bulk_sync }, engine: {} },
}).signals.sync;

assert.equal(sync(neverRan).status, 'ok', 'a warm start (no bulk sync ran) is not a failed sync');
assert.equal(sync({ ...neverRan, objects_synced: 19_900_000, pages_fetched: 41_000, elapsed_secs: 360 }).status, 'watch',
  'a bulk sync that ran and did not verify still watches');
assert.equal(sync({ ...neverRan, objects_synced: 19_900_000, verified: true }).status, 'ok', 'a verified bulk sync is ok');
assert.equal(sync({ ...neverRan, running: true, objects_synced: 5_000_000 }).status, 'syncing', 'a running bulk sync syncs');
console.log('sync: 4/4');
