import assert from 'node:assert/strict';
import { test } from 'node:test';
import { daysSinceDrawdown, daysSinceRally } from '../src/analytics/indicators.js';

const f = (a: number[]) => Float64Array.from(a);

test('rally counter resets when the high clears the leg low by the threshold', () => {
  // Price slides from 100 to 80, then bounces; the day whose high reaches 88 (80 × 1.1) is the rally.
  const c = [100, 95, 90, 85, 80, 82, 86, 87, 85];
  const h = [101, 96, 91, 86, 81, 84, 87, 88, 86];
  const l = [99, 94, 89, 84, 80, 81, 85, 86, 84];
  const d = Array.from(daysSinceRally(f(h), f(l), f(c), 0.1));
  assert.deepEqual(d, [1, 2, 3, 4, 5, 6, 7, 0, 1]);
});

test('rally counter is the mirror of the pullback counter', () => {
  const c = [100, 105, 112, 108, 100, 97, 99];
  const h = c.map((x) => x + 1);
  const l = c.map((x) => x - 1);
  const flip = (a: number[]) => a.map((x) => 1000 / x);
  // Inverting prices turns rallies into pullbacks (highs become lows).
  const rally = Array.from(daysSinceRally(f(h), f(l), f(c), 0.1));
  const pullbackOfInverse = Array.from(daysSinceDrawdown(f(flip(l)), f(flip(h)), f(flip(c)), 1 - 1 / 1.1));
  assert.deepEqual(rally, pullbackOfInverse);
});
