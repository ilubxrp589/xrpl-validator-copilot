// Regression tests for the amendments signal.
//
// 2026-09-25: fixBatchV1_2 gained majority on mainnet while the monitored xrpld (3.4.0) did not know it.
// xrpld's `feature` then lists the amendment by hash only, with no name, and the signal printed an empty
// list: "amendment(s) with majority this node does NOT support:  — activates ~2 weeks after majority".
// An amendment the server cannot name must still be identified, by its hash. Run: npm run test:amendments

import assert from 'node:assert/strict';
import { assess } from './assess.mjs';

const HASH = '14A2B45E48A4A124D1BBA657AC7B0DC3D5EA8C256C89E8F0D8142D32960A7944';
const signal = (unsupported) => assess({ rippled: {}, amendments: { available: true, unsupported } }).signals.amendments;

const unnamed = signal([{ hash: HASH, name: undefined, enabled: false, majority: 843660771 }]);
assert.equal(unnamed.status, 'watch');
assert.match(unnamed.detail, /14A2B45E48A4A124/, 'an unnamed amendment is identified by its hash');

const named = signal([{ hash: HASH, name: 'fixBatchV1_2', enabled: false, majority: 843660771 }]);
assert.match(named.detail, /fixBatchV1_2/, 'a named amendment is identified by its name');
console.log('amendments: 3/3');
