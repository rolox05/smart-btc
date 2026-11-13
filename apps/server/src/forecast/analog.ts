import type { ForecastSettings } from '@smart-btc/shared';
import type { Dataset } from '../analytics/dataset.js';
import type { Arr } from '../analytics/indicators.js';
import { METRIC_BY_ID } from '../analytics/metrics.js';
import { clamp } from './stats.js';

/**
 * The analog model.
 *
 * "Today" is described by a vector of features (RSI, days without a pullback, STH-MVRV, ...).
 * We look for the k most similar days in history, de-clustered so that one episode cannot
 * dominate, and treat what price did after each of them as one sample of what may happen next.
 * All probabilities, targets and timings reported by the app are weighted statistics of those samples.
 *
 * Nothing here looks ahead: a day is only eligible as an analog for date q if its whole
 * forward window had already played out by q. The backtest relies on that property.
 */

/** Per-horizon forward statistics, precomputed once per dataset. All in log-return space. */
export interface Prepared {
  H: number;
  logC: Arr;
  logH: Arr;
  logL: Arr;
  /** ln(close[i+H] / close[i]) */
  fwd: Arr;
  /** ln(max high over (i, i+H] / close[i]) */
  mx: Arr;
  /** ln(min low over (i, i+H] / close[i]) */
  mn: Arr;
}

export function prepare(ds: Dataset, H: number): Prepared {
  const n = ds.n;
  const logC = Float64Array.from(ds.c, Math.log);
  const logH = Float64Array.from(ds.h, Math.log);
  const logL = Float64Array.from(ds.l, Math.log);
  const fwd = new Float64Array(n).fill(NaN);
  const mx = new Float64Array(n).fill(NaN);
  const mn = new Float64Array(n).fill(NaN);
  for (let i = 0; i + H < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let d = 1; d <= H; d++) {
      if (logH[i + d] > hi) hi = logH[i + d];
      if (logL[i + d] < lo) lo = logL[i + d];
    }
    fwd[i] = logC[i + H] - logC[i];
    mx[i] = hi - logC[i];
    mn[i] = lo - logC[i];
  }
  return { H, logC, logH, logL, fwd, mx, mn };
}

export interface FeatureModel {
  ids: string[];
  cols: Arr[];
  /** 1 where every selected feature has a value. */
  complete: Uint8Array;
  /** First index allowed by `startYear`. */
  start: number;
  /** Expanding count / sum / sum of squares per feature, for past-only standardisation. */
  pn: Float64Array[];
  ps: Float64Array[];
  ps2: Float64Array[];
}

export function buildModel(
  ds: Dataset,
  ids: string[],
  startYear: number,
): { model: FeatureModel; dropped: { id: string; reason: string }[] } {
  const n = ds.n;
  const startT = Date.UTC(startYear, 0, 1) / 1000;
  let start = ds.t.findIndex((t) => t >= startT);
  if (start < 0) start = 0;

  const dropped: { id: string; reason: string }[] = [];
  const used: string[] = [];
  const cols: Arr[] = [];
  for (const id of [...new Set(ids)]) {
    const def = METRIC_BY_ID.get(id);
    const col = ds.features.get(id);
    if (!def?.forecastable || !col) {
      dropped.push({ id, reason: 'not usable as a model feature' });
      continue;
    }
    if (Number.isNaN(col[n - 1])) {
      dropped.push({ id, reason: 'no current value (data source unavailable or still syncing)' });
      continue;
    }
    let valid = 0;
    for (let i = start; i < n; i++) if (!Number.isNaN(col[i])) valid++;
    if (valid < Math.min(400, Math.floor((n - start) * 0.5))) {
      dropped.push({ id, reason: `only ${valid} bars of history` });
      continue;
    }
    used.push(id);
    cols.push(col);
  }

  const complete = new Uint8Array(n);
  for (let i = start; i < n; i++) {
    let ok = 1;
    for (const col of cols) {
      if (Number.isNaN(col[i])) {
        ok = 0;
        break;
      }
    }
    complete[i] = ok;
  }
  const pn: Float64Array[] = [];
  const ps: Float64Array[] = [];
  const ps2: Float64Array[] = [];
  for (const col of cols) {
    const a = new Float64Array(n + 1);
    const b = new Float64Array(n + 1);
    const c = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const ok = i >= start && !Number.isNaN(col[i]);
      a[i + 1] = a[i] + (ok ? 1 : 0);
      b[i + 1] = b[i] + (ok ? col[i] : 0);
      c[i + 1] = c[i] + (ok ? col[i] * col[i] : 0);
    }
    pn.push(a);
    ps.push(b);
    ps2.push(c);
  }
  return { model: { ids: used, cols, complete, start, pn, ps, ps2 }, dropped };
}

/** Mean and standard deviation of feature f using only data up to and including index q. */
export function featureStats(model: FeatureModel, f: number, q: number): { mean: number; sd: number } {
  const cnt = model.pn[f][q + 1];
  if (cnt < 30) return { mean: 0, sd: 1 };
  const mean = model.ps[f][q + 1] / cnt;
  const sd = Math.sqrt(Math.max(1e-12, model.ps2[f][q + 1] / cnt - mean * mean));
  return { mean, sd };
}

export interface Neighbors {
  idx: number[];
  dist: number[];
  /** Normalised weights (sum to 1). */
  w: number[];
  /** Volatility rescaling factor applied to each analog's forward path. */
  scale: number[];
  candidates: number;
  effectiveN: number;
  avgDistance: number;
}

