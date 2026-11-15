import type { EventOverlay, ForecastSettings, ModelOutlook, ModelWeight, ModelsReport } from '@smart-btc/shared';
import type { Dataset } from '../analytics/dataset.js';
import { EN, type T } from '../i18n/index.js';
import { baseWeight, buildModel, findNeighbors, makeScratch, scenarioThreshold, termVol, volArrays, type Prepared } from './analog.js';
import { baseSample, mixSamples, type Sample } from './forecast.js';
import { clamp } from './stats.js';

/**
 * Three forecasting models, scored side by side with the same walk-forward test.
 *
 *  analog    Nearest historical analogs (the app's original model).
 *  quantile  Linear quantile regression (Koenker & Bassett, 1978): each quantile of the horizon
 *            return is a weighted sum of the inputs, so it shows how much every input moves the
 *            low, middle and high end of the forecast. It also takes the macro inputs.
 *  trend     Time-series momentum drift (Moskowitz, Ooi & Pedersen, 2012; for Bitcoin, Liu &
 *            Tsyvinski, 2021) on top of filtered historical simulation (Barone-Adesi et al., 1999):
 *            past returns are standardised by the volatility forecast of their day (GARCH-style
 *            term structure) and rescaled to today's.
 *
 * All three predict the same thing: the distribution of the log return over the next H bars. Every
 * fit uses only bars whose forward window had closed by the forecast bar.
 */

/** A predictive distribution of the H-bar log return. */
export interface Dist {
  cdf(x: number): number;
  quantile(p: number): number;
}

/** Distribution of a weighted sample. */
export function sampleDist(values: ArrayLike<number>, weights?: ArrayLike<number>): Dist {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const v = new Float64Array(n);
  const cum = new Float64Array(n);
  let total = 0;
  for (let j = 0; j < n; j++) {
    v[j] = values[order[j]];
    total += weights ? weights[order[j]] : 1;
    cum[j] = total;
  }
  const upper = (x: number) => {
    // Number of sorted values <= x.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (v[m] <= x) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  return {
    cdf: (x) => (n === 0 ? NaN : upper(x) === 0 ? 0 : cum[upper(x) - 1] / total),
    quantile: (p) => {
      if (n === 0) return NaN;
      const target = clamp(p, 0, 1) * total;
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (cum[m] >= target) hi = m;
        else lo = m + 1;
      }
      return v[lo];
    },
  };
}

/** Distribution given by quantiles on a grid of probabilities, linear in between and in the tails. */
export function gridDist(taus: number[], qs: number[]): Dist {
  const n = taus.length;
  // Fitted quantiles can cross by a hair: sort them (the standard rearrangement fix).
  const q = [...qs].sort((a, b) => a - b);
  const slopeLo = (q[1] - q[0]) / (taus[1] - taus[0]);
  const slopeHi = (q[n - 1] - q[n - 2]) / (taus[n - 1] - taus[n - 2]);
  const quantile = (p: number) => {
    if (p <= taus[0]) return q[0] - slopeLo * (taus[0] - p);
    if (p >= taus[n - 1]) return q[n - 1] + slopeHi * (p - taus[n - 1]);
    let k = 1;
    while (taus[k] < p) k++;
    const f = (p - taus[k - 1]) / (taus[k] - taus[k - 1]);
    return q[k - 1] + f * (q[k] - q[k - 1]);
  };
  const cdf = (x: number) => {
    if (x <= q[0]) return slopeLo > 0 ? clamp(taus[0] - (q[0] - x) / slopeLo, 0, taus[0]) : 0;
    if (x >= q[n - 1]) return slopeHi > 0 ? clamp(taus[n - 1] + (x - q[n - 1]) / slopeHi, taus[n - 1], 1) : 1;
    let k = 1;
    while (q[k] < x) k++;
    const span = q[k] - q[k - 1];
    return taus[k - 1] + (span > 0 ? (x - q[k - 1]) / span : 0) * (taus[k] - taus[k - 1]);
  };
  return { cdf, quantile };
}

