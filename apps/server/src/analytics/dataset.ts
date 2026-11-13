import { DAY, TF_INFO, addBars, type Candle, type MetricSnapshot, type Timeframe } from '@smart-btc/shared';
import type { Point, Store } from '../store/store.js';
import {
  type Arr,
  atr,
  daysSinceDrawdown,
  ffill,
  lag,
  map,
  pctChange,
  realizedVol,
  rollingStd,
  rollingSum,
  rsi,
  runningMax,
  sma,
  supertrend,
} from './indicators.js';
import { METRICS, METRIC_BY_ID } from './metrics.js';

/** Everything the analytics need for one timeframe, aligned on a single time axis. */
export interface Dataset {
  tf: Timeframe;
  barSec: number;
  barsPerYear: number;
  /** Bar length in days (fractional for intraday). */
  barDays: number;
  /**
   * Thinning factor for analog candidates: on long intraday histories only every `stride`-th bar is
   * considered, which keeps searches as fast as on the daily series without losing distinct episodes.
   */
  stride: number;
  version: number;
  builtAt: number;
  n: number;
  t: number[];
  o: Arr;
  h: Arr;
  l: Arr;
  c: Arr;
  v: Arr;
  /** Metric id → value as displayed. */
  series: Map<string, Arr>;
  /** Metric id → model feature (transformed, and lagged where the source is delayed). */
  features: Map<string, Arr>;
  /** Metric id → time of the last bar that carried fresh upstream data. */
  freshT: Map<string, number>;
  vol90: Arr;
  atr14: Arr;
  /** Average perp funding per day (fraction of notional), trailing 7 days. */
  fundingPerDay: Arr;
}

/** Metrics recomputed on each timeframe's own bars. Everything else is a daily metric sampled onto the bars. */
export const NATIVE_METRICS = new Set(['sma200', 'sma50', 'bbUpper', 'bbLower', 'supertrend', 'rsi14', 'mom30', 'vol30']);

/** Candidate cap that keeps one analog search around the cost of the daily one. */
const MAX_CANDIDATES = 6000;

function nativeMetrics(h: Arr, l: Arr, c: Arr, barsPerYear: number, series: Map<string, Arr>, features: Map<string, Arr>) {
  series.set('supertrend', supertrend(h, l, c, 10, 3));
  const sma20 = sma(c, 20);
  const sd20 = rollingStd(c, 20);
  series.set('sma200', sma(c, 200));
  series.set('sma50', sma(c, 50));
  series.set('bbUpper', map(sma20, (m, i) => m + 2 * sd20[i]));
  series.set('bbLower', map(sma20, (m, i) => m - 2 * sd20[i]));

  const rsi14 = rsi(c, 14);
  series.set('rsi14', rsi14);
  features.set('rsi14', rsi14);

  const mom30 = pctChange(c, 30);
  series.set('mom30', mom30);
  features.set('mom30', map(mom30, (a) => Math.log(1 + a / 100)));

  const vol30 = realizedVol(c, 30, barsPerYear);
  series.set('vol30', vol30);
  features.set('vol30', map(vol30, (a) => (a > 0 ? Math.log(a) : NaN)));
}

const HALVINGS = ['2012-11-28', '2016-07-09', '2020-05-11', '2024-04-20'].map((d) => Date.parse(`${d}T00:00:00Z`) / 1000);

function mergeCandles(binance: Candle[], bitstamp: Candle[]): Candle[] {
  if (binance.length === 0) return bitstamp;
  const first = binance[0].t;
  const last = binance[binance.length - 1].t;
  // Bitstamp supplies the pre-2017 history, and takes over again if Binance falls behind (e.g. geo-blocked).
  return [...bitstamp.filter((c) => c.t < first), ...binance, ...bitstamp.filter((c) => c.t > last)];
}

