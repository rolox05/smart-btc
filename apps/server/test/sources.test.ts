import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Candle } from '@smart-btc/shared';
import { mergeCandles } from '../src/analytics/dataset.js';
import { parseFredCsv } from '../src/providers/more.js';
import { DAY_SEC, daily } from '../src/providers/types.js';
import { checkCandles, checkSeries, compareMembers, countSpikes, verdict } from '../src/sources/health.js';
import { SourcePrefs, SourceRuleError, visibleStore } from '../src/sources/prefs.js';
import type { Point, Store } from '../src/store/store.js';
import { rng } from './synthetic.js';

const NOW = 1_800_000_000;
const TODAY = Math.floor(NOW / DAY_SEC) * DAY_SEC;

/** A healthy daily series: a slow random walk ending today. */
function walk(n = 120, seed = 3): Point[] {
  const rand = rng(seed);
  let v = 100;
  return Array.from({ length: n }, (_, i) => {
    v *= 1 + (rand() - 0.5) * 0.02;
    return { t: TODAY - (n - 1 - i) * DAY_SEC, v };
  });
}
const gradeOf = (found: ReturnType<typeof checkSeries>, id: 'fresh' | 'gaps' | 'values') => verdict({ [id]: found[id] }, 0).checks[0].grade;

test('health: a complete, current, well-behaved series passes every check', () => {
  const found = checkSeries(daily('x', { positive: true }), walk(), NOW);
  assert.deepEqual([gradeOf(found, 'fresh'), gradeOf(found, 'gaps'), gradeOf(found, 'values')], ['good', 'good', 'good']);
  assert.equal(verdict(found, 0).score, 100);
});

test('health: a series that stopped updating is late, then bad', () => {
  const spec = daily('x');
  const shifted = (days: number) => walk().map((p) => ({ ...p, t: p.t - days * DAY_SEC }));
  assert.equal(gradeOf(checkSeries(spec, shifted(5), NOW), 'fresh'), 'warn');
  assert.equal(gradeOf(checkSeries(spec, shifted(30), NOW), 'fresh'), 'bad');
});

test('health: missing days lower completeness; a market that closes at weekends is not penalised', () => {
  const pts = walk();
  const holes = pts.filter((_, i) => i % 2 === 0);
  assert.equal(gradeOf(checkSeries(daily('x'), holes, NOW), 'gaps'), 'bad');
  const weekdays = pts.filter((p) => ![0, 6].includes(new Date(p.t * 1000).getUTCDay()));
  assert.equal(gradeOf(checkSeries(daily('x'), weekdays, NOW), 'gaps'), 'warn');
  assert.equal(gradeOf(checkSeries(daily('x', { duty: 0.66 }), weekdays, NOW), 'gaps'), 'good');
});

test('health: zeros, a stuck feed and bad ticks are caught; a real move that holds is not', () => {
  const zeros = walk().map((p, i) => (i > 110 ? { ...p, v: 0 } : p));
  assert.equal(gradeOf(checkSeries(daily('x', { positive: true }), zeros, NOW), 'values'), 'bad');

  const stuck = walk().map((p, i, all) => (i >= 108 ? { ...p, v: all[108].v } : p));
  assert.equal(gradeOf(checkSeries(daily('x'), stuck, NOW), 'values'), 'bad');
  assert.equal(gradeOf(checkSeries(daily('x', { mayRepeat: true }), stuck, NOW), 'values'), 'good');

  const values = walk().map((p) => p.v);
  const tick = values.map((v, i) => (i === 60 ? v * 10 : v));
  assert.equal(countSpikes(tick, false), 1);
  // A crash that stays down is the market, not the feed.
  const crash = values.map((v, i) => (i >= 60 ? v * 0.6 : v));
  assert.equal(countSpikes(crash, false), 0);
  assert.equal(countSpikes(values, false), 0);
});

test('health: candles with impossible prices are flagged', () => {
  const candles: Candle[] = walk().map((p) => ({ t: p.t, o: p.v, h: p.v * 1.01, l: p.v * 0.99, c: p.v, v: 1 }));
  assert.equal(verdict(checkCandles({ source: 'x', interval: '1d', barSec: DAY_SEC }, candles, NOW), 0).grade, 'good');
  const broken = candles.map((k, i) => (i % 30 === 5 ? { ...k, h: k.l * 0.9 } : k));
  const v = verdict(checkCandles({ source: 'x', interval: '1d', barSec: DAY_SEC }, broken, NOW), 0);
  assert.equal(v.checks.find((c) => c.id === 'values')?.grade, 'bad');
  assert.equal(v.grade, 'bad');
  assert.ok(v.score != null && v.score < 50, 'one failed check must drag the score down');
});