// ───────────────────────── features ─────────────────────────

interface FeatureDef {
  id: string;
  name: string;
  col: Float64Array;
  /** Used by the trend model as well as the quantile regression. */
  trend: boolean;
}

/**
 * Dataset series the regressions may read, besides the price-based inputs built below.
 * Spot-ETF flows and volume are deliberately absent, and must stay absent: ETF buyers chase rallies
 * and sell into drops (FOMO and FUD), so an inflow is not a buy signal and an outflow is not a sell
 * signal. ETF activity is shown as context in the Events tab only. A test enforces this.
 */
export const DATASET_INPUTS = ['rsi14', 'ddAth', 'funding', 'dxy', 'us10y', 'nasdaqMom', 'fng'] as const;

const featureCache = new WeakMap<Dataset, { cols: Map<string, Float64Array> }>();

/** Model inputs known at the close of each bar. Price-based ones are built here; the rest come from the dataset. */
function featureColumns(ds: Dataset) {
  let cached = featureCache.get(ds);
  if (cached) return cached.cols;
  const n = ds.n;
  const { ewma, long } = volArrays(ds);
  const logC = Float64Array.from(ds.c, Math.log);
  const cols = new Map<string, Float64Array>();
  // Momentum as a t-statistic: the move over the lookback divided by what volatility would explain.
  for (const L of [7, 30, 90]) {
    const col = new Float64Array(n).fill(NaN);
    for (let i = L; i < n; i++) if (ewma[i] > 0) col[i] = (logC[i] - logC[i - L]) / Math.sqrt(ewma[i] * L);
    cols.set(`mom${L}`, col);
  }
  const regime = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (ewma[i] > 0 && long[i] > 0) regime[i] = 0.5 * Math.log(ewma[i] / long[i]);
  cols.set('volRegime', regime);
  for (const id of DATASET_INPUTS) {
    const col = ds.features.get(id);
    if (col) cols.set(id, col);
  }
  cached = { cols };
  featureCache.set(ds, cached);
  return cols;
}

function featureDefs(ds: Dataset, t: T): FeatureDef[] {
  const cols = featureColumns(ds);
  const defs: [id: string, name: string, trend: boolean][] = [
    ['mom7', t('Momentum, 7 bars'), true],
    ['mom30', t('Momentum, 30 bars'), true],
    ['mom90', t('Momentum, 90 bars'), true],
    ['volRegime', t('Volatility vs its yearly level'), true],
    ['rsi14', t('RSI'), false],
    ['ddAth', t('Distance from the all-time high'), false],
    ['funding', t('Perpetual funding'), false],
    ['dxy', t('US dollar index, 30-day change'), false],
    ['us10y', t('US 10-year yield, 30-day change'), false],
    ['nasdaqMom', t('Nasdaq momentum'), false],
    ['fng', t('Fear & Greed'), false],
  ];
  return defs.flatMap(([id, name, trend]) => (cols.has(id) ? [{ id, name, col: cols.get(id)!, trend }] : []));
}

// ───────────────────────── fitting ─────────────────────────

/** Solve A x = b for a small dense system (Gaussian elimination with partial pivoting). */
function solve(A: Float64Array, b: Float64Array, p: number): Float64Array {
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let c = 0; c < p; c++) {
    let piv = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(M[r * p + c]) > Math.abs(M[piv * p + c])) piv = r;
    if (Math.abs(M[piv * p + c]) < 1e-12) continue;
    if (piv !== c) {
      for (let k = 0; k < p; k++) [M[c * p + k], M[piv * p + k]] = [M[piv * p + k], M[c * p + k]];
      [x[c], x[piv]] = [x[piv], x[c]];
    }
    for (let r = c + 1; r < p; r++) {
      const f = M[r * p + c] / M[c * p + c];
      if (f === 0) continue;
      for (let k = c; k < p; k++) M[r * p + k] -= f * M[c * p + k];
      x[r] -= f * x[c];
    }
  }
  for (let c = p - 1; c >= 0; c--) {
    let acc = x[c];
    for (let k = c + 1; k < p; k++) acc -= M[c * p + k] * x[k];
    x[c] = Math.abs(M[c * p + c]) < 1e-12 ? 0 : acc / M[c * p + c];
  }
  return x;
}