async function buildDaily(store: Store, version: number): Promise<Dataset | null> {
  const [bn, bs] = await Promise.all([store.getCandles('binance', '1d'), store.getCandles('bitstamp', '1d')]);
  const merged = mergeCandles(bn, bs);
  if (merged.length < 400) return null;

  const t0 = merged[0].t;
  const n = Math.round((merged[merged.length - 1].t - t0) / DAY) + 1;
  const t = Array.from({ length: n }, (_, i) => t0 + i * DAY);
  const o = new Float64Array(n).fill(NaN);
  const h = new Float64Array(n).fill(NaN);
  const l = new Float64Array(n).fill(NaN);
  const c = new Float64Array(n).fill(NaN);
  const v = new Float64Array(n);
  for (const k of merged) {
    const i = Math.round((k.t - t0) / DAY);
    if (i < 0 || i >= n || !(k.c > 0)) continue;
    o[i] = k.o;
    h[i] = k.h;
    l[i] = k.l;
    c[i] = k.c;
    v[i] = k.v;
  }
  // Days with no trades (early exchange outages) become flat bars at the previous close.
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(c[i])) o[i] = h[i] = l[i] = c[i] = i > 0 ? c[i - 1] : merged[0].c;
  }

  const align = (pts: Point[], maxFill = 0, agg: 'last' | 'sum' = 'last'): Arr => {
    const out = new Float64Array(n).fill(NaN);
    for (const p of pts) {
      const i = Math.floor((p.t - t0) / DAY);
      if (i < 0 || i >= n) continue;
      out[i] = agg === 'sum' && !Number.isNaN(out[i]) ? out[i] + p.v : p.v;
    }
    return maxFill > 0 ? ffill(out, maxFill) : out;
  };
  const lastValid = (x: Arr) => {
    for (let i = x.length - 1; i >= 0; i--) if (!Number.isNaN(x[i])) return i;
    return -1;
  };

  const ids = [
    'cm.mvrv', 'cm.mcap', 'cm.supply', 'cm.flowIn', 'cm.flowOut',
    'bg.sthRealizedPrice', 'bg.sthSopr', 'fng', 'deribit.dvol', 'llama.stables',
    'binance.funding', 'binance.oi', 'binance.lsRatio',
  ] as const;
  const raw = Object.fromEntries(
    await Promise.all(ids.map(async (id) => [id, await store.getPoints(id)] as const)),
  ) as Record<(typeof ids)[number], Point[]>;

  const series = new Map<string, Arr>();
  const features = new Map<string, Arr>();
  const fresh = new Map<string, number>();
  const ln = (x: Arr) => map(x, (a) => (a > 0 ? Math.log(a) : NaN));

  // ── price-derived ──
  nativeMetrics(h, l, c, 365, series, features);
  const mayer = map(series.get('sma200')!, (m, i) => c[i] / m);
  series.set('mayer', mayer);
  features.set('mayer', ln(mayer));

  for (const pct of [10, 15, 20, 25, 30, 35]) {
    const d = daysSinceDrawdown(h, l, c, pct / 100);
    series.set(`ddDays${pct}`, d);
    features.set(`ddDays${pct}`, map(d, (a) => Math.log1p(a)));
  }
  const ath = runningMax(h);
  const ddAth = map(ath, (m, i) => (c[i] / m - 1) * 100);
  series.set('ddAth', ddAth);
  features.set('ddAth', ddAth);

  // ── on-chain ──
  const cmMvrv = align(raw['cm.mvrv']);
  const cmMcap = align(raw['cm.mcap']);
  const cmSupply = align(raw['cm.supply']);
  const realizedRaw = map(cmMvrv, (m, i) => cmMcap[i] / m / cmSupply[i]);
  const realizedPrice = ffill(realizedRaw, 5);
  series.set('realizedPrice', realizedPrice);
  fresh.set('realizedPrice', lastValid(realizedRaw));
  // Using today's price over the latest cost basis keeps MVRV live even though the source is a day behind.
  const mvrv = map(realizedPrice, (rp, i) => c[i] / rp);
  series.set('mvrv', mvrv);
  features.set('mvrv', ln(mvrv));
  fresh.set('mvrv', lastValid(realizedRaw));

  const sthRaw = align(raw['bg.sthRealizedPrice']);
  const sthDelay = METRIC_BY_ID.get('sthRealizedPrice')?.delayedDays ?? 0;
  const sthRp = ffill(sthRaw, 21);
  series.set('sthRealizedPrice', sthRp);
  series.set('sthMvrv', map(sthRp, (rp, i) => c[i] / rp));
  // The model only ever sees the cost basis as it was `delay` days earlier - exactly what is available live.
  const sthRpLagged = ffill(lag(ffill(sthRaw, 3), sthDelay), 14);
  features.set('sthMvrv', ln(map(sthRpLagged, (rp, i) => c[i] / rp)));
  // Short-term holder behavioural analysis: STH-MVRV relative to its own 90-day average, with bands one
  // standard deviation either side of its typical level over the past year. Outside the bands, recent
  // buyers are unusually stretched in profit (above) or in loss (below).
  const behaviour = (ratio: Arr) => {
    const avg90 = sma(ratio, 90);
    const adj = map(ratio, (r, i) => r - avg90[i]);
    const upper = new Float64Array(n).fill(NaN);
    const lower = new Float64Array(n).fill(NaN);
    const z = new Float64Array(n).fill(NaN);
    const WINDOW = 365;
    const MIN = 120;
    let s1 = 0;
    let s2 = 0;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(adj[i])) {
        s1 += adj[i];
        s2 += adj[i] * adj[i];
        cnt++;
      }
      const old = i - WINDOW;
      if (old >= 0 && !Number.isNaN(adj[old])) {
        s1 -= adj[old];
        s2 -= adj[old] * adj[old];
        cnt--;
      }
      if (cnt >= MIN && !Number.isNaN(adj[i])) {
        const mean = s1 / cnt;
        const sd = Math.sqrt(Math.max(1e-12, s2 / cnt - mean * mean));
        upper[i] = mean + sd;
        lower[i] = mean - sd;
        z[i] = (adj[i] - mean) / sd;
      }
    }
    return { adj, upper, lower, z };
  };
  const shown = behaviour(map(sthRp, (rp, i) => c[i] / rp));
  series.set('sthBehavior', shown.adj);
  series.set('sthBehaviorUpper', shown.upper);
  series.set('sthBehaviorLower', shown.lower);
  // The model sees it built from the cost basis as it was available live (lagged), like STH-MVRV.
  features.set('sthBehavior', behaviour(map(sthRpLagged, (rp, i) => c[i] / rp)).z);
  fresh.set('sthBehavior', lastValid(sthRaw));
  fresh.set('sthRealizedPrice', lastValid(sthRaw));
  fresh.set('sthMvrv', lastValid(sthRaw));

  const soprRaw = align(raw['bg.sthSopr']);
  const sopr7 = sma(ffill(soprRaw, 2), 7);
  series.set('sthSopr', sopr7);
  features.set('sthSopr', ln(ffill(lag(sopr7, sthDelay), 14)));
  fresh.set('sthSopr', lastValid(soprRaw));

  const flowIn = align(raw['cm.flowIn']);
  const flowOut = align(raw['cm.flowOut']);
  const net7 = rollingSum(map(flowIn, (a, i) => a - flowOut[i]), 7);
  const netflowRaw = map(net7, (a, i) => (a / cmMcap[i]) * 100);
  const netflow = ffill(netflowRaw, 5);
  series.set('exchNetflow', netflow);
  features.set('exchNetflow', netflow);
  fresh.set('exchNetflow', lastValid(netflowRaw));

  // ── derivatives ──
  const fSum = new Float64Array(n);
  const fCnt = new Float64Array(n);
  for (const p of raw['binance.funding']) {
    const i = Math.floor((p.t - t0) / DAY);
    if (i < 0 || i >= n) continue;
    fSum[i] += p.v;
    fCnt[i] += 1;
  }
  const fSum7 = rollingSum(fSum, 7);
  const fCnt7 = rollingSum(fCnt, 7);
  // Average rate per settlement over 7 days, expressed per day (3 settlements) and annualised in %.
  const fundingPerDay = map(fSum7, (s, i) => (fCnt7[i] >= 12 ? (s / fCnt7[i]) * 3 : NaN));
  const funding = map(fundingPerDay, (a) => a * 365 * 100);
  series.set('funding', funding);
  features.set('funding', funding);
  const oiRaw = align(raw['binance.oi']);
  series.set('oi', ffill(oiRaw, 2));
  fresh.set('oi', lastValid(oiRaw));
  const lsRaw = align(raw['binance.lsRatio']);
  series.set('lsRatio', ffill(lsRaw, 2));
  fresh.set('lsRatio', lastValid(lsRaw));

  // ── sentiment / volatility / liquidity / cycle ──
  const fngRaw = align(raw['fng']);
  const fng = ffill(fngRaw, 3);
  series.set('fng', fng);
  features.set('fng', fng);
  fresh.set('fng', lastValid(fngRaw));

  const dvolRaw = align(raw['deribit.dvol']);
  const dvol = ffill(dvolRaw, 3);
  series.set('dvol', dvol);
  features.set('dvol', ln(dvol));
  fresh.set('dvol', lastValid(dvolRaw));

  const stablesRaw = align(raw['llama.stables']);
  const stableGrowth = pctChange(ffill(stablesRaw, 5), 30);
  series.set('stableGrowth', stableGrowth);
  features.set('stableGrowth', stableGrowth);
  fresh.set('stableGrowth', lastValid(stablesRaw));

  const cycleDay = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let last = NaN;
    for (const hv of HALVINGS) if (hv <= t[i]) last = hv;
    if (!Number.isNaN(last)) cycleDay[i] = Math.round((t[i] - last) / DAY);
  }
  series.set('cycleDay', cycleDay);
  features.set('cycleDay', cycleDay);

  for (const m of METRICS) if (!fresh.has(m.id)) fresh.set(m.id, n - 1);

  return {
    tf: '1d',
    barSec: DAY,
    barsPerYear: 365,
    barDays: 1,
    stride: Math.max(1, Math.ceil(n / MAX_CANDIDATES)),
    version,
    builtAt: Date.now(),
    n,
    t,
    o,
    h,
    l,
    c,
    v,
    series,
    features,
    freshT: new Map([...fresh].map(([id, i]) => [id, i >= 0 ? t[i] : NaN])),
    vol90: realizedVol(c, 90),
    atr14: atr(h, l, c, 14),
    fundingPerDay: ffill(fundingPerDay, 3),
  };
}

