import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildModel, findNeighbors, makeScratch, prepare, termVol, volScale } from '../src/forecast/analog.js';
import { runBacktest } from '../src/forecast/backtest.js';
import { runForecast } from '../src/forecast/forecast.js';
import { settings, syntheticDataset } from './synthetic.js';

const N = 1600;
const Q = 1200;
const H = 30;

function neighborsAt(mutateFrom?: number) {
  const ds = syntheticDataset(N, 7, mutateFrom);
  const s = settings({ horizon: H });
  const prep = prepare(ds, H);
  const { model } = buildModel(ds, s.features, s.startYear, undefined, Q);
  return { ds, nb: findNeighbors(ds, model, prep, Q, Q - H, s, makeScratch(ds.n))! };
}

test('analogs: every analog finished its forward window before the forecast bar', () => {
  const { nb } = neighborsAt();
  assert.ok(nb.idx.length >= 20);
  for (const i of nb.idx) assert.ok(i + H <= Q, `analog ${i} overlaps the forecast bar`);
});

test('analogs: weights are a probability distribution', () => {
  const { nb } = neighborsAt();
  const total = nb.w.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(nb.w.every((w) => w >= 0));
  assert.ok(nb.effectiveN > 0 && nb.effectiveN <= nb.weightESS + 1e-9, 'overlap can only reduce the sample');
});

test('no lookahead: rewriting the future leaves the analogs at bar Q untouched', () => {
  const a = neighborsAt().nb;
  const b = neighborsAt(Q).nb;
  assert.deepEqual(a.idx, b.idx);
  assert.deepEqual(a.w, b.w);
  assert.deepEqual(a.scale, b.scale);
});

test('no lookahead: volatility estimates at bar Q ignore later bars', () => {
  const a = syntheticDataset(N, 7);
  const b = syntheticDataset(N, 7, Q);
  assert.equal(termVol(a, Q, H, 0.98), termVol(b, Q, H, 0.98));
  assert.equal(volScale(a, Q, 500, true, settings()), volScale(b, Q, 500, true, settings()));
});

test('forecast: scenario probabilities sum to one and bands are ordered', () => {
  const ds = syntheticDataset();
  const s = settings({ horizon: H });
  const f = runForecast(ds, prepare(ds, H), s);
  const total = f.scenarios.reduce((a, sc) => a + sc.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `probabilities sum to ${total}`);
  for (const sc of f.scenarios) assert.ok(sc.probability >= 0 && sc.probability <= 1);
  for (const band of f.bands) assert.ok(band.lowPrice < band.highPrice);
  const width = (c: number) => {
    const band = f.bands.find((x) => x.confidence === c)!;
    return band.highPct - band.lowPct;
  };
  assert.ok(width(0.5) <= width(0.6) && width(0.6) <= width(0.8), 'wider confidence means a wider band');
});

test('backtest: a random walk gives no meaningful edge and calibrated bands', () => {
  const ds = syntheticDataset(2400, 11);
  const s = settings({ horizon: 14 });
  const r = runBacktest(ds, prepare(ds, 14), { settings: s, stepBars: 3, touchPct: 0 });
  assert.ok(r.evaluations > 200);
  const avg = r.scores.reduce((a, x) => a + x.skill, 0) / r.scores.length;
  // The path has no predictable direction, so the model must not claim a real edge on it.
  assert.ok(Math.abs(avg) < 0.05, `average Brier skill ${avg} on pure noise`);
  for (const cov of r.coverage) assert.ok(Math.abs(cov.observed - cov.nominal) < 0.12, `coverage ${cov.observed} vs ${cov.nominal}`);
});
