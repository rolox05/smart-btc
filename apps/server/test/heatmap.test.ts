import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entryMix } from '../src/analytics/liquidationHeatmap.js';

test('heatmap entries spread over the bar range, weights add up to one and peak near the typical price', () => {
  const mix = entryMix(110, 100, 110);
  assert.equal(mix.length, 5);
  assert.ok(Math.abs(mix.reduce((s, [, w]) => s + w, 0) - 1) < 1e-12);
  for (const [p] of mix) assert.ok(p > 100 && p < 110);
  // Typical price (110 + 100 + 110) / 3 ≈ 106.7: the entry at 107 weighs most, the one at 101 less than 107.
  const heaviest = mix.reduce((a, b) => (b[1] > a[1] ? b : a));
  assert.equal(heaviest[0], 107);
  assert.ok(mix[0][1] < mix[3][1]);
});

test('a bar with no range enters everything at one price', () => {
  assert.deepEqual(entryMix(100, 100, 100), [[100, 1]]);
});