// ───────────────────────── other timeframes ─────────────────────────

/** Roll daily bars up into weekly (Monday start, like the exchanges) or calendar-month bars. */
function aggregateDaily(d: Dataset, tf: '1w' | '1M'): Candle[] {
  const out: Candle[] = [];
  const keyOf = (t: number) => {
    if (tf === '1w') return t - (((Math.floor(t / DAY) + 3) % 7) * DAY);
    const dt = new Date(t * 1000);
    return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1) / 1000;
  };
  for (let i = 0; i < d.n; i++) {
    const key = keyOf(d.t[i]);
    const last = out[out.length - 1];
    if (last && last.t === key) {
      last.h = Math.max(last.h, d.h[i]);
      last.l = Math.min(last.l, d.l[i]);
      last.c = d.c[i];
      last.v += d.v[i];
    } else {
      out.push({ t: key, o: d.o[i], h: d.h[i], l: d.l[i], c: d.c[i], v: d.v[i] });
    }
  }
  return out;
}

/** Put intraday candles on a gap-free grid; exchange outages become flat bars at the previous close. */
function onGrid(candles: Candle[], barSec: number): Candle[] {
  if (candles.length === 0) return candles;
  const t0 = candles[0].t;
  const n = Math.round((candles[candles.length - 1].t - t0) / barSec) + 1;
  const out = new Array<Candle>(n);
  for (const k of candles) {
    const i = Math.round((k.t - t0) / barSec);
    if (i >= 0 && i < n && k.c > 0) out[i] = k;
  }
  for (let i = 0; i < n; i++) {
    if (!out[i]) {
      const prev = out[i - 1].c;
      out[i] = { t: t0 + i * barSec, o: prev, h: prev, l: prev, c: prev, v: 0 };
    }
  }
  return out;
}

