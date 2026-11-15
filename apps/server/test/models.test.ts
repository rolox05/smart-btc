import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventOverlay, eventStudy, parseFomcCalendar } from '../src/analytics/events.js';
import { prepare } from '../src/forecast/analog.js';
import { fitQuantile, fitRidge, gridDist, runModels, sampleDist } from '../src/forecast/models.js';
import { FEEDS } from '../src/providers/liquidationStream.js';
import { rng, settings, syntheticDataset } from './synthetic.js';

const NO_EVENTS = { spreadMultiplier: 1, events: [] };

test('sampleDist: cdf and quantile agree with the sample', () => {
  const d = sampleDist([3, 1, 2, 4]);
  assert.equal(d.cdf(0), 0);
  assert.equal(d.cdf(2), 0.5);
  assert.equal(d.cdf(10), 1);
  assert.equal(d.quantile(0.5), 2);
  assert.equal(d.quantile(1), 4);
});

test('gridDist: quantile and cdf are inverses, and crossed quantiles are repaired', () => {
  const d = gridDist([0.1, 0.5, 0.9], [-2, 0, 2]);
  for (const p of [0.05, 0.1, 0.3, 0.5, 0.8, 0.95]) assert.ok(Math.abs(d.cdf(d.quantile(p)) - p) < 1e-9, `p=${p}`);
  const crossed = gridDist([0.1, 0.5, 0.9], [0, -2, 2]);
  assert.ok(crossed.quantile(0.1) <= crossed.quantile(0.5) && crossed.quantile(0.5) <= crossed.quantile(0.9));
});

test('fitRidge: recovers a linear relation', () => {
  const rand = rng(3);
  const n = 400;
  const X = new Float64Array(n * 2);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = rand() * 2 - 1;
    X[i * 2] = 1;
    X[i * 2 + 1] = x;
    y[i] = 0.5 + 2 * x + (rand() - 0.5) * 0.1;
  }
  const beta = fitRidge(X, y, n, 2, 1e-6);
  assert.ok(Math.abs(beta[0] - 0.5) < 0.02 && Math.abs(beta[1] - 2) < 0.03, `beta ${[...beta]}`);
});

test('fitQuantile: an intercept-only fit lands on the sample quantile', () => {
  const rand = rng(5);
  const n = 2000;
  const X = new Float64Array(n).fill(1);
  const y = Float64Array.from({ length: n }, () => rand());
  for (const tau of [0.1, 0.5, 0.9]) {
    const beta = fitQuantile(X, y, n, 1, tau, 0);
    assert.ok(Math.abs(beta[0] - tau) < 0.03, `tau ${tau} → ${beta[0]}`);
  }
});

test('fitQuantile: the spread between quantiles follows an input that drives volatility', () => {
  const rand = rng(9);
  const n = 3000;
  const X = new Float64Array(n * 2);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = rand();
    X[i * 2] = 1;
    X[i * 2 + 1] = x;
    y[i] = (rand() - 0.5) * (1 + 3 * x);
  }
  const lo = fitQuantile(X, y, n, 2, 0.1, 0);
  const hi = fitQuantile(X, y, n, 2, 0.9, 0);
  assert.ok(lo[1] < -0.5 && hi[1] > 0.5, `slopes ${lo[1]} / ${hi[1]}`);
});

test('models: all three run on synthetic data, are coherent, and claim no edge on noise', () => {
  const ds = syntheticDataset(2600, 21);
  const s = settings({ horizon: 14 });
  const r = runModels(ds, prepare(ds, 14), s, NO_EVENTS);
  assert.equal(r.models.length, 4);
  assert.ok(r.evaluations > 100);
  for (const m of r.models) {
    assert.ok(m.available, `${m.id} should run`);
    assert.ok(Math.abs(m.pRally + m.pRange + m.pDecline - 1) < 1e-6);
    assert.ok(m.q10 < m.q25 && m.q25 < m.q50 && m.q50 < m.q75 && m.q75 < m.q90, `${m.id} quantiles out of order`);
    assert.ok(Math.abs(m.skill!.avg) < 0.08, `${m.id} claims Brier skill ${m.skill!.avg} on a random walk`);
    assert.ok(Math.abs(m.skill!.coverage80 - 0.8) < 0.12, `${m.id} 80% band held ${m.skill!.coverage80}`);
  }
});

test('models: scheduled events widen the consensus without moving its centre', () => {
  const ds = syntheticDataset(2000, 21);
  const s = settings({ horizon: 14 });
  const prep = prepare(ds, 14);
  const plain = runModels(ds, prep, s, NO_EVENTS).adjusted;
  const wide = runModels(ds, prep, s, { spreadMultiplier: 1.3, events: [] }).adjusted;
  assert.ok(Math.abs(wide.q50 - plain.q50) < 1e-9);
  assert.ok(wide.q90 > plain.q90 && wide.q10 < plain.q10);
});