test('agreement: the source that disagrees with the rest is the one flagged', () => {
  const base = new Map(walk(30).map((p) => [Math.floor(p.t / DAY_SEC), p.v]));
  const scaled = (k: number) => new Map([...base].map(([d, v]) => [d, v * k]));
  const check = { what: 'daily close', warn: 0.015, bad: 0.04 };
  const three = compareMembers(check, [
    { provider: 'a', name: 'A', values: base },
    { provider: 'b', name: 'B', values: scaled(1.001) },
    { provider: 'c', name: 'C', values: scaled(1.1) },
  ]);
  assert.deepEqual([three.get('a')?.grade, three.get('b')?.grade, three.get('c')?.grade], ['good', 'good', 'bad']);

  // With two sources there is no telling which one is wrong: both get a warning, neither is condemned.
  const two = compareMembers(check, [
    { provider: 'a', name: 'A', values: base },
    { provider: 'c', name: 'C', values: scaled(1.1) },
  ]);
  assert.deepEqual([two.get('a')?.grade, two.get('c')?.grade], ['warn', 'warn']);
});

test('sources: a switched-off source is hidden from analytics, kept for downloads, and remembered', async () => {
  const kv = new Map<string, string>();
  const raw = {
    getSetting: async (k: string) => kv.get(k) ?? null,
    setSetting: async (k: string, v: string) => void kv.set(k, v),
    getPoints: async () => [{ t: 1, v: 1 }],
    getCandles: async () => [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }],
  } as unknown as Store;
  const prefs = new SourcePrefs(raw);
  const view = visibleStore(raw, prefs);
  let changes = 0;
  prefs.onChange(() => changes++);

  await prefs.setEnabled('coinmetrics', false);
  await prefs.setEnabled('binance-1h', false);
  assert.equal(changes, 2);
  assert.deepEqual(await view.getPoints('cm.mvrv'), []);
  assert.equal((await view.getPoints('fng')).length, 1);
  assert.deepEqual(await view.getCandles('binance', '1h'), []);
  assert.equal((await view.getCandles('binance', '1d')).length, 1);
  assert.equal((await raw.getPoints('cm.mvrv')).length, 1);

  const reloaded = new SourcePrefs(raw);
  await reloaded.load();
  assert.equal(reloaded.isEnabled('coinmetrics'), false);
  assert.notEqual(reloaded.key, new SourcePrefs(raw).key);
});

test('sources: the last price source cannot be switched off', async () => {
  const kv = new Map<string, string>();
  const prefs = new SourcePrefs({ getSetting: async (k: string) => kv.get(k) ?? null, setSetting: async (k: string, v: string) => void kv.set(k, v) } as unknown as Store);
  for (const id of ['binance-spot', 'coinbase', 'bitstamp']) await prefs.setEnabled(id, false);
  await assert.rejects(prefs.setEnabled('kraken', false), SourceRuleError);
  assert.equal(prefs.isEnabled('kraken'), true);
});

test('price history: other exchanges only extend the backbone, and stand in when it is empty', () => {
  const bar = (t: number, c: number): Candle => ({ t, o: c, h: c, l: c, c, v: 1 });
  const binance = [bar(3, 30), bar(4, 40)];
  const bitstamp = [bar(1, 11), bar(2, 21), bar(3, 31), bar(4, 41), bar(5, 51)];
  assert.deepEqual(mergeCandles([binance, bitstamp]).map((k) => k.c), [11, 21, 30, 40, 51]);
  assert.deepEqual(mergeCandles([[], bitstamp, [bar(0, 1), bar(6, 61)]]).map((k) => k.c), [1, 11, 21, 31, 41, 51, 61]);
  assert.deepEqual(mergeCandles([[], []]), []);
});

test('FRED: holiday rows without a figure are skipped', () => {
  const pts = parseFredCsv('observation_date,DGS10\n2026-11-10,4.98\n2026-11-11,\n2026-11-12,5.10\n2026-11-13,.\n');
  assert.deepEqual(pts.map((p) => p.v), [4.98, 5.1]);
  assert.equal(pts[0].t, Date.UTC(2026, 10, 10) / 1000);
});