/**
 * Dataset for a non-daily timeframe. Price indicators are recomputed on the timeframe's own bars;
 * every other metric is a daily quantity and is sampled from the daily dataset: each bar sees the
 * last daily value that was complete when the bar closed, so nothing looks ahead.
 */
async function buildFromDaily(store: Store, daily: Dataset, tf: Exclude<Timeframe, '1d'>, version: number): Promise<Dataset | null> {
  const info = TF_INFO[tf];
  const candles = tf === '1w' || tf === '1M' ? aggregateDaily(daily, tf) : onGrid(await store.getCandles('binance', tf), info.barSec);
  const n = candles.length;
  if (n < 120) return null;

  const t = candles.map((k) => k.t);
  const o = Float64Array.from(candles, (k) => k.o);
  const h = Float64Array.from(candles, (k) => k.h);
  const l = Float64Array.from(candles, (k) => k.l);
  const c = Float64Array.from(candles, (k) => k.c);
  const v = Float64Array.from(candles, (k) => k.v);

  const series = new Map<string, Arr>();
  const features = new Map<string, Arr>();
  nativeMetrics(h, l, c, info.barsPerYear, series, features);

  // Index of the last daily bar completed by the time bar i closes.
  const dailyIdx = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const close = i + 1 < n ? t[i + 1] : addBars(tf, t[i], 1);
    dailyIdx[i] = Math.min(daily.n - 1, Math.floor((close - daily.t[0]) / DAY) - 1);
  }
  const sample = (x: Arr): Arr => {
    const out = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (dailyIdx[i] >= 0) out[i] = x[dailyIdx[i]];
    return out;
  };
  for (const [id, x] of daily.series) if (!NATIVE_METRICS.has(id)) series.set(id, sample(x));
  for (const [id, x] of daily.features) if (!NATIVE_METRICS.has(id)) features.set(id, sample(x));

  const freshT = new Map<string, number>();
  for (const [id, ft] of daily.freshT) freshT.set(id, NATIVE_METRICS.has(id) ? t[n - 1] : ft);

  return {
    tf,
    barSec: info.barSec,
    barsPerYear: info.barsPerYear,
    barDays: info.barSec / DAY,
    stride: Math.max(1, Math.ceil(n / MAX_CANDIDATES)),
    version,
    builtAt: Date.now(),
    n,
    t,
    o,
    h,
    l,
    c,
    v,
    series,
    features,
    freshT,
    vol90: realizedVol(c, 90, info.barsPerYear),
    atr14: atr(h, l, c, 14),
    fundingPerDay: sample(daily.fundingPerDay),
  };
}

