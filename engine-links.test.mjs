// Regression tests for the engine-readiness and validator-links signals (FFI tier).
//
// 2026-09-25: fixBatchV1_2 gained majority on mainnet. The reference node's xrpld learned it with an
// upgrade, but the validator's engine did not (the amendment's source was unpublished), and nothing
// counted down to its activation. The copilot now compares the amendments with majority against the
// pending amendments the validator says its engine is ready for (/api/amendments), and warns, with the
// date, about any other. The validator's own connections (/api/connections) are reported alongside,
// informationally. Run: npm run test:engine

import assert from 'node:assert/strict';
import { assess } from './assess.mjs';

const RIPPLE_EPOCH_S = 946_684_800;
const majorityDaysAgo = (d) => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH_S - d * 86_400;
const FIX = { hash: '14A2B45E48A4A124D1BBA657AC7B0DC3D5EA8C256C89E8F0D8142D32960A7944', name: 'fixBatchV1_2', majority: majorityDaysAgo(1.5) };
const BATCH = { hash: '9F287AED3CDB50A7BD1ACEC24296A30C9B5230CCD136219317AC790E3B884377', name: 'BatchV1_1', majority: majorityDaysAgo(1.4) };
const ENGINE = {
  votes: ['BatchV1_1'],
  ready_pending: [
    { name: 'BatchV1_1', hash: BATCH.hash, evidence: 'campaigns 22 to 25' },
    { name: 'PermissionDelegationV1_1', hash: '0F48FF561C709540328F31F1C97FD512ACC8B4E42138A161CB0E21ECA292540B', evidence: 'finding 360' },
  ],
};
const run = (pending, engineAmendments, connections) => assess({
  rippled: {}, amendments: { available: true, unsupported: [], pending },
  ffiAvailable: true, ffi: { engineAmendments, connections },
}).signals;

// An amendment with majority that the engine is not ready for: WATCH, with its activation date.
{
  const s = run([FIX, BATCH], ENGINE).engine_amendments;
  assert.equal(s.status, 'watch');
  assert.match(s.detail, /fixBatchV1_2 activates ~\d{4}-\d\d-\d\d \d\d:\d\d UTC \(in 12 d\)/);
  assert.match(s.detail, /our engine is not ready for it yet/);
  assert.doesNotMatch(s.detail, /BatchV1_1 activates/, 'an amendment the engine is ready for is not flagged');
}

// Every coming amendment ready: ok, still listed with its date.
{
  const s = run([BATCH], ENGINE).engine_amendments;
  assert.equal(s.status, 'ok');
  assert.match(s.detail, /BatchV1_1 activates/);
}

// xrpld may know an amendment only by its hash: the hash still matches the engine's list.
{
  const s = run([{ ...BATCH, name: undefined }], ENGINE).engine_amendments;
  assert.equal(s.status, 'ok', s.detail);
}

// A validator without /api/amendments (an older build): no signal, never a guess.
assert.equal(run([FIX], null).engine_amendments, undefined);

// Connections: informational, primary endpoints and relay slots named.
{
  const relay = (hub, connected, extra = {}) => ({ hubs: [hub], connected: connected ? hub : null, connected_secs: connected ? 3600 : null, sessions: 1, failures_in_a_row: connected ? 0 : 3, last_failure: null, ...extra });
  const conn = {
    ws: { endpoint: 'primary', on_fallback: false, fallback_secs: 0, fallback_stints: 1 },
    rpc: { endpoint: 'primary', on_fallback: false, fallback_secs: 0, failovers: 2 },
    relays: [relay('s1.ripple.com:51235', true), relay('s2.ripple.com:51235', true), relay('r.ripple.com:51235', true), relay('hubs.xrpkuwait.com:51235', false)],
  };
  const s = run([], ENGINE, conn).validator_links;
  assert.equal(s.informational, true);
  assert.equal(s.status, 'ok');
  assert.match(s.detail, /ws-sync and RPC on the primary/);
  assert.match(s.detail, /relays 3\/4 \(s1\.ripple\.com, s2\.ripple\.com, r\.ripple\.com\)/);

  const off = run([], ENGINE, { ...conn, ws: { endpoint: 'wss://xrplcluster.com', on_fallback: true, fallback_secs: 300, fallback_stints: 2 } }).validator_links;
  assert.match(off.detail, /ws-sync on the public fallback wss:\/\/xrplcluster\.com for 5 min/);
}

console.log('engine + links: 5/5');