/** Ridge least squares; the intercept (column 0) is not penalised. */
export function fitRidge(X: Float64Array, y: Float64Array, n: number, p: number, lambda: number): Float64Array {
  const A = new Float64Array(p * p);
  const g = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    const o = i * p;
    for (let a = 0; a < p; a++) {
      const xa = X[o + a];
      g[a] += xa * y[i];
      for (let b = 0; b <= a; b++) A[a * p + b] += xa * X[o + b];
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < a; b++) A[b * p + a] = A[a * p + b];
    if (a > 0) A[a * p + a] += lambda;
  }
  return solve(A, g, p);
}

/**
 * Linear quantile regression by the Hunter-Lange MM algorithm: each step is a weighted least-squares
 * solve that lowers the (slightly smoothed) pinball loss. `beta0` warm-starts from a previous fit.
 */
export function fitQuantile(X: Float64Array, y: Float64Array, n: number, p: number, tau: number, lambda: number, beta0?: Float64Array, iters = 30): Float64Array {
  const beta = beta0 ? Float64Array.from(beta0) : new Float64Array(p);
  const A = new Float64Array(p * p);
  const g = new Float64Array(p);
  const eps = 1e-3;
  for (let it = 0; it < iters; it++) {
    A.fill(0);
    g.fill(0);
    for (let i = 0; i < n; i++) {
      const o = i * p;
      let fit = 0;
      for (let a = 0; a < p; a++) fit += X[o + a] * beta[a];
      const r = y[i] - fit;
      const w = 1 / (eps + Math.abs(r));
      const v = 1 - 2 * tau - r * w;
      for (let a = 0; a < p; a++) {
        const xa = X[o + a];
        g[a] += xa * v;
        const wx = w * xa;
        for (let b = 0; b <= a; b++) A[a * p + b] += wx * X[o + b];
      }
    }
    for (let a = 0; a < p; a++) {
      for (let b = 0; b < a; b++) A[b * p + a] = A[a * p + b];
      if (a > 0) {
        A[a * p + a] += lambda;
        g[a] += lambda * beta[a];
      }
    }
    const delta = solve(A, g, p);
    let move = 0;
    for (let a = 0; a < p; a++) {
      beta[a] -= delta[a];
      move = Math.max(move, Math.abs(delta[a]));
    }
    if (move < 1e-4) break;
  }
  return beta;
}

const TAUS = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
const VOL_PERSISTENCE = 0.98;

interface Fit {
  /** Past-only mean and standard deviation of each input. */
  mean: Float64Array;
  sd: Float64Array;
  /** Quantile-regression coefficients per tau (intercept first), on all inputs. */
  qr: Float64Array[];
  /** Trend-model coefficients (intercept first) on the trend inputs, and its residuals. */
  trendIdx: number[];
  ols: Float64Array;
  resid: Float64Array;
}

/** Standardised inputs of bar i for a fit (missing values sit at the mean; outliers are clipped). */
function rowOf(feats: FeatureDef[], fit: Pick<Fit, 'mean' | 'sd'>, i: number, out: Float64Array) {
  out[0] = 1;
  for (let f = 0; f < feats.length; f++) {
    const x = feats[f].col[i];
    out[f + 1] = Number.isNaN(x) || !(fit.sd[f] > 0) ? 0 : clamp((x - fit.mean[f]) / fit.sd[f], -4, 4);
  }
}

/**
 * Fit both regressions on the bars from `start` to `last`, whose forward windows are all closed.
 * The target is the H-bar return in units of the volatility forecast made on the bar itself.
 */