test('models: the forecast at the last closed bar ignores the forming bar', () => {
  const ds = syntheticDataset(2000, 21);
  const s = settings({ horizon: 14 });
  const a = runModels(ds, prepare(ds, 14), s, NO_EVENTS);
  // Same history, but the last bar is still open and has moved a lot.
  const open = { ...ds, c: Float64Array.from(ds.c), lastClosed: ds.n - 2 };
  const closed = { ...ds, lastClosed: ds.n - 2 };
  open.c[ds.n - 1] *= 1.2;
  const b = runModels(open, prepare(open, 14), s, NO_EVENTS);
  const c = runModels(closed, prepare(closed, 14), s, NO_EVENTS);
  assert.notEqual(a.asOf, b.asOf);
  for (let k = 0; k < 4; k++) assert.equal(b.models[k].pUp, c.models[k].pUp);
});

test('Fed calendar: decision days are read from the page layout', () => {
  const html = `
    <h4>2026 FOMC Meetings</h4>
    <div class="fomc-meeting__month"><strong>January</strong></div><div class="fomc-meeting__date">27-28</div>
    <div class="fomc-meeting__month"><strong>Apr/May</strong></div><div class="fomc-meeting__date">30-1*</div>
    <div class="fomc-meeting__month"><strong>August</strong></div><div class="fomc-meeting__date">22 (notation vote)</div>`;
  const days = parseFomcCalendar(html).map((t) => new Date(t * 1000).toISOString().slice(0, 10));
  assert.deepEqual(days, ['2026-01-28', '2026-05-01']);
});

test('event study: days with doubled moves show a variance ratio near four', () => {
  const ds = syntheticDataset(1500, 4);
  const c = Float64Array.from(ds.c);
  const dates: number[] = [];
  // Rebuild the path so that every 25th day moves twice as far as it did.
  let shift = 0;
  for (let i = 1; i < ds.n; i++) {
    const r = Math.log(ds.c[i] / ds.c[i - 1]);
    if (i % 25 === 0 && i > 100) {
      shift += r;
      dates.push(ds.t[i]);
    }
    c[i] = ds.c[i] * Math.exp(shift);
  }
  const study = eventStudy({ ...ds, c }, 'cpi', 'test', dates);
  assert.equal(study.n, dates.length);
  assert.ok(study.varianceRatio > 2.5 && study.varianceRatio < 6, `ratio ${study.varianceRatio}`);
});

test('event overlay: only events inside the horizon with a proven effect widen the range', () => {
  const now = 1_800_000_000;
  const day = 86_400;
  const ev = (kind: 'fomc' | 'cpi', t: number) => ({ kind, t, title: kind, detail: '', estimated: false });
  const study = (kind: 'fomc' | 'cpi', varianceRatio: number, n = 40) => ({ kind, name: kind, n, avgAbsMovePct: 2, normalAbsMovePct: 2, varianceRatio, upShare: 0.5 });
  const upcoming = [ev('cpi', now + 5 * day), ev('fomc', now + 9 * day), ev('cpi', now + 60 * day)];
  const o = eventOverlay(upcoming, [study('cpi', 3), study('fomc', 0.8)], now, 30);
  assert.equal(o.events.length, 2);
  // One CPI day worth three ordinary days inside a 30-day horizon: variance × 32/30.
  assert.ok(Math.abs(o.spreadMultiplier - Math.sqrt(32 / 30)) < 1e-9);
  // Too few past events to trust the ratio: nothing is widened.
  assert.equal(eventOverlay(upcoming, [study('cpi', 3, 5)], now, 30).spreadMultiplier, 1);
});

test('liquidation feeds: exchange messages are read with the right side and size', () => {
  const binance = FEEDS.find((f) => f.venue === 'Binance')!;
  const [b] = binance.parse({ e: 'forceOrder', o: { s: 'BTCUSDT', S: 'SELL', q: '0.5', p: '64000', ap: '64100', z: '0.5', T: 1700000000000 } });
  assert.deepEqual(b, { t: 1700000000000, venue: 'Binance', side: 'long', price: 64100, usd: 32050 });
  const bybit = FEEDS.find((f) => f.venue === 'Bybit')!;
  const [y] = bybit.parse({ topic: 'allLiquidation.BTCUSDT', data: [{ T: 1700000000001, s: 'BTCUSDT', S: 'Sell', v: '2', p: '65000' }] });
  assert.deepEqual(y, { t: 1700000000001, venue: 'Bybit', side: 'short', price: 65000, usd: 130000 });
  assert.deepEqual(bybit.parse({ op: 'pong' }), []);
});
