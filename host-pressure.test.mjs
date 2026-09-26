// Regression tests for the host pressure signal.
//
// 2026-09-26 03:16: a text search across a large directory tree on the reference node's host saturated its
// system disk and pushed ~5 GB of process memory into swap on that same disk. xrpld stalled for ~4 minutes,
// and the only page was "UNREACHABLE — could not reach the rippled RPC", which named no cause. Linux records
// the share of time every task waited for memory or for disk I/O (/proc/pressure); the pages now carry it
// when it is high. It is informational: it explains a page, it never raises one. Run: npm run test:pressure

import assert from 'node:assert/strict';
import { assess, parsePressure } from './assess.mjs';
import { conditions } from './watchdog.mjs';

const psi = (avg60) => `some avg10=${avg60} avg60=${avg60} avg300=1.00 total=1\nfull avg10=${avg60} avg60=${avg60} avg300=1.00 total=1\n`;
const host = (mem, io) => ({
  available: true, total_gb: 61, available_gb: 40, available_pct: 65, load1: 2, cores: 6,
  pressure: { memory: parsePressure(psi(mem)), io: parsePressure(psi(io)) },
});

assert.deepEqual(
  parsePressure('some avg10=8.32 avg60=7.86 avg300=3.95 total=583408612435\nfull avg10=7.78 avg60=7.33 avg300=3.62 total=496679458133\n'),
  { some: { avg10: 8.32, avg60: 7.86, avg300: 3.95 }, full: { avg10: 7.78, avg60: 7.33, avg300: 3.62 } },
  '/proc/pressure lines parse',
);

// ffiAvailable: the validator API answered — as on 2026-09-26 — whatever apiBase config.local.json sets
const bundle = (rippled, h) => ({ rippled, host: h, ffiAvailable: true, ffi: {} });
const calm = assess(bundle({ unreachable: true }, host(0.2, 7)));
assert.equal(calm.signals.host_pressure.status, 'ok');
assert.equal(calm.signals.host_pressure.informational, true, 'pressure never gates the verdict');
assert.doesNotMatch(calm.one_liner, /pressure/, 'a calm host adds nothing to the page');

const storm = assess(bundle({ unreachable: true }, host(35, 70)));
assert.equal(storm.verdict, 'UNREACHABLE');
assert.match(storm.one_liner, /memory 35%.*swapping/, 'the UNREACHABLE page names the swap storm');
assert.match(conditions(storm, null)[0].detail, /swapping/);

const degraded = assess(bundle({ server_state: 'full', validated_seq: 100, validated_age: 2, peers: 20, load_factor: 1 }, host(35, 70)));
assert.equal(degraded.verdict, 'DEGRADED');
assert.match(conditions(degraded, null)[0].detail, /swapping/, 'a DEGRADED page carries it too');

console.log('host pressure: 4/4');
