import { DEFAULT_FORECAST_SETTINGS, type ForecastSettings } from '@smart-btc/shared';
import { lastClosedIndex, type Dataset } from '../src/analytics/dataset.js';
import { atr, realizedVol, rsi } from '../src/analytics/indicators.js';

/** Deterministic pseudo-random numbers (mulberry32), so every run sees the same data. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400;

/**
 * A daily dataset built from a seeded random walk with volatility clustering. It carries two real
 * model features (RSI and 30-day volatility) computed with the production indicator code, so the
 * forecast pipeline runs on it end to end without touching the network or the local store.
 * `mutateFrom` replaces every bar after that index with a different path: the tool for proving that
 * results at a bar do not depend on anything that happened later.
 */
export function syntheticDataset(n = 1600, seed = 7, mutateFrom?: number): Dataset {
  const rand = rng(seed);
  const other = rng(seed + 1000);
  const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const o = new Float64Array(n);
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  let price = 10_000;
  let vol = 0.03;
  for (let i = 0; i < n; i++) {
    const r = mutateFrom != null && i > mutateFrom ? other : rand;
    vol = Math.max(0.01, Math.min(0.08, vol * (0.97 + 0.06 * r())));
    const ret = gauss(r) * vol;
    o[i] = price;
    c[i] = price * Math.exp(ret);
    h[i] = Math.max(o[i], c[i]) * (1 + Math.abs(gauss(r)) * vol * 0.4);
    l[i] = Math.min(o[i], c[i]) * (1 - Math.abs(gauss(r)) * vol * 0.4);
    v[i] = 1000 * (1 + r());
    price = c[i];
  }
  const t = Array.from({ length: n }, (_, i) => 1_500_000_000 + i * DAY);
  const rsi14 = rsi(c, 14);
  const vol30 = realizedVol(c, 30);
  const series = new Map([
    ['rsi14', rsi14],
    ['vol30', vol30],
  ]);
  return {
    tf: '1d',
    barSec: DAY,
    barsPerYear: 365,
    barDays: 1,
    stride: 1,
    version: 1,
    builtAt: 0,
    n,
    t,
    o,
    h,
    l,
    c,
    v,
    series,
    features: new Map(series),
    freshT: new Map(),
    vol90: realizedVol(c, 90),
    atr14: atr(h, l, c, 14),
    fundingPerDay: new Float64Array(n),
    // Every bar of the synthetic history is closed.
    lastClosed: lastClosedIndex(t, '1d', t[n - 1] + 10 * DAY),
  };
}

export const settings = (over: Partial<ForecastSettings> = {}): ForecastSettings => ({
  ...DEFAULT_FORECAST_SETTINGS,
  features: ['rsi14', 'vol30'],
  startYear: 2000,
  k: 40,
  ...over,
});
