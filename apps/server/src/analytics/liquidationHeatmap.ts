import type { Candle, HeatmapWindow, LiquidationHeatmap } from '@smart-btc/shared';
import { EN, type T } from '../i18n/index.js';
import { fetchJson, ttlCache } from '../lib/http.js';
import { BINANCE_FUTURES } from '../providers/binance.js';
import type { Dataset } from './dataset.js';
import { liquidationPrice } from './leverage.js';

/**
 * Liquidation heatmap: where leveraged positions opened inside the chosen window would be force-closed,
 * through time (the Coinglass "Model 1" view), plus what is still outstanding at each price now.
 * An estimate from open interest and an assumed leverage mix, not exchange position data.
 */

/** Row height as a fraction of price (Coinglass draws bands about this thick), within these row limits. */
const HEAT_ROW_FRAC = 0.0008;
const HEAT_ROWS_MIN = 120;
const HEAT_ROWS_MAX = 360;

type OiPoint = { t: number; btc: number };

/**
 * Binance USD-M open interest (in BTC) at the given period, as far back as Binance serves it (30 days),
 * paged 500 rows at a time. Cached for a few minutes per period.
 */
const oiCaches = new Map<string, () => Promise<OiPoint[]>>();
function binanceOiHistory(period: '15m' | '1h' | '4h' | '1d'): Promise<OiPoint[]> {
  let load = oiCaches.get(period);
  if (!load) {
    load = ttlCache(5 * 60_000, async () => {
      const out = new Map<number, number>();
      const since = Date.now() - 30 * 86_400_000;
      let end = Date.now();
      for (let page = 0; page < 8 && end > since; page++) {
        const rows = await fetchJson<{ sumOpenInterest: string; timestamp: number }[]>(
          `${BINANCE_FUTURES}/futures/data/openInterestHist?symbol=BTCUSDT&period=${period}&limit=500&endTime=${end}`,
        ).catch(() => []);
        if (!rows.length) break;
        for (const r of rows) out.set(Math.floor(r.timestamp / 1000), +r.sumOpenInterest);
        const oldest = Math.min(...rows.map((r) => r.timestamp));
        if (oldest >= end) break;
        end = oldest - 1;
      }
      return [...out].map(([t, btc]) => ({ t, btc })).sort((a, b) => a.t - b.t);
    });
    oiCaches.set(period, load);
  }
  return load();
}

/**
 * Leverage tiers for the heatmap. Finer than the liquidity report's mix: the popular round leverages
 * each leave their own band, which is what makes the Coinglass map read as many separate levels.
 */
const HEAT_LEVERAGE: [lev: number, share: number][] = [
  [5, 0.06],
  [10, 0.18],
  [20, 0.16],
  [25, 0.16],
  [50, 0.16],
  [75, 0.1],
  [100, 0.12],
  [125, 0.06],
];

/** Points across a bar's range where its new positions are assumed to be entered. */
const ENTRY_POINTS = [0.1, 0.3, 0.5, 0.7, 0.9];

/**
 * Entry prices and weights for one bar: spread over its high-low range, heavier near the typical price
 * (where most of the volume trades) and never zero at the extremes.
 */
export function entryMix(h: number, l: number, c: number): [price: number, weight: number][] {
  const typical = (h + l + c) / 3;
  const range = h - l;
  if (!(range > 0)) return [[typical, 1]];
  const pts = ENTRY_POINTS.map((q) => {
    const p = l + range * q;
    return [p, Math.max(0.15, 1 - Math.abs(p - typical) / range)] as [number, number];
  });
  const sum = pts.reduce((s, [, w]) => s + w, 0);
  return pts.map(([p, w]) => [p, w / sum]);
}

/** Bar size and number of columns used for each heatmap window. */
const HEAT_WINDOWS: Record<HeatmapWindow, { tf: '15m' | '1h' | '4h' | '1d' | '1w'; cols: number }> = {
  '12h': { tf: '15m', cols: 48 },
  '24h': { tf: '15m', cols: 96 },
  '48h': { tf: '15m', cols: 192 },
  '3d': { tf: '15m', cols: 288 },
  '1w': { tf: '1h', cols: 168 },
  '2w': { tf: '1h', cols: 336 },
  '1m': { tf: '1h', cols: 720 },
  '3m': { tf: '4h', cols: 540 },
  '6m': { tf: '4h', cols: 1095 },
  '1y': { tf: '1d', cols: 365 },
  '2y': { tf: '1d', cols: 730 },
  '3y': { tf: '1d', cols: 1095 },
  '4y': { tf: '1d', cols: 1461 },
  All: { tf: '1d', cols: 100_000 },
};

