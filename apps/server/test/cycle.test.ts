import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CYCLE_DAYS, cycleRepeat } from '../src/analytics/cycleRepeat.js';
import { HALVINGS, type Dataset } from '../src/analytics/dataset.js';

const DAY = 86_400;

/** Daily closes from the 2012 halving to `days` after the 2024 one; price is a known function of the day. */
function dataset(days: number, priceAt: (i: number) => number): Dataset {
  const t0 = HALVINGS[0] - 30 * DAY;
  const n = Math.round((HALVINGS[3] - t0) / DAY) + days + 2;
  const t = Array.from({ length: n }, (_, i) => t0 + i * DAY);
  const c = Float64Array.from(t, (_, i) => priceAt(i));
  // The last bar is the one still forming.
  return { tf: '1d', n, t, c, lastClosed: n - 2 } as unknown as Dataset;
}

test('cycle repeat: a past cycle is replayed from today\'s price, percentage move for percentage move', () => {
  const ds = dataset(900, (i) => 100 * 1.001 ** i);
  const r = cycleRepeat(ds, { cycles: [3], span: '1y', back: '6m' });
  assert.equal(r.cycleDay, 900);
  assert.equal(r.price, ds.c[ds.lastClosed]);
  assert.equal(r.t[r.today], r.asOf);
  assert.equal(r.t.length, 182 + 365 + 1);
  assert.deepEqual(r.cycles.map((c) => c.label), ['2012–2016', '2016–2020', '2020–2024']);
  const c3 = r.cycles[2];
  // Every path passes through today's price today.
  for (const c of r.cycles) assert.ok(Math.abs(c.values[r.today]! - r.price) < 1e-6);
  // Constant growth of 0.1% a day in every cycle: 365 days ahead is price × 1.001^365.
  assert.ok(Math.abs(c3.end!.price / r.price - 1.001 ** 365) < 1e-9);
  assert.equal(c3.end!.t, r.asOf + 365 * DAY);
  assert.equal(r.actual[r.today], r.price);
  assert.equal(r.actual[r.today + 1], null);
  assert.equal(r.average, null, 'one cycle selected: nothing to average');
});

test('cycle repeat: the average of several cycles is geometric and sits inside their band', () => {
  // Each cycle grows at its own daily rate after its halving, so the three paths differ.
  const rate = (t: number) => (t >= HALVINGS[3] ? 0 : t >= HALVINGS[2] ? 0.002 : t >= HALVINGS[1] ? 0.001 : 0.0005);
  const t0 = HALVINGS[0] - 30 * DAY;
  let p = 100;
  const prices: number[] = [];
  const ds = dataset(600, (i) => {
    p *= Math.exp(rate(t0 + i * DAY));
    prices.push(p);
    return p;
  });
  const r = cycleRepeat(ds, { cycles: [2, 3, 99], span: '6m', back: '6m' });
  assert.deepEqual(r.selected, [2, 3]);
  const [c2, c3] = [r.cycles[1], r.cycles[2]];
  const i = r.today + 100;
  assert.ok(Math.abs(c2.values[i]! / r.price - Math.exp(0.1)) < 1e-9);
  assert.ok(Math.abs(c3.values[i]! / r.price - Math.exp(0.2)) < 1e-9);
  assert.ok(Math.abs(r.average!.values[i]! / r.price - Math.exp(0.15)) < 1e-9);
  assert.ok(r.average!.low[i]! <= r.average!.values[i]! && r.average!.values[i]! <= r.average!.high[i]!);
});

test('cycle repeat: the window runs to the estimated next halving, or one year once that date has passed', () => {
  const early = cycleRepeat(dataset(1000, (i) => 100 + i), { cycles: [3], span: 'halving', back: '6m' });
  assert.equal(early.nextHalving, early.halving + CYCLE_DAYS * DAY);
  assert.equal(early.t[early.t.length - 1], early.nextHalving);

  const late = cycleRepeat(dataset(1500, (i) => 100 + i), { cycles: [3], span: 'halving', back: 'halving' });
  assert.equal(late.t.length, 1500 + 365 + 1);
  assert.equal(late.t[0], late.halving);
  // A path only ever reads days that had already happened.
  assert.ok(late.cycles.every((c) => c.end == null || c.end.t <= late.asOf + 365 * DAY));
});
