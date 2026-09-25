// Regression tests for the store_pruning signal.
//
// This guard has now been wrong three times, in every possible direction:
//   2026-08-25  it did not exist — the volume filled between two ON-SCHEDULE
//               rotations, xrpld stopped itself cleanly (exit 0 vs
//               Restart=on-failure), and stayed down.
//   2026-09-09  `retained > 1.5x window` called an on-schedule rotation
//               "STALLED" (state.db LastRotatedLedger confirmed on schedule).
//   2026-09-10  the replacement projected correctly but from a burn constant
//               derived from a generation's LIFETIME average (0.985 MB/ledger).
//               The true marginal rate was 0.71, so it paged every 15 minutes
//               about a deficit that did not exist.
// Hence: every rate here is byte-exact-measured, and the cases below pin both
// directions — what must fire, and what must stay silent. Run: npm run test:store

import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storePruningSignal } from './assess.mjs';

const WIN = 222_000;
const FLOOR = 106_548_647;              // reference node: fresh-store floor, 2026-08-26
const NEXT = FLOOR + 2 * WIN;           // 106,992,647 — matches state.db + window

const at = (top, free_gb, used_pct) => ({
  rippled: { complete_ledgers: `${FLOOR}-${top}` },
  host: { disk: { mount: '/var/lib/xrpld', free_gb, free_b: Math.round(free_gb * 2 ** 30), used_pct } },
});
const topFor = (retained) => FLOOR + Math.round(retained) - 1;

/** Two trend samples `hours` apart burning `gibPerDay`, ledgers at 22,200/day. */
function fixture(gibPerDay, freeNow, hours = 12) {
  const f = join(mkdtempSync(join(tmpdir(), 'cop-trend-')), 'trend.jsonl');
  const now = Date.now(), days = hours / 24;
  const mk = (ts, free, top) => ({ ts, store_free_gb: +free.toFixed(1), store_free_b: Math.round(free * 2 ** 30), store_top: top });
  const rows = [
    mk(now - hours * 3_600_000, freeNow + gibPerDay * days, 106_800_000),
    mk(now, freeNow, Math.round(106_800_000 + 22_200 * days)),
  ];
  writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
}
const NO_TREND = join(tmpdir(), 'cop-trend-absent.jsonl');   // forces the config fallback

function withTrend(file, fn) {
  const prev = process.env.COPILOT_TREND_FILE;
  process.env.COPILOT_TREND_FILE = file;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.COPILOT_TREND_FILE;
    else process.env.COPILOT_TREND_FILE = prev;
  }
}

const cases = [];
const test = (n, f) => cases.push([n, f]);

// --- what must stay SILENT -------------------------------------------------

// 2026-09-24: the fourth wrong call. After the 2026-09-17 upgrade restart the complete_ledgers FLOOR equals
// LastRotatedLedger itself (not lastRotated − window), so `floor + 2*window` put the next rotation one window
// (~10 days) late and paged 123 times in 7 days: "WILL NOT reach the next rotation". state.db said the rotation
// was due at 107,214,647 — and xrpld's SHAMapStore was already running it. state.db is authoritative.
const SEP24 = (top, last_rotated) => ({
  rippled: { complete_ledgers: `106992647-${top}` },
  host: { disk: { mount: '/mnt/xrpl-data', free_gb: 63.1, free_b: Math.round(63.1 * 2 ** 30), used_pct: 86.5, last_rotated } },
});

test('state.db LastRotatedLedger wins: the 2026-09-24 state is a rotation IN PROGRESS, not a race', () => {
  const s = withTrend(fixture(13.3, 63.1, 24), () => storePruningSignal(SEP24(107_215_084, 106_992_647)));
  assert.equal(s.next_rotation, 107_214_647);
  assert.notEqual(s.status, 'degraded', s.detail);
  assert.match(s.detail, /in progress/);
});

test('a rotation still unfinished well past its point IS degraded', () => {
  const s = withTrend(fixture(13.3, 63.1, 24), () => storePruningSignal(SEP24(107_214_647 + 40_000, 106_992_647)));
  assert.equal(s.status, 'degraded', s.detail);
  assert.match(s.detail, /OVERDUE/);
});

test('after the rotation state.db moves on and the projection resumes from it', () => {
  // state.db LastRotatedLedger = 107,214,647 → next = 107,436,647; ~9.9 d away with ~205 GiB free: fine.
  const b = SEP24(107_216_000, 107_214_647); b.host.disk.free_gb = 205; b.host.disk.free_b = 205 * 2 ** 30; b.host.disk.used_pct = 56;
  const s = withTrend(fixture(13.3, 205, 24), () => storePruningSignal(b));
  assert.equal(s.next_rotation, 107_436_647);
  assert.equal(s.status, 'ok', s.detail);
});