function fitModels(ds: Dataset, prep: Prepared, feats: FeatureDef[], sigma: Float64Array, start: number, last: number, warm?: Fit): Fit | null {
  const F = feats.length;
  const rows: number[] = [];
  for (let i = start; i <= last; i++) {
    if (!Number.isNaN(prep.fwd[i]) && sigma[i] > 0 && !Number.isNaN(feats[0].col[i]) && !Number.isNaN(feats[2].col[i])) rows.push(i);
  }
  const n = rows.length;
  if (n < 300) return null;
  const mean = new Float64Array(F);
  const sd = new Float64Array(F);
  for (let f = 0; f < F; f++) {
    let cnt = 0;
    let s1 = 0;
    let s2 = 0;
    for (const i of rows) {
      const x = feats[f].col[i];
      if (Number.isNaN(x)) continue;
      cnt++;
      s1 += x;
      s2 += x * x;
    }
    // An input with little history at this date is left out of the fit (its column stays at zero).
    if (cnt >= 200) {
      mean[f] = s1 / cnt;
      sd[f] = Math.sqrt(Math.max(0, s2 / cnt - mean[f] * mean[f]));
    }
  }
  const p = F + 1;
  const X = new Float64Array(n * p);
  const y = new Float64Array(n);
  const row = new Float64Array(p);
  rows.forEach((i, k) => {
    rowOf(feats, { mean, sd }, i, row);
    X.set(row, k * p);
    y[k] = prep.fwd[i] / (sigma[i] * Math.sqrt(prep.H));
  });
  // Strong shrinkage: with a few hundred independent windows, lightly penalised fits were overconfident
  // out of sample (too-narrow bands); these levels gave calibrated ones in the walk-forward test.
  const lambda = n * 0.02;
  const qr = TAUS.map((tau, k) => fitQuantile(X, y, n, p, tau, lambda * 20, warm?.qr[k], warm ? 10 : 30));

  const trendIdx = feats.flatMap((f, k) => (f.trend ? [k] : []));
  const pt = trendIdx.length + 1;
  const Xt = new Float64Array(n * pt);
  for (let k = 0; k < n; k++) {
    Xt[k * pt] = 1;
    trendIdx.forEach((f, a) => (Xt[k * pt + a + 1] = X[k * p + f + 1]));
  }
  const ols = fitRidge(Xt, y, n, pt, lambda * 10);
  // Residuals, thinned to a few hundred: neighbouring bars share most of their forward window.
  const stride = Math.max(1, Math.floor(n / 500));
  const resid = new Float64Array(Math.ceil(n / stride));
  for (let k = 0, j = 0; k < n; k += stride, j++) {
    let fit = 0;
    for (let a = 0; a < pt; a++) fit += Xt[k * pt + a] * ols[a];
    resid[j] = y[k] - fit;
  }
  return { mean, sd, qr, trendIdx, ols, resid };
}

function predictQuantile(feats: FeatureDef[], fit: Fit, q: number, scale: number): Dist {
  const row = new Float64Array(feats.length + 1);
  rowOf(feats, fit, q, row);
  return gridDist(
    TAUS,
    fit.qr.map((beta) => {
      let v = 0;
      for (let a = 0; a < row.length; a++) v += row[a] * beta[a];
      return v * scale;
    }),
  );
}

function trendDrift(feats: FeatureDef[], fit: Fit, q: number): number {
  const row = new Float64Array(feats.length + 1);
  rowOf(feats, fit, q, row);
  let drift = fit.ols[0];
  fit.trendIdx.forEach((f, a) => (drift += fit.ols[a + 1] * row[f + 1]));
  // The drift is a small tilt, never a forecast of its own: cap it at half a standard deviation.
  return clamp(drift, -0.5, 0.5);
}

function predictTrend(feats: FeatureDef[], fit: Fit, q: number, scale: number): Dist {
  const drift = trendDrift(feats, fit, q);
  return sampleDist(Float64Array.from(fit.resid, (e) => (drift + e) * scale));
}

