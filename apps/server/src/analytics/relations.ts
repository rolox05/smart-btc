import { DAY, type ForwardRelation, type RelationWindow, type Relations } from '@smart-btc/shared';
import type { Dataset } from './dataset.js';
import { METRICS } from './metrics.js';

/**
 * How metrics relate to each other and to what price did next.
 * Everything here is descriptive and in-sample: it helps interpret readings, it does not test a strategy
 * (the walk-forward backtest and the ranking do that).
 */

/** Average ranks (ties share the mean rank). */
function ranks(x: number[]): number[] {
  const order = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const r = new Array<number>(x.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && x[order[j + 1]] === x[order[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k]] = avg;
    i = j + 1;
  }
  return r;
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 60) return null;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
}

/** Spearman rank correlation over the days where both series have a value. */
function spearman(x: Float64Array, y: Float64Array, from: number, to: number, step = 1): { r: number | null; n: number } {
  const a: number[] = [];
  const b: number[] = [];
  for (let i = from; i <= to; i += step) {
    if (Number.isNaN(x[i]) || Number.isNaN(y[i])) continue;
    a.push(x[i]);
    b.push(y[i]);
  }
  return { r: pearson(ranks(a), ranks(b)), n: a.length };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)];
};

const WINDOW_DAYS: Record<RelationWindow, number> = { all: Infinity, '4y': 1461, '1y': 365 };

export function buildRelations(ds: Dataset, window: RelationWindow, horizon: number, startYear: number): Relations {
  const startT = Date.UTC(startYear, 0, 1) / 1000;
  let from = Math.max(0, ds.t.findIndex((t) => t >= startT));
  if (Number.isFinite(WINDOW_DAYS[window])) from = Math.max(from, ds.n - 1 - Math.round((WINDOW_DAYS[window] * DAY) / ds.barSec));
  // Long intraday histories are thinned: neighbouring bars carry almost the same readings.
  const step = Math.max(1, Math.ceil((ds.n - from) / 12_000));
  const to = ds.n - 1;

  const defs = METRICS.filter((m) => m.forecastable);
  const cols = defs.map((m) => ds.series.get(m.id)!);
  const ids = defs.map((m) => m.id);

  const matrix: (number | null)[][] = ids.map(() => ids.map(() => null));
  for (let i = 0; i < ids.length; i++) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < ids.length; j++) {
      const { r } = spearman(cols[i], cols[j], from, to, step);
      matrix[i][j] = matrix[j][i] = r == null ? null : +r.toFixed(3);
    }
  }

  // Forward return over `horizon` days from each day in the window.
  const fwd = new Float64Array(ds.n).fill(NaN);
  for (let i = from; i + horizon <= to; i++) fwd[i] = (ds.c[i + horizon] / ds.c[i] - 1) * 100;
  const baseRets: number[] = [];
  for (let i = from; i <= to; i += step) if (!Number.isNaN(fwd[i])) baseRets.push(fwd[i]);

  const bucket = (rets: number[]) =>
    rets.length >= 20 ? { medianPct: median(rets), winRate: rets.filter((r) => r > 0).length / rets.length, n: rets.length } : null;

  const forward: ForwardRelation[] = defs.map((m, k) => {
    const x = cols[k];
    const { r, n } = spearman(x, fwd, from, to, step);
    const vals: number[] = [];
    for (let i = from; i <= to; i += step) if (!Number.isNaN(x[i]) && !Number.isNaN(fwd[i])) vals.push(x[i]);
    const sorted = [...vals].sort((p, q) => p - q);
    const lo = sorted[Math.floor(sorted.length * 0.2)];
    const hi = sorted[Math.floor(sorted.length * 0.8)];
    const lowRets: number[] = [];
    const highRets: number[] = [];
    for (let i = from; i <= to; i += step) {
      if (Number.isNaN(x[i]) || Number.isNaN(fwd[i])) continue;
      if (x[i] <= lo) lowRets.push(fwd[i]);
      if (x[i] >= hi) highRets.push(fwd[i]);
    }
    return { id: m.id, ic: r == null ? null : +r.toFixed(3), n, low: bucket(lowRets), high: bucket(highRets) };
  });

  return {
    window,
    timeframe: ds.tf,
    from: ds.t[from],
    to: ds.t[to],
    horizon,
    ids,
    matrix,
    forward,
    base: {
      medianPct: median(baseRets),
      winRate: baseRets.length ? baseRets.filter((r) => r > 0).length / baseRets.length : 0,
      n: baseRets.length,
    },
  };
}