/**
 * Per bar: notional (USD) of new positions, from rising open interest.
 * Open interest growth is the evidence of new leverage. The finest available source is used for
 * each bar: Binance OI at the bar's own period (last 30 days), else the daily open interest spread
 * over that day's bars by volume, else volume scaled by the OI-growth-per-dollar-traded ratio.
 */
async function positionFlows(ds: Dataset, daily: Dataset, tf: string, start: number) {
  const n = ds.n;
  const opened = new Float64Array(n).fill(NaN);

  // 1. Binance OI at this bar size (or hourly, for daily bars it is not needed).
  if (tf !== '1w') {
    const period = tf === '1d' ? '1d' : (tf as '15m' | '1h' | '4h');
    const pts = await binanceOiHistory(period).catch(() => [] as OiPoint[]);
    const at = new Map(pts.map((p) => [p.t, p.btc]));
    for (let i = Math.max(1, start); i < n; i++) {
      // Binance timestamps mark the end of each period: OI at the open of bar i and at its close.
      const a = at.get(ds.t[i]);
      const b = at.get(ds.t[i] + ds.barSec);
      if (a == null || b == null || a <= 0) continue;
      opened[i] = Math.max(0, b - a) * ds.c[i];
    }
  }

  // 2. Daily open interest (Bybit since 2020), in BTC so price moves do not look like new positions.
  const oiUsd = daily.series.get('oi');
  if (oiUsd) {
    const oiBtc = Array.from(oiUsd, (x, d) => x / daily.c[d]);
    const dayOf = (sec: number) => Math.floor((sec - daily.t[0]) / 86_400);
    // Volume of each day across this dataset's bars, to split the daily change between them.
    const dayVol = new Map<number, number>();
    const barsPerDay = Math.max(1, Math.round(86_400 / ds.barSec));
    for (let i = start; i < n; i++) {
      const d = dayOf(ds.t[i]);
      dayVol.set(d, (dayVol.get(d) ?? 0) + ds.v[i]);
    }
    for (let i = Math.max(1, start); i < n; i++) {
      if (!Number.isNaN(opened[i])) continue;
      const d = dayOf(ds.t[i]);
      if (d < 1 || d >= daily.n) continue;
      const a = oiBtc[d - 1];
      const b = oiBtc[d];
      if (!(a > 0) || !(b > 0)) continue;
      if (ds.barSec >= 86_400) {
        // Daily (or longer) bars: the change over the bar.
        const d1 = Math.min(daily.n - 1, dayOf(ds.t[i] + ds.barSec) - 1);
        const b1 = oiBtc[d1];
        const a0 = oiBtc[Math.max(0, d - 1)];
        if (!(b1 > 0) || !(a0 > 0)) continue;
        opened[i] = Math.max(0, b1 - a0) * ds.c[i];
      } else {
        const share = (dayVol.get(d) ?? 0) > 0 ? ds.v[i] / dayVol.get(d)! : 1 / barsPerDay;
        opened[i] = Math.max(0, b - a) * ds.c[i] * share;
      }
    }
  }

  // 3. No open interest at all (before 2020): volume times the observed OI growth per dollar traded.
  let sumOpened = 0;
  let sumVol = 0;
  for (let i = start; i < n; i++) {
    if (Number.isNaN(opened[i])) continue;
    sumOpened += opened[i];
    sumVol += ds.v[i] * ds.c[i];
  }
  const ratio = sumVol > 0 ? sumOpened / sumVol : 0.02;
  let fallback = 0;
  for (let i = start; i < n; i++) {
    if (!Number.isNaN(opened[i])) continue;
    opened[i] = ds.v[i] * ds.c[i] * ratio;
    fallback++;
  }
  return { opened, fallbackShare: n > start ? fallback / (n - start) : 1 };
}

/**
 * The liquidation estimate replayed bar by bar over the chosen window. Positions opened in a bar put a
 * liquidation level on the map for each leverage tier; the level stays until price trades through it.
 */