// ───────────────────────── snapshot ─────────────────────────

function describe(id: string, v: number, pct: number): { reading: string; tone: MetricSnapshot['tone'] } {
  const r = (reading: string, tone: MetricSnapshot['tone'] = 'neutral') => ({ reading, tone });
  switch (id) {
    case 'rsi14':
      if (v >= 70) return r('Overbought', 'bearish');
      if (v <= 30) return r('Oversold', 'bullish');
      return v >= 55 ? r('Firm momentum', 'bullish') : v <= 45 ? r('Soft momentum', 'bearish') : r('Neutral');
    case 'mayer':
      if (v >= 2.4) return r('Overheated', 'bearish');
      if (v < 0.8) return r('Deep discount to trend', 'bullish');
      return v >= 1 ? r('Above 200d trend', 'bullish') : r('Below 200d trend', 'bearish');
    case 'sthMvrv':
      if (v < 0.85) return r('Recent buyers deep underwater', 'bullish');
      if (v < 1) return r('Recent buyers underwater', 'bearish');
      return v > 1.35 ? r('Recent buyers in heavy profit', 'bearish') : r('Recent buyers in profit', 'bullish');
    case 'sthSopr':
      if (v < 0.98) return r('STH selling at a loss', 'bearish');
      return v > 1.03 ? r('STH taking profit') : r('Near break-even');
    case 'mvrv':
      if (v >= 3.5) return r('Historic top zone', 'bearish');
      if (v < 1) return r('Below aggregate cost basis', 'bullish');
      return v >= 2.4 ? r('Elevated') : r('Mid-cycle range');
    case 'fng':
      if (v <= 25) return r('Extreme fear', 'bullish');
      if (v >= 75) return r('Extreme greed', 'bearish');
      return v < 45 ? r('Fear') : v > 55 ? r('Greed') : r('Neutral');
    case 'funding':
      if (v > 30) return r('Crowded longs', 'bearish');
      if (v < 0) return r('Shorts paying longs', 'bullish');
      return r('Normal');
    case 'ddAth':
      return v > -5 ? r('At / near all-time high', 'bullish') : v < -50 ? r('Deep bear-market drawdown') : r(`${Math.abs(v).toFixed(0)}% below ATH`);
    case 'ddDays10':
    case 'ddDays15':
    case 'ddDays20':
    case 'ddDays25':
    case 'ddDays30':
    case 'ddDays35':
      return pct >= 90 ? r('Unusually long calm stretch') : v <= 3 ? r('Pullback just happened') : r(`${v.toFixed(0)} days`);
    case 'exchNetflow':
      return v > 0 ? r('Net inflow to exchanges', 'bearish') : r('Net outflow from exchanges', 'bullish');
    case 'stableGrowth':
      return v > 2 ? r('Buying power expanding', 'bullish') : v < 0 ? r('Buying power shrinking', 'bearish') : r('Flat');
    case 'lsRatio':
      return v > 2.5 ? r('Retail heavily long', 'bearish') : v < 1 ? r('Retail net short', 'bullish') : r('Retail leaning long');
    case 'sma200':
    case 'sma50':
    case 'sthRealizedPrice':
    case 'realizedPrice':
      return r('');
  }
  if (pct >= 90) return r('Very high vs history');
  if (pct >= 70) return r('High vs history');
  if (pct <= 10) return r('Very low vs history');
  if (pct <= 30) return r('Low vs history');
  return r('Mid-range');
}