/** Values and weights of a model sample as horizon log returns. */
function sampleValues(prep: Prepared, s: Sample): { values: Float64Array; weights: Float64Array } {
  const n = s.idx.length;
  const values = new Float64Array(n);
  const weights = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    values[j] = prep.fwd[s.idx[j]] * s.scale[j];
    weights[j] = s.w[j];
  }
  return { values, weights };
}

/** Equal-weight consensus: the average of the models' quantiles (Vincent averaging). */
const GRID = Array.from({ length: 49 }, (_, k) => (k + 1) / 50);
function consensus(dists: Dist[]): Dist {
  return gridDist(GRID, GRID.map((p) => dists.reduce((a, d) => a + d.quantile(p), 0) / dists.length));
}

/** Widen a distribution around its median by `m`. */
function widen(d: Dist, m: number): Dist {
  const med = d.quantile(0.5);
  return { cdf: (x) => d.cdf(med + (x - med) / m), quantile: (p) => med + (d.quantile(p) - med) * m };
}

// ───────────────────────── scoring ─────────────────────────

type Id = 'analog' | 'quantile' | 'trend' | 'ensemble';
const PIN_TAUS = [0.1, 0.25, 0.5, 0.75, 0.9];

class Score {
  n = 0;
  brier = { up: 0, rally: 0, decline: 0 };
  pin = 0;
  in80 = 0;
  in50 = 0;
  add(d: Dist, y: number, rallyT: number, declT: number) {
    this.n++;
    const sq = (p: number, hit: boolean) => (p - (hit ? 1 : 0)) ** 2;
    this.brier.up += sq(1 - d.cdf(0), y > 0);
    this.brier.rally += sq(1 - d.cdf(rallyT), y >= rallyT);
    this.brier.decline += sq(d.cdf(declT), y <= declT);
    for (const tau of PIN_TAUS) {
      const e = y - d.quantile(tau);
      this.pin += e >= 0 ? tau * e : (tau - 1) * e;
    }
    if (y >= d.quantile(0.1) && y <= d.quantile(0.9)) this.in80++;
    if (y >= d.quantile(0.25) && y <= d.quantile(0.75)) this.in50++;
  }
  skillVs(base: Score): NonNullable<ModelOutlook['skill']> {
    const sk = (a: number, b: number) => (b > 0 ? 1 - a / b : 0);
    const up = sk(this.brier.up, base.brier.up);
    const rally = sk(this.brier.rally, base.brier.rally);
    const decline = sk(this.brier.decline, base.brier.decline);
    return { up, rally, decline, avg: (up + rally + decline) / 3, quantile: sk(this.pin, base.pin), coverage80: this.in80 / this.n, coverage50: this.in50 / this.n };
  }
}

const MAX_EVALS = 500;
/** Refit the regressions every this many evaluated bars. */
const REFIT_EVERY = 25;

/**
 * Run the three models at the last closed bar and score them, with their consensus, on the same
 * walk-forward dates. `overlay` widens the consensus for scheduled events inside the horizon.
 */
