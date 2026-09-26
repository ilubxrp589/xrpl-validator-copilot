// Regression tests for the watchdog's paging policy.
//
// 2026-09-26: the store-pruning signal read WATCH from 03:32 (the free space projected to last ~8.8 days
// against a rotation ~8.5 days away), a condition that cannot clear for days. The watchdog re-paged every
// open condition each cooldown, and the cooldown was 15 minutes, so one unchanged WATCH paged 21 times in
// five hours, each copy with slightly different numbers. A warning pages once per episode, and again only
// when a signal its earlier pages did not name joins it; a critical condition also repeats after the
// cooldown. Run: npm run test:watchdog

import assert from 'node:assert/strict';
import { advance, conditions } from './watchdog.mjs';

const COOLDOWN = 60 * 60_000;
const MIN = 60_000;
const storeDetail = (gb) => ({ detail: `store pruning: /mnt/xrpl-data ${gb}GB free; margin to next rotation under 25%` });
const watch = (triggers, gb = 173.7) => conditions({
  verdict: 'WATCH', triggers,
  signals: Object.fromEntries(triggers.map((t) => [t.split(':')[0], t.startsWith('store_pruning') ? storeDetail(gb) : { detail: t }])),
})[0];

// Drive one condition through ticks at the given minutes; return the action of each tick.
function run(conds, minutes, muted = []) {
  let st;
  return minutes.map((m, i) => {
    const r = advance(st, conds[i], m * MIN, COOLDOWN, muted.includes(i));
    st = r.st;
    return r.action;
  });
}

// A WATCH that persists for hours pages once, however its numbers move.
{
  const ticks = [0, 1, 15, 61, 125, 300];
  const conds = ticks.map((_, i) => watch(['store_pruning:watch'], 173.7 - i * 0.1));
  assert.deepEqual(run(conds, ticks), [null, 'new', null, null, null, null], 'an unchanged warning pages once per episode');
}

// A signal that joins an open WATCH pages again; one that leaves it does not.
{
  const a = watch(['store_pruning:watch']);
  const ab = watch(['store_pruning:watch', 'ffi_lag:watch']);
  assert.deepEqual(run([a, a, ab, ab, a, ab], [0, 1, 2, 3, 4, 5]), [null, 'new', 'changed', null, null, null],
    'only a signal no earlier page named re-pages an open warning');
}

// A critical condition still repeats after the cooldown.
{
  const degraded = conditions({ verdict: 'DEGRADED', triggers: ['load_factor:degraded'], signals: { load_factor: { detail: 'load_factor=600 (under load)' } } })[0];
  assert.equal(degraded.level, 'critical');
  assert.deepEqual(run([degraded, degraded, degraded, degraded], [0, 1, 30, 62]), [null, 'new', null, 'repeat'],
    'a critical condition repeats once the cooldown has passed');
}

// Muted: record once, page nothing, and page on the first live tick if the condition is still there.
{
  const a = watch(['store_pruning:watch']);
  assert.deepEqual(run([a, a, a, a], [0, 1, 2, 3], [0, 1, 2]), [null, 'muted', null, 'new'],
    'a condition that opened while muted pages on the first live tick');
}

console.log('watchdog: 4/4');