export function snapshot(ds: Dataset): MetricSnapshot[] {
  const price = ds.c[ds.n - 1];
  return METRICS.map((m) => {
    const x = ds.series.get(m.id);
    const empty: MetricSnapshot = {
      id: m.id, value: null, percentile: null, change7d: null, reading: 'No data yet', tone: 'neutral', since: null, lastFresh: null,
    };
    if (!x) return empty;
    let last = -1;
    for (let i = ds.n - 1; i >= Math.max(0, ds.n - 45); i--) {
      if (!Number.isNaN(x[i])) {
        last = i;
        break;
      }
    }
    if (last < 0) return empty;
    const value = x[last];
    let below = 0;
    let total = 0;
    let first = -1;
    for (let i = 0; i <= last; i++) {
      if (Number.isNaN(x[i])) continue;
      if (first < 0) first = i;
      total++;
      if (x[i] <= value) below++;
    }
    const percentile = total > 30 ? (below / total) * 100 : null;
    const prev = last >= 7 ? x[last - 7] : NaN;
    let { reading, tone } = describe(m.id, value, percentile ?? 50);
    if (m.id === 'sthBehavior') {
      const up = ds.series.get('sthBehaviorUpper')?.[last];
      const lo = ds.series.get('sthBehaviorLower')?.[last];
      if (up != null && value > up) [reading, tone] = ['Above +1σ: recent buyers stretched in profit', 'bearish'];
      else if (lo != null && value < lo) [reading, tone] = ['Below −1σ: recent buyers capitulating', 'bullish'];
      else [reading, tone] = ['Inside the ±1σ band', 'neutral'];
    }
    if (m.display === 'overlay' && m.unit === 'price') {
      const diff = (price / value - 1) * 100;
      reading = `Price ${diff >= 0 ? 'above' : 'below'} by ${Math.abs(diff).toFixed(1)}%`;
      tone = m.id.startsWith('bb') ? 'neutral' : diff >= 0 ? 'bullish' : 'bearish';
    }
    const freshT = ds.freshT.get(m.id);
    return {
      id: m.id,
      value,
      percentile,
      change7d: Number.isNaN(prev) ? null : value - prev,
      reading,
      tone,
      since: first >= 0 ? ds.t[first] : null,
      lastFresh: freshT != null && Number.isFinite(freshT) ? freshT : ds.t[last],
    };
  });
}

// ───────────────────────── service ─────────────────────────

/** Builds each timeframe's dataset lazily and rebuilds it whenever the store changed. */
export class DatasetService {
  private version = 1;
  private current = new Map<Timeframe, Dataset>();
  private building = new Map<Timeframe, Promise<Dataset | null>>();

  constructor(private store: Store) {}

  invalidate() {
    this.version++;
  }

  async get(tf: Timeframe = '1d'): Promise<Dataset | null> {
    const cached = this.current.get(tf);
    if (cached && cached.version === this.version) return cached;
    let job = this.building.get(tf);
    if (!job) {
      const version = this.version;
      job = (async () => {
        if (tf === '1d') return buildDaily(this.store, version);
        const daily = await this.get('1d');
        return daily ? buildFromDaily(this.store, daily, tf, version) : null;
      })()
        .then((ds) => {
          if (ds) this.current.set(tf, ds);
          return ds;
        })
        .finally(() => {
          this.building.delete(tf);
        });
      this.building.set(tf, job);
    }
    const built = await job;
    // If only part of the history has synced so far, keep serving the previous build.
    return built ?? this.current.get(tf) ?? null;
  }
}