test('the real 2026-09-09 state is OK — it was never going to miss the rotation', () => {
  // free 94.8 GiB, 110,722 ledgers to rotation. At the measured 0.71 MB/ledger
  // that is ~6.4d of runway against a ~5.0d rotation: ~29% margin. The 0.985
  // constant put it at -8h and paged every 15 min. This case pins the fix.
  const s = withTrend(NO_TREND, () => storePruningSignal(at(106_881_925, 94.8, 79.8)));
  assert.equal(s.next_rotation, NEXT);
  assert.equal(s.status, 'ok', `expected ok, got ${s.status}: ${s.detail}`);
  assert.ok(s.days_to_full > s.days_to_rotation, 'must project reaching the rotation');
});

test('SILENT at the exact width that paged (retained 1.5x window)', () => {
  const s = withTrend(fixture(15.1, 300), () => storePruningSignal(at(topFor(333_243), 300, 40.0)));
  assert.equal(s.retained, 333_243);
  assert.equal(s.status, 'ok', `expected ok, got ${s.status}: ${s.detail}`);
  assert.equal(s.burn_measured, true);
  assert.doesNotMatch(s.detail, /STALLED/);
});

test('SILENT at 1.8x window mid-cycle — two generations resident is normal', () => {
  const s = withTrend(fixture(15.1, 60), () => storePruningSignal(at(topFor(1.8 * WIN), 60, 88.0)));
  assert.equal(s.status, 'ok', `expected ok, got ${s.status}: ${s.detail}`);
  assert.match(s.detail, /1x-2x is NORMAL/);
});

// --- what must FIRE --------------------------------------------------------

test('DEGRADED on a genuine deficit — cannot reach the next rotation', () => {
  const s = withTrend(NO_TREND, () => storePruningSignal(at(106_881_925, 40, 91.0)));
  assert.equal(s.status, 'degraded');
  assert.match(s.detail, /WILL NOT reach the next rotation/);
  assert.ok(s.days_to_full < s.days_to_rotation);
});

test('WATCH on a genuinely thin margin', () => {
  const s = withTrend(NO_TREND, () => storePruningSignal(at(106_881_925, 75, 84.0)));
  assert.equal(s.status, 'watch');
  assert.match(s.detail, /margin to next rotation under/);
  assert.ok(s.days_to_full > s.days_to_rotation, 'thin, but still reaches it');
});

test('DEGRADED on a genuine stall past the structural 2x ceiling', () => {
  const s = withTrend(fixture(15.1, 200), () => storePruningSignal(at(topFor(2.3 * WIN), 200, 55.0)));
  assert.equal(s.status, 'degraded');
  assert.match(s.detail, /GENUINELY stalled/);
});

test('disk backstops still fire independently of the projection', () => {
  const s = withTrend(fixture(1, 4), () => storePruningSignal(at(topFor(100_000), 4, 99.0)));
  assert.equal(s.status, 'degraded');
});

// --- measurement mechanics -------------------------------------------------

test('burn is measured from EXACT bytes, not the rounded GiB field', () => {
  // 2 GiB consumed over 2h => 24 GiB/day. The 0.1 GiB rounding of store_free_gb
  // cannot express this; store_free_b can.
  const f = join(mkdtempSync(join(tmpdir(), 'cop-trend-')), 'trend.jsonl');
  const now = Date.now();
  writeFileSync(f, [
    { ts: now - 2 * 3_600_000, store_free_gb: 100.0, store_free_b: 102 * 2 ** 30, store_top: 106_880_000 },
    { ts: now, store_free_gb: 100.0, store_free_b: 100 * 2 ** 30, store_top: 106_881_850 },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const s = withTrend(f, () => storePruningSignal(at(106_881_850, 100, 78.0)));
  assert.equal(s.burn_measured, true);
  assert.ok(Math.abs(s.burn_gib_day - 24) < 0.1, `expected ~24 GiB/day, got ${s.burn_gib_day}`);
});

test('falls back to the config rate when burn is negative (just after a rotation)', () => {
  const s = withTrend(fixture(-180, 260), () => storePruningSignal(at(106_882_172, 260, 45.0)));
  assert.equal(s.burn_measured, false, 'a rotation freeing space must not read as infinite runway');
  assert.ok(s.burn_gib_day > 0);
  assert.equal(s.status, 'ok');
});

test('returns null when there is nothing to assess', () => {
  assert.equal(storePruningSignal({}), null);
  assert.equal(storePruningSignal({ rippled: { complete_ledgers: 'empty' } }), null);
});

let fail = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
console.log(fail ? `\n${fail}/${cases.length} FAILED` : `\n${cases.length}/${cases.length} passed`);
process.exit(fail ? 1 : 0);