export async function liquidationHeatmap(window: HeatmapWindow, ds: Dataset, daily: Dataset, t: T = EN): Promise<LiquidationHeatmap> {
  const spec = HEAT_WINDOWS[window];
  const first = Math.max(0, ds.n - spec.cols);
  // Like Coinglass, only positions opened inside the window are drawn: the map starts empty on the left
  // and every band begins at the bar its positions were opened.
  const start = first;
  const cols = ds.n - first;
  const flows = await positionFlows(ds, daily, spec.tf, start);
  const { fallbackShare } = flows;
  // Leverage is opened on every bar, not only when net open interest rises (one trader's new position can
  // replace another's closed one). Half of the estimate follows traded volume, half the rise in open
  // interest, both scaled to the same total, so bars with real OI growth stand out without leaving the
  // rest of the map empty.
  let sumOi = 0;
  let sumVol = 0;
  for (let i = start; i < ds.n; i++) {
    sumOi += flows.opened[i];
    sumVol += ds.v[i] * ds.c[i];
  }
  const volRatio = sumVol > 0 ? sumOi / sumVol : 0;
  const opened = new Float64Array(ds.n);
  for (let i = start; i < ds.n; i++) opened[i] = 0.5 * flows.opened[i] + 0.5 * ds.v[i] * ds.c[i] * volRatio;

  // Price grid: the range traded in the window plus room for the nearest liquidation clusters, so the
  // rows stay fine enough to separate individual levels.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = first; i < ds.n; i++) {
    lo = Math.min(lo, ds.l[i]);
    hi = Math.max(hi, ds.h[i]);
  }
  const pad = Math.max((hi - lo) * 0.3, ds.c[ds.n - 1] * 0.03);
  const priceMin = Math.max(1, lo - pad);
  const span = hi + pad - priceMin;
  const R = Math.max(HEAT_ROWS_MIN, Math.min(HEAT_ROWS_MAX, Math.round(span / (ds.c[ds.n - 1] * HEAT_ROW_FRAC))));
  const priceStep = span / R;
  const rowOf = (p: number) => Math.floor((p - priceMin) / priceStep);

  // Outstanding long and short liquidation notional per price row, carried forward bar by bar.
  const longs = new Float64Array(R);
  const shorts = new Float64Array(R);
  const grid = new Float64Array(R * cols);
  for (let i = start; i < ds.n; i++) {
    // Price trading through a level liquidates it: longs at or above the low, shorts at or below the high.
    for (let r = Math.max(0, rowOf(ds.l[i])); r < R; r++) longs[r] = 0;
    for (let r = Math.min(R - 1, rowOf(ds.h[i])); r >= 0; r--) shorts[r] = 0;
    // New positions, half long and half short, entered across the bar's traded range (weighted toward its
    // typical price) rather than at one price: levels from bars that overlap pile up into thick bands where
    // price spent time, the way real clusters form, instead of one thin line per bar and leverage tier.
    const usd = opened[i] * 0.5;
    if (usd > 0) {
      for (const [entry, w] of entryMix(ds.h[i], ds.l[i], ds.c[i])) {
        for (const [lev, share] of HEAT_LEVERAGE) {
          const rl = rowOf(liquidationPrice(entry, lev, 'long'));
          const rs = rowOf(liquidationPrice(entry, lev, 'short'));
          if (rl >= 0 && rl < R) longs[rl] += usd * share * w;
          if (rs >= 0 && rs < R) shorts[rs] += usd * share * w;
        }
      }
    }
    if (i >= first) {
      const col = i - first;
      for (let r = 0; r < R; r++) grid[r * cols + col] = longs[r] + shorts[r];
    }
  }

  // Scale to the largest clusters (99.5th percentile, so a few outlier cells cannot wash out the rest); the
  // client's threshold then decides where the colour scale tops out, as on Coinglass.
  const nonZero = Array.from(grid).filter((x) => x > 0).sort((p, q) => p - q);
  const maxUsd = nonZero.length ? nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * 0.995))] : 1;
  const bytes = Buffer.alloc(grid.length);
  for (let k = 0; k < grid.length; k++) bytes[k] = Math.min(255, Math.round((grid[k] / maxUsd) * 255));

  const candles: Candle[] = [];
  for (let i = first; i < ds.n; i++) candles.push({ t: ds.t[i], o: ds.o[i], h: ds.h[i], l: ds.l[i], c: ds.c[i], v: ds.v[i] });

  const notes = [
    t('An estimate, not exchange data: new positions are inferred from rising open interest (Binance at the bar size for the last 30 days, daily Bybit open interest before that), split evenly between longs and shorts, entered across the range each bar traded and spread over an assumed leverage mix of 5× to 125×.'),
    t('A level is drawn from the bar its positions were opened until price trades through it. Only positions opened inside the chosen window are counted, so the map starts empty on the left; pick a longer window to see older levels.'),
  ];
  if (fallbackShare > 0.5) notes.push(t('No open-interest history covers most of this window, so new positions are estimated from traded volume alone.'));

  return {
    at: Date.now(),
    window,
    timeframe: spec.tf,
    t: ds.t.slice(first),
    priceMin,
    priceStep,
    rows: R,
    data: bytes.toString('base64'),
    maxUsd,
    candles,
    profile: { long: Array.from(longs, Math.round), short: Array.from(shorts, Math.round) },
    notes,
  };
}

export const HEATMAP_TIMEFRAME = (window: HeatmapWindow) => HEAT_WINDOWS[window].tf;
