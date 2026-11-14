import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastClosedIndex } from '../src/analytics/dataset.js';
import { independentESS } from '../src/forecast/analog.js';
import { clamp, weightedQuantiles } from '../src/forecast/stats.js';

test('weightedQuantiles: equal weights give the usual median and extremes', () => {
  const [lo, mid, hi] = weightedQuantiles([5, 1, 3, 2, 4], [1, 1, 1, 1, 1], [0, 0.5, 1]);
  assert.equal(lo, 1);
  assert.equal(mid, 3);
  assert.equal(hi, 5);
});

test('weightedQuantiles: weight pulls the median toward the heavy value', () => {
  const [mid] = weightedQuantiles([0, 10], [9, 1], [0.5]);
  assert.ok(mid < 2, `median ${mid} should sit near the heavy value`);
});

test('weightedQuantiles: empty input yields NaN, not a crash', () => {
  assert.ok(Number.isNaN(weightedQuantiles([], [], [0.5])[0]));
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.5, 0, 1), 0.5);
});

test('independentESS: far-apart equal weights count fully', () => {
  const idx = [0, 100, 200, 300];
  const w = [0.25, 0.25, 0.25, 0.25];
  assert.ok(Math.abs(independentESS(idx, w, 30) - 4) < 1e-9);
});

test('independentESS: the same window counted n times is one sample', () => {
  assert.ok(Math.abs(independentESS([50, 50, 50, 50], [0.25, 0.25, 0.25, 0.25], 30) - 1) < 1e-9);
});

test('independentESS: overlapping windows count for less than their number', () => {
  const idx = [0, 10, 20, 30];
  const ess = independentESS(idx, [0.25, 0.25, 0.25, 0.25], 30);
  assert.ok(ess > 1 && ess < 4, `ess ${ess}`);
});

test('lastClosedIndex: the forming bar is excluded, a finished one is not', () => {
  const DAY = 86_400;
  const t = [0, DAY, 2 * DAY];
  assert.equal(lastClosedIndex(t, '1d', 2 * DAY + 3600), 1);
  assert.equal(lastClosedIndex(t, '1d', 3 * DAY + 1), 2);
});