export function runModels(ds: Dataset, prep: Prepared, s: ForecastSettings, overlay: EventOverlay, t: T = EN): ModelsReport {
  const H = s.horizon;
  const feats = featureDefs(ds, t);
  const sigma = new Float64Array(ds.n).fill(NaN);
  for (let i = 0; i < ds.n; i++) sigma[i] = termVol(ds, i, H, VOL_PERSISTENCE);
  const startT = Date.UTC(s.startYear, 0, 1) / 1000;
  let start = 120;
  while (start < ds.n && ds.t[start] < startT) start++;

  // The analog model needs inputs chosen by the user; the other two bring their own.
  const { model } = buildModel(ds, s.features, s.startYear, t, ds.lastClosed);
  const scratch = makeScratch(ds.n);
  const analogAt = (q: number): { analog: Dist | null; base: Dist | null } => {
    const maxCand = q - H;
    const base = baseSample(ds, prep, Math.max(start, model.start), q, maxCand, s);
    if (base.idx.length < 100) return { analog: null, base: null };
    const b = sampleValues(prep, base);
    const baseDist = sampleDist(b.values, b.weights);
    if (model.ids.length === 0) return { analog: null, base: baseDist };
    const nb = findNeighbors(ds, model, prep, q, maxCand, s, scratch);
    if (!nb) return { analog: null, base: baseDist };
    const mix = sampleValues(prep, mixSamples(nb, base, baseWeight(s, nb)));
    return { analog: sampleDist(mix.values, mix.weights), base: baseDist };
  };

  // ── walk-forward ──
  const firstEval = start + Math.max(700, 6 * H);
  const lastEval = ds.lastClosed - H;
  const step = Math.max(1, Math.round(H / 6), Math.ceil((lastEval - firstEval) / MAX_EVALS));
  const scores: Record<Id | 'base', Score> = { analog: new Score(), quantile: new Score(), trend: new Score(), ensemble: new Score(), base: new Score() };
  const analogBase = new Score();
  let fit: Fit | null = null;
  let sinceFit = REFIT_EVERY;
  let from = 0;
  let to = 0;
  for (let q = firstEval; q <= lastEval; q += step) {
    const y = prep.fwd[q];
    if (Number.isNaN(y) || !(sigma[q] > 0)) continue;
    if (sinceFit >= REFIT_EVERY || !fit) {
      fit = fitModels(ds, prep, feats, sigma, start, q - H, fit ?? undefined) ?? fit;
      sinceFit = 0;
    }
    sinceFit++;
    if (!fit) continue;
    const { analog, base } = analogAt(q);
    if (!base) continue;
    const scale = sigma[q] * Math.sqrt(H);
    const T = scenarioThreshold(ds, q, s);
    const rallyT = Math.log(1 + T / 100);
    const declT = Math.log(1 - T / 100);
    const dq = predictQuantile(feats, fit, q, scale);
    const dt = predictTrend(feats, fit, q, scale);
    scores.quantile.add(dq, y, rallyT, declT);
    scores.trend.add(dt, y, rallyT, declT);
    scores.base.add(base, y, rallyT, declT);
    scores.ensemble.add(consensus(analog ? [analog, dq, dt] : [dq, dt]), y, rallyT, declT);
    if (analog) {
      scores.analog.add(analog, y, rallyT, declT);
      analogBase.add(base, y, rallyT, declT);
    }
    if (!from) from = ds.t[q];
    to = ds.t[q];
  }

  // ── today ──
  const qf = ds.lastClosed;
  const live = fitModels(ds, prep, feats, sigma, start, qf - H) ?? fit;
  const price = ds.c[ds.n - 1];
  const T = scenarioThreshold(ds, qf, s);
  const rallyT = Math.log(1 + T / 100);
  const declT = Math.log(1 - T / 100);
  const scale = sigma[qf] * Math.sqrt(H);
  const pct = (x: number) => (Math.exp(x) - 1) * 100;
  const outlook = (id: Id, name: string, description: string, d: Dist | null, score: Score | null, base: Score, reason?: string): ModelOutlook => {
    if (!d) return { id, name, description, available: false, reason, pUp: NaN, pRally: NaN, pRange: NaN, pDecline: NaN, q10: NaN, q25: NaN, q50: NaN, q75: NaN, q90: NaN, skill: null };
    const pRally = 1 - d.cdf(rallyT);
    const pDecline = d.cdf(declT);
    return {
      id,
      name,
      description,
      available: true,
      pUp: 1 - d.cdf(0),
      pRally,
      pDecline,
      pRange: Math.max(0, 1 - pRally - pDecline),
      q10: pct(d.quantile(0.1)),
      q25: pct(d.quantile(0.25)),
      q50: pct(d.quantile(0.5)),
      q75: pct(d.quantile(0.75)),
      q90: pct(d.quantile(0.9)),
      skill: score && score.n >= 30 ? score.skillVs(base) : null,
    };
  };
  const today = analogAt(qf);
  const dq = live && scale > 0 ? predictQuantile(feats, live, qf, scale) : null;
  const dt = live && scale > 0 ? predictTrend(feats, live, qf, scale) : null;
  const available = [today.analog, dq, dt].filter((d): d is Dist => d != null);
  const ens = available.length ? consensus(available) : null;
  const noHistory = t('Not enough history on this timeframe to fit the model.');
  const models: ModelOutlook[] = [
    outlook('analog', t('Historical analogs'), t('Looks up the past days most similar to today on the inputs you selected and reads what price did next.'), today.analog, scores.analog, analogBase, model.ids.length ? noHistory : t('Select at least one metric as a model input.')),
    outlook('quantile', t('Quantile regression'), t('Weighs momentum, volatility, sentiment and macro inputs to estimate each quantile of the outcome directly.'), dq, scores.quantile, scores.base, noHistory),
    outlook('trend', t('Trend + volatility'), t('Time-series momentum sets a small directional tilt; a GARCH-style volatility forecast sets the width.'), dt, scores.trend, scores.base, noHistory),
    outlook('ensemble', t('Consensus'), t('Equal-weight average of the models above. Averaging forecasts that err in different ways is usually steadier than any single one.'), ens, scores.ensemble, scores.base, noHistory),
  ];

  // What each input contributes to the quantile regression right now.
  const weights: ModelWeight[] = [];
  if (live && scale > 0) {
    const row = new Float64Array(feats.length + 1);
    rowOf(feats, live, qf, row);
    const at = (tau: number) => live.qr[TAUS.indexOf(tau)];
    feats.forEach((f, k) => {
      if (!(live.sd[k] > 0)) return;
      const x = f.col[qf];
      weights.push({
        id: f.id,
        name: f.name,
        z: Number.isNaN(x) ? null : row[k + 1],
        low: at(0.1)[k + 1] * scale * 100,
        median: at(0.5)[k + 1] * scale * 100,
        high: at(0.9)[k + 1] * scale * 100,
        contribution: at(0.5)[k + 1] * row[k + 1] * scale * 100,
      });
    });
    weights.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  }

  const adjDist = ens ? widen(ens, overlay.spreadMultiplier) : null;
  const adjusted = adjDist
    ? (() => {
        const pRally = 1 - adjDist.cdf(rallyT);
        const pDecline = adjDist.cdf(declT);
        return { q10: pct(adjDist.quantile(0.1)), q25: pct(adjDist.quantile(0.25)), q50: pct(adjDist.quantile(0.5)), q75: pct(adjDist.quantile(0.75)), q90: pct(adjDist.quantile(0.9)), pRally, pDecline, pRange: Math.max(0, 1 - pRally - pDecline) };
      })()
    : { q10: NaN, q25: NaN, q50: NaN, q75: NaN, q90: NaN, pRally: NaN, pDecline: NaN, pRange: NaN };

  const singles = models.filter((m) => m.id !== 'ensemble' && m.available);
  const ups = singles.filter((m) => m.pUp > 0.53).length;
  const downs = singles.filter((m) => m.pUp < 0.47).length;
  const agreement = singles.length >= 2 && ups === singles.length ? 'bullish' : singles.length >= 2 && downs === singles.length ? 'bearish' : 'mixed';

  const notes = [
    t('Every model is scored on the same {n} past dates, using only data available on each date, against the base rate known that day. Skill above 0 beats the base rate; values within a couple of points of 0 are noise.', { n: scores.base.n }),
    t('No model predicts Bitcoin reliably. Momentum and volatility clustering are the two effects with solid published evidence; they shift the odds a little and size the range well, they do not call direction.'),
  ];
  if (overlay.events.length) {
    notes.push(t('{n} scheduled events fall inside the horizon, so the consensus range is widened by {pct}%.', { n: overlay.events.length, pct: Math.round((overlay.spreadMultiplier - 1) * 100) }));
  }

  return { timeframe: ds.tf, horizon: H, thresholdPct: T, price, asOf: ds.t[qf], evaluations: scores.base.n, from, to, models, weights, overlay, adjusted, agreement, notes };
}
