import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelOutlook, ModelsReport, TodaySnapshot } from '@smart-btc/shared';
import { buildToday, diffReadings, edgeState } from '../src/analytics/today.js';

const outlook = (id: ModelOutlook['id'], pUp: number, skill: number | null): ModelOutlook => ({
  id, name: id, description: '', available: true, pUp, pRally: 0.3, pRange: 0.4, pDecline: 0.3, q10: -12, q25: -5, q50: 1, q75: 6, q90: 14,
  skill: skill == null ? null : { up: skill, rally: skill, decline: skill, avg: skill, quantile: skill, coverage80: 0.8, coverage50: 0.5 },
});

const report = (pUp: number, skill: number | null, agreement: ModelsReport['agreement'] = 'bullish'): ModelsReport => ({
  timeframe: '1d', horizon: 30, thresholdPct: 10, price: 100_000, asOf: 1_800_000_000, evaluations: 400, from: 0, to: 0,
  models: [outlook('analog', pUp, skill), outlook('quantile', pUp, skill), outlook('trend', pUp, skill), outlook('ensemble', pUp, skill)],
  weights: [], overlay: { spreadMultiplier: 1, events: [] },
  adjusted: { q10: -12, q25: -5, q50: 1, q75: 6, q90: 14, pRally: 0.3, pDecline: 0.25, pRange: 0.45 },
  agreement, base: { pUp: 0.54, pRally: 0.28, pDecline: 0.24 }, notes: [],
});

const inputs = (models: ModelsReport) => ({ models, forecast: null, events: [], liquidity: null, previous: null, now: 1_800_000_000, barDays: 1 });

test('edge: close to the base rate, or an untested or losing model, is never an edge', () => {
  assert.equal(edgeState(0.55, 0.54, 0.05, 'bullish', 'good'), 'none');
  assert.equal(edgeState(0.7, 0.54, -0.01, 'bullish', 'good'), 'none');
  assert.equal(edgeState(0.7, 0.54, null, 'bullish', 'good'), 'weak');
  assert.equal(edgeState(0.7, 0.54, 0.03, 'mixed', 'good'), 'weak');
  assert.equal(edgeState(0.7, 0.54, 0.03, 'bullish', 'low'), 'weak');
  assert.equal(edgeState(0.7, 0.54, 0.03, 'bullish', 'moderate'), 'present');
});

test('today: a reading near the base rate says nothing unusual', () => {
  const s = buildToday(inputs(report(0.55, 0.02)))!;
  assert.equal(s.edge, 'none');
  assert.match(s.headline, /Nothing unusual/);
});

test('today: lean, scenarios and levels follow the consensus', () => {
  const s = buildToday(inputs(report(0.68, 0.03)))!;
  assert.equal(s.direction, 'up');
  assert.equal(s.strength, 'clear');
  assert.match(s.headline, /Clear upward lean over 30d/);
  assert.deepEqual(s.scenarios.map((x) => x.id), ['bear', 'base', 'bull']);
  assert.ok(Math.abs(s.scenarios.reduce((a, x) => a + x.probability, 0) - 1) < 1e-9);
  const [bear, base, bull] = s.scenarios;
  assert.ok(bear.lowPrice < bear.highPrice && bear.highPrice === base.lowPrice && base.highPrice === bull.lowPrice && bull.lowPrice < bull.highPrice);
  assert.deepEqual(s.levels.map((l) => l.kind), ['rangeHigh', 'median', 'rangeLow']);
  assert.equal(Math.round(s.levels[0].price), 114_000);
});

test('today: only events inside the horizon are listed, soonest first', () => {
  const day = 86_400;
  const now = 1_800_000_000;
  const ev = (kind: 'fomc' | 'cpi', days: number) => ({ kind, t: now + days * day, title: kind, detail: '', estimated: false });
  const s = buildToday({ ...inputs(report(0.6, 0.02)), events: [ev('fomc', 40), ev('cpi', 12), ev('fomc', 3)] })!;
  assert.deepEqual(s.events.map((e) => [e.kind, e.days]), [['fomc', 3], ['cpi', 12]]);
});

test('today: changes are reported against an earlier bar only, and small moves are ignored', () => {
  const prev: TodaySnapshot = { asOf: 1_799_913_600, price: 99_000, pUp: 0.58, medianPct: 0.8, edge: 'weak', direction: 'up', confidence: null };
  const s = buildToday({ ...inputs(report(0.68, 0.03)), previous: prev })!;
  assert.deepEqual(s.changes.map((c) => c.field), ['pUp', 'edge']);
  // The same bar read twice is not a change.
  assert.equal(buildToday({ ...inputs(report(0.68, 0.03)), previous: { ...prev, asOf: 1_800_000_000 } })!.previous, null);
  assert.deepEqual(diffReadings(prev, { ...prev, pUp: 0.59, medianPct: 1.2 }), []);
});

test('today: no consensus, no summary', () => {
  const m = report(0.6, 0.02);
  m.models = m.models.map((x) => ({ ...x, available: false }));
  assert.equal(buildToday(inputs(m)), null);
});