export interface Scratch {
  dist: Float64Array;
  order: Uint32Array;
}
export const makeScratch = (n: number): Scratch => ({ dist: new Float64Array(n), order: new Uint32Array(n) });

/** Factor that maps an analog's volatility regime onto the query date's. */
export function volScale(ds: Dataset, q: number, i: number, enabled: boolean): number {
  if (!enabled) return 1;
  const a = ds.vol90[q];
  const b = ds.vol90[i];
  if (!(a > 0) || !(b > 0)) return 1;
  return clamp(a / b, 0.4, 2.5);
}

/**
 * Find the analogs of day `q` among days `<= maxCand`.
 * Distance is the root-mean-square z-score difference over the selected features.
 */
export function findNeighbors(
  ds: Dataset,
  model: FeatureModel,
  prep: Prepared,
  q: number,
  maxCand: number,
  s: ForecastSettings,
  scratch: Scratch,
): Neighbors | null {
  const F = model.cols.length;
  if (F === 0 || !model.complete[q]) return null;
  const { dist, order } = scratch;

  const inv = new Float64Array(F);
  const qv = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    inv[f] = 1 / featureStats(model, f, q).sd;
    qv[f] = model.cols[f][q];
  }

  let m = 0;
  const stride = ds.stride;
  for (let i = Math.ceil(model.start / stride) * stride; i <= maxCand; i += stride) {
    if (!model.complete[i] || Number.isNaN(prep.fwd[i])) continue;
    let d2 = 0;
    for (let f = 0; f < F; f++) {
      const z = (model.cols[f][i] - qv[f]) * inv[f];
      d2 += z * z;
    }
    dist[i] = Math.sqrt(d2 / F);
    order[m++] = i;
  }
  if (m < 30) return null;
  const cand = order.subarray(0, m);
  cand.sort((a, b) => dist[a] - dist[b]);

  // Greedy pick of the closest bars that are at least `minGapBars` apart from each other.
  const k = Math.min(s.k, m);
  const gap = Math.max(1, s.minGapBars);
  const idx: number[] = [];
  for (let j = 0; j < m && idx.length < k; j++) {
    const i = cand[j];
    let ok = true;
    for (let p = 0; p < idx.length; p++) {
      if (Math.abs(idx[p] - i) < gap) {
        ok = false;
        break;
      }
    }
    if (ok) idx.push(i);
  }

  // Gaussian kernel on distance (bandwidth = the furthest analog), optionally decayed by age.
  const bandwidth = dist[idx[idx.length - 1]] || 1;
  const w: number[] = [];
  const d: number[] = [];
  const scale: number[] = [];
  let wSum = 0;
  let dSum = 0;
  for (const i of idx) {
    let wi = Math.exp(-0.5 * (dist[i] / bandwidth) ** 2);
    if (s.recencyHalfLifeYears > 0) wi *= Math.pow(0.5, ((q - i) * ds.barDays) / 365.25 / s.recencyHalfLifeYears);
    w.push(wi);
    d.push(dist[i]);
    scale.push(volScale(ds, q, i, s.volAdjust));
    wSum += wi;
    dSum += dist[i];
  }
  let w2 = 0;
  for (let j = 0; j < w.length; j++) {
    w[j] /= wSum;
    w2 += w[j] * w[j];
  }
  return { idx, dist: d, w, scale, candidates: m, effectiveN: 1 / w2, avgDistance: dSum / idx.length };
}

/** Expected size of the move over the horizon (one standard deviation, %) at the volatility of bar q. */
export function horizonSigma(ds: Dataset, q: number, horizon: number): number {
  const vol = ds.series.get('vol30')?.[q];
  const annual = vol && vol > 0 ? vol : 50;
  return (annual / Math.sqrt(ds.barsPerYear)) * Math.sqrt(horizon);
}

const NICE = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20];
/** Nearest "round" percentage to x, so ladders read 0.5 / 1 / 2.5 rather than 0.43 / 0.87. */
export function nicePct(x: number): number {
  let best = NICE[0];
  for (const c of NICE) if (Math.abs(Math.log(c / x)) < Math.abs(Math.log(best / x))) best = c;
  return best;
}

/**
 * One step of the price ladder used for touch levels and stop/target grids: a quarter of the
 * expected move, rounded. It scales with timeframe and horizon - about 0.2% for 4 hours, 2.5% for 30 days.
 */
export function moveUnit(ds: Dataset, q: number, horizon: number): number {
  return nicePct(horizonSigma(ds, q, horizon) / 4);
}

/** Scenario threshold in %: either the user's, or half the expected horizon move at today's volatility. */
export function scenarioThreshold(ds: Dataset, q: number, s: ForecastSettings): number {
  if (s.scenarioThresholdPct > 0) return s.scenarioThresholdPct;
  return nicePct(horizonSigma(ds, q, s.horizon) / 2);
}

/** Per-(dataset, horizon) cache of forward statistics. */
export class PreparedCache {
  private cache = new Map<string, Prepared>();
  get(ds: Dataset, H: number): Prepared {
    const key = `${ds.version}:${H}`;
    let p = this.cache.get(key);
    if (!p) {
      if (this.cache.size > 12) this.cache.clear();
      p = prepare(ds, H);
      this.cache.set(key, p);
    }
    return p;
  }
}
