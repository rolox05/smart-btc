import { DAY, TF_INFO, addBars, type Candle, type MetricSnapshot, type Timeframe, type Vars } from '@smart-btc/shared';
import { EN, type T } from '../i18n/index.js';
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
  /**
   * Index of the last bar that has closed. The final bar is usually still forming (today, this week,
   * this month); model inputs must come from closed bars, exactly like every bar the backtest scores.
   */
  lastClosed: number;
}

/** Index of the last bar whose close time has passed. */
export function lastClosedIndex(t: number[], tf: Timeframe, nowSec = Date.now() / 1000): number {
  let i = t.length - 1;
  while (i > 0 && addBars(tf, t[i], 1) > nowSec) i--;
  return i;
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

/**
 * One price history from several exchanges. The first set that has data is the backbone; the others
 * only add the days before it starts and after it ends, so an exchange that is switched off, blocked
 * or behind is covered without mixing prices inside the backbone's own span.
 */
export function mergeCandles(sets: Candle[][]): Candle[] {
  let out: Candle[] = [];
  for (const set of sets) {
    if (!set.length) continue;
    if (!out.length) {
      out = set;
      continue;
    }
    const first = out[0].t;
    const last = out[out.length - 1].t;
    out = [...set.filter((c) => c.t < first), ...out, ...set.filter((c) => c.t > last)];
  }
  return out;
}

/** Daily price sources: Binance first, then the others from the longest history to the shortest. */
const DAILY_SOURCES = ['binance', 'bitstamp', 'coinbase', 'kraken'];

async function buildDaily(store: Store, version: number): Promise<Dataset | null> {
  const sets = await Promise.all(DAILY_SOURCES.map((s) => store.getCandles(s, '1d')));
  const [bn, , cb] = sets;
  const merged = mergeCandles(sets);
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
    'cm.issUsd', 'cm.exSupply', 'cm.txCnt', 'cm.feesBtc', 'cm.price',
    'bybit.oi', 'bybit.lsRatio', 'binance.premium', 'hl.funding', 'deribit.putCall',
    'cftc.levNet', 'cftc.assetNet',
    'yahoo.dxy', 'yahoo.us10y', 'yahoo.nasdaq', 'yahoo.gold', 'yahoo.ibitVol',
    'bybit.funding', 'okx.funding', 'cm.hashrate', 'bc.hashrate', 'mp.hashrate', 'bc.txCnt',
    'fred.walcl', 'fred.tga', 'fred.rrp', 'fred.us10y',
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

  for (const pct of [10, 15, 20, 25, 30, 35, 40, 45, 50]) {
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
  // Coin Metrics publishes each day's figures a few hours after the day closes, so model inputs built
  // on them use the previous day's value: exactly what was available at the close.
  features.set('mvrv', lag(ln(mvrv), 1));
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
  features.set('exchNetflow', lag(netflow, 1));
  fresh.set('exchNetflow', lastValid(netflowRaw));

  // ── derivatives ──
  const fSum = new Float64Array(n);
  const fCnt = new Float64Array(n);
  // Binance is the reference venue; if it is off or empty, the next venue with data stands in.
  const fundingRaw = [raw['binance.funding'], raw['bybit.funding'], raw['okx.funding']].find((pts) => pts.length > 0) ?? [];
  for (const p of fundingRaw) {
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
  // Perp premium over spot: Binance premium index, 7-day average, in %.
  const premRaw = align(raw['binance.premium']);
  const premium = map(sma(ffill(premRaw, 2), 7), (a) => a * 100);
  series.set('premium', premium);
  features.set('premium', premium);
  fresh.set('premium', lastValid(premRaw));

  // Hyperliquid pays funding hourly: average the hourly rates per day, then 7 days, annualised in %.
  const hlSum = new Float64Array(n);
  const hlCnt = new Float64Array(n);
  for (const p of raw['hl.funding']) {
    const i = Math.floor((p.t - t0) / DAY);
    if (i < 0 || i >= n) continue;
    hlSum[i] += p.v;
    hlCnt[i] += 1;
  }
  const hlSum7 = rollingSum(hlSum, 7);
  const hlCnt7 = rollingSum(hlCnt, 7);
  const hlFunding = map(hlSum7, (x, i) => (hlCnt7[i] >= 72 ? (x / hlCnt7[i]) * 24 * 365 * 100 : NaN));
  series.set('hlFunding', hlFunding);
  fresh.set('hlFunding', lastValid(hlFunding));

  // Open interest: Bybit (daily since 2020, in BTC), shown in USD; Binance's 30-day series fills in if Bybit is missing.
  const oiBtc = ffill(align(raw['bybit.oi']), 3);
  const binanceOi = ffill(align(raw['binance.oi']), 2);
  const oiUsd = map(c, (px, i) => (Number.isNaN(oiBtc[i]) ? binanceOi[i] : oiBtc[i] * px));
  series.set('oi', oiUsd);
  fresh.set('oi', lastValid(align(raw['bybit.oi'])));
  const oiChange30 = pctChange(oiBtc, 30);
  series.set('oiChange30', oiChange30);
  features.set('oiChange30', oiChange30);
  fresh.set('oiChange30', lastValid(align(raw['bybit.oi'])));

  // Long/short ratio: Bybit (since 2020), with Binance filling any day Bybit lacks.
  const lsBybit = align(raw['bybit.lsRatio']);
  const lsBinance = align(raw['binance.lsRatio']);
  const lsBybitFilled = ffill(lsBybit, 2);
  const lsBinanceFilled = ffill(lsBinance, 2);
  const lsRatio = Float64Array.from(lsBinanceFilled);
  for (let i = 0; i < n; i++) if (!Number.isNaN(lsBybitFilled[i])) lsRatio[i] = lsBybitFilled[i];
  series.set('lsRatio', lsRatio);
  features.set('lsRatio', ln(lsBybitFilled));
  fresh.set('lsRatio', Math.max(lastValid(lsBybit), lastValid(lsBinance)));

  const putCallRaw = align(raw['deribit.putCall']);
  series.set('putCall', ffill(putCallRaw, 2));
  fresh.set('putCall', lastValid(putCallRaw));

  // CFTC report values are stored on their publication day and carried until the next report.
  const levRaw = align(raw['cftc.levNet']);
  const cotLevNet = ffill(levRaw, 10);
  series.set('cotLevNet', cotLevNet);
  features.set('cotLevNet', cotLevNet);
  fresh.set('cotLevNet', lastValid(levRaw));
  const assetRaw = align(raw['cftc.assetNet']);
  series.set('cotAssetNet', ffill(assetRaw, 10));
  fresh.set('cotAssetNet', lastValid(assetRaw));

  // ── more on-chain: Puell multiple, exchange balances, activity, fees ──
  const issRaw = align(raw['cm.issUsd']);
  const iss = ffill(issRaw, 3);
  const puell = map(sma(iss, 365), (avg, i) => iss[i] / avg);
  series.set('puell', puell);
  features.set('puell', lag(ln(puell), 1));
  fresh.set('puell', lastValid(issRaw));

  const exRaw = align(raw['cm.exSupply']);
  const supplyFilled = ffill(cmSupply, 5);
  const exSupply = map(ffill(exRaw, 5), (x, i) => (x / supplyFilled[i]) * 100);
  series.set('exSupply', exSupply);
  // As a model input, the 30-day change matters more than the slowly drifting level.
  features.set('exSupply', lag(map(exSupply, (x, i) => (i >= 30 ? x - exSupply[i - 30] : NaN)), 1));
  fresh.set('exSupply', lastValid(exRaw));

  // First source that has a value on the day: the main one, then its stand-ins.
  const firstOf = (...xs: Arr[]): Arr => {
    const out = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      for (const x of xs) {
        if (!Number.isNaN(x[i])) {
          out[i] = x[i];
          break;
        }
      }
    }
    return out;
  };

  const txRaw = firstOf(align(raw['cm.txCnt']), align(raw['bc.txCnt']));
  series.set('txCount', sma(ffill(txRaw, 3), 30));
  fresh.set('txCount', lastValid(txRaw));
  const feesRaw = align(raw['cm.feesBtc']);
  series.set('fees', sma(map(ffill(feesRaw, 3), (f, i) => f * c[i]), 7));
  fresh.set('fees', lastValid(feesRaw));

  // Hash ribbon: 30-day over 60-day average hash rate. Below 1 the network is shrinking, which has
  // happened when miners switch off unprofitable machines.
  const hashRaw = firstOf(align(raw['cm.hashrate']), align(raw['bc.hashrate']), align(raw['mp.hashrate']));
  const hash = ffill(hashRaw, 3);
  const sma60 = sma(hash, 60);
  const hashRibbon = map(sma(hash, 30), (a, i) => a / sma60[i]);
  series.set('hashRibbon', hashRibbon);
  features.set('hashRibbon', lag(ln(hashRibbon), 1));
  fresh.set('hashRibbon', lastValid(hashRaw));

  // Coinbase premium: the US dollar price on Coinbase against the tether price on Binance, closed days
  // only (the two feeds are read at different moments during the day), 7-day average, in %.
  const lastClosedDay = lastClosedIndex(t, '1d');
  const cbClose = align(cb.map((k) => ({ t: k.t, v: k.c })));
  const bnClose = align(bn.map((k) => ({ t: k.t, v: k.c })));
  const cbRaw = map(cbClose, (a, i) => (i <= lastClosedDay && bnClose[i] > 0 ? (a / bnClose[i] - 1) * 100 : NaN));
  const cbPremium = sma(ffill(cbRaw, 2), 7);
  series.set('cbPremium', cbPremium);
  features.set('cbPremium', cbPremium);
  fresh.set('cbPremium', lastValid(cbRaw));

  // Net dollar liquidity: the Fed's balance sheet minus the Treasury's cash account and the reverse-repo
  // facility. Weekly figures are stored on their publication day and carried until the next one.
  const walclRaw = align(raw['fred.walcl']);
  const walcl = ffill(walclRaw, 10);
  const tga = ffill(align(raw['fred.tga']), 10);
  const rrp = ffill(align(raw['fred.rrp']), 6);
  const netLiq = map(walcl, (a, i) => a - tga[i] - rrp[i]);
  series.set('netLiquidity', netLiq);
  features.set('netLiquidity', pctChange(netLiq, 90));
  fresh.set('netLiquidity', lastValid(walclRaw));

  // ── macro (Yahoo Finance): markets close at weekends, so values carry over up to 4 days ──
  const dxyRaw = align(raw['yahoo.dxy']);
  const dxy = ffill(dxyRaw, 4);
  series.set('dxy', dxy);
  features.set('dxy', pctChange(dxy, 30));
  fresh.set('dxy', lastValid(dxyRaw));
  const tnxRaw = firstOf(align(raw['yahoo.us10y']), align(raw['fred.us10y']));
  const us10y = ffill(tnxRaw, 4);
  series.set('us10y', us10y);
  features.set('us10y', map(us10y, (x, i) => (i >= 30 ? x - us10y[i - 30] : NaN)));
  fresh.set('us10y', lastValid(tnxRaw));
  const ndxRaw = align(raw['yahoo.nasdaq']);
  const nasdaqMom = pctChange(ffill(ndxRaw, 4), 30);
  series.set('nasdaqMom', nasdaqMom);
  features.set('nasdaqMom', nasdaqMom);
  fresh.set('nasdaqMom', lastValid(ndxRaw));
  const goldRaw = align(raw['yahoo.gold']);
  const goldMom = pctChange(ffill(goldRaw, 4), 30);
  series.set('goldMom', goldMom);
  features.set('goldMom', goldMom);
  fresh.set('goldMom', lastValid(goldRaw));
  const ibitRaw = align(raw['yahoo.ibitVol']);
  // Weekend days count as zero-volume days would distort the average, so average trading days only.
  const ibitTrading = new Float64Array(n).fill(NaN);
  {
    const vals: number[] = [];
    let lastTrade = -Infinity;
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(ibitRaw[i])) {
        vals.push(ibitRaw[i]);
        if (vals.length > 20) vals.shift();
        lastTrade = i;
      }
      if (vals.length >= 10 && i - lastTrade <= 4) ibitTrading[i] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
  }
  series.set('ibitVolume', ibitTrading);
  fresh.set('ibitVolume', lastValid(ibitRaw));

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
    lastClosed: lastClosedIndex(t, '1d'),
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
    lastClosed: lastClosedIndex(t, tf),
  };
}

