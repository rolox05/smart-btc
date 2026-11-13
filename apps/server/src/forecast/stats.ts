/** Weighted quantile (0..1) with linear interpolation between mid-points of the weight mass. */
export function weightedQuantiles(values: ArrayLike<number>, weights: ArrayLike<number>, qs: number[]): number[] {
  const n = values.length;
  if (n === 0) return qs.map(() => NaN);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  let total = 0;
  for (let i = 0; i < n; i++) total += weights[i];
  const mids = new Float64Array(n);
  let cum = 0;
  for (let j = 0; j < n; j++) {
    const w = weights[order[j]];
    mids[j] = (cum + w / 2) / total;
    cum += w;
  }
  return qs.map((q) => {
    if (q <= mids[0]) return values[order[0]];
    if (q >= mids[n - 1]) return values[order[n - 1]];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (mids[m] <= q) lo = m;
      else hi = m;
    }
    const f = (q - mids[lo]) / (mids[hi] - mids[lo] || 1);
    return values[order[lo]] + f * (values[order[hi]] - values[order[lo]]);
  });
}

export const weightedMedian = (values: ArrayLike<number>, weights: ArrayLike<number>) =>
  weightedQuantiles(values, weights, [0.5])[0];

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function sum(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s;
}