// ───────────────────────── snapshot ─────────────────────────

function describe(id: string, v: number, pct: number, t: T): { reading: string; tone: MetricSnapshot['tone'] } {
  const r = (reading: string, tone: MetricSnapshot['tone'] = 'neutral', vars?: Vars) => ({ reading: reading ? t(reading, vars) : '', tone });
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
      return v > -5 ? r('At / near all-time high', 'bullish') : v < -50 ? r('Deep bear-market drawdown') : r('{pct}% below ATH', 'neutral', { pct: Math.abs(v).toFixed(0) });
    case 'ddDays10':
    case 'ddDays15':
    case 'ddDays20':
    case 'ddDays25':
    case 'ddDays30':
    case 'ddDays35':
    case 'ddDays40':
    case 'ddDays45':
    case 'ddDays50':
      return pct >= 90 ? r('Unusually long calm stretch') : v <= 3 ? r('Pullback just happened') : r('{n} days', 'neutral', { n: v.toFixed(0) });
    case 'exchNetflow':
      return v > 0 ? r('Net inflow to exchanges', 'bearish') : r('Net outflow from exchanges', 'bullish');
    case 'stableGrowth':
      return v > 2 ? r('Buying power expanding', 'bullish') : v < 0 ? r('Buying power shrinking', 'bearish') : r('Flat');
    case 'puell':
      if (v >= 4) return r('Miners in a historic top zone', 'bearish');
      if (v <= 0.5) return r('Miner capitulation zone', 'bullish');
      return v >= 1.5 ? r('Miners earning above average') : v < 0.8 ? r('Miners earning below average') : r('Normal');
    case 'premium':
      if (v > 0.05) return r('Perps at a rich premium', 'bearish');
      return v < 0 ? r('Perps at a discount to spot', 'bullish') : r('Normal');
    case 'oiChange30':
      if (v > 20) return r('Leverage building fast', 'bearish');
      return v < -20 ? r('Leverage flushed out', 'bullish') : r('Normal');
    case 'putCall':
      return v > 1 ? r('More puts than calls') : v < 0.6 ? r('Call-heavy positioning') : r('Balanced');
    case 'cotLevNet':
      return v < -20 ? r('Leveraged funds heavily short') : v > 20 ? r('Leveraged funds heavily long') : r('Neutral');
    case 'hashRibbon':
      return v < 1 ? r('Hash rate shrinking: miners under stress') : v > 1.03 ? r('Hash rate growing fast') : r('Hash rate growing');
    case 'cbPremium':
      if (v > 0.08) return r('US buyers paying up', 'bullish');
      return v < -0.08 ? r('US sellers pressing', 'bearish') : r('Balanced');
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

export function snapshot(ds: Dataset, t: T = EN): MetricSnapshot[] {
  const price = ds.c[ds.n - 1];
  return METRICS.map((m) => {
    const x = ds.series.get(m.id);
    const empty: MetricSnapshot = {
      id: m.id, value: null, percentile: null, change7d: null, reading: t('No data yet'), tone: 'neutral', since: null, lastFresh: null,
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
    let { reading, tone } = describe(m.id, value, percentile ?? 50, t);
    if (m.id === 'sthBehavior') {
      const up = ds.series.get('sthBehaviorUpper')?.[last];
      const lo = ds.series.get('sthBehaviorLower')?.[last];
      if (up != null && value > up) [reading, tone] = [t('Above +1σ: recent buyers stretched in profit'), 'bearish'];
      else if (lo != null && value < lo) [reading, tone] = [t('Below −1σ: recent buyers capitulating'), 'bullish'];
      else [reading, tone] = [t('Inside the ±1σ band'), 'neutral'];
    }
    if (m.display === 'overlay' && m.unit === 'price') {
      const diff = (price / value - 1) * 100;
      reading = t(diff >= 0 ? 'Price above by {pct}%' : 'Price below by {pct}%', { pct: Math.abs(diff).toFixed(1) });
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
