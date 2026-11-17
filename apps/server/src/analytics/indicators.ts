/** Technical indicator primitives. All take and return Float64Array, with NaN during warm-up. */

export type Arr = Float64Array;
const nan = (n: number) => new Float64Array(n).fill(NaN);

export function sma(x: Arr, n: number): Arr {
  const out = nan(x.length);
  let sum = 0;
  let bad = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) bad++;
    else sum += x[i];
    if (i >= n) {
      if (Number.isNaN(x[i - n])) bad--;
      else sum -= x[i - n];
    }
    if (i >= n - 1 && bad === 0) out[i] = sum / n;
  }
  return out;
}

export function rollingStd(x: Arr, n: number): Arr {
  const out = nan(x.length);
  let s = 0;
  let s2 = 0;
  let bad = 0;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) bad++;
    else {
      s += x[i];
      s2 += x[i] * x[i];
    }
    if (i >= n) {
      const old = x[i - n];
      if (Number.isNaN(old)) bad--;
      else {
        s -= old;
        s2 -= old * old;
      }
    }
    if (i >= n - 1 && bad === 0) {
      const mean = s / n;
      out[i] = Math.sqrt(Math.max(0, s2 / n - mean * mean) * (n / (n - 1)));
    }
  }
  return out;
}

export function rollingSum(x: Arr, n: number): Arr {
  const m = sma(x, n);
  for (let i = 0; i < m.length; i++) m[i] *= n;
  return m;
}

export function logReturns(c: Arr): Arr {
  const out = nan(c.length);
  for (let i = 1; i < c.length; i++) out[i] = Math.log(c[i] / c[i - 1]);
  return out;
}

/** Annualised realised volatility in %, from bar-to-bar log returns. */
export function realizedVol(c: Arr, n: number, barsPerYear = 365): Arr {
  const sd = rollingStd(logReturns(c), n);
  for (let i = 0; i < sd.length; i++) sd[i] *= Math.sqrt(barsPerYear) * 100;
  return sd;
}

/** Wilder's RSI. */
export function rsi(c: Arr, n = 14): Arr {
  const out = nan(c.length);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    if (i <= n) {
      gain += g / n;
      loss += l / n;
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
    }
    if (i >= n) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Wilder's average true range. */
export function atr(h: Arr, l: Arr, c: Arr, n = 14): Arr {
  const out = nan(c.length);
  let a = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= n) a += tr / n;
    else a = (a * (n - 1) + tr) / n;
    if (i >= n) out[i] = a;
  }
  return out;
}

/**
 * Supertrend: a trailing stop built from the average true range. While price closes above it the line
 * trails below price (uptrend) and can only rise; a close through it flips it to the other side.
 */
export function supertrend(h: Arr, l: Arr, c: Arr, period = 10, mult = 3): Arr {
  const out = nan(c.length);
  const a = atr(h, l, c, period);
  let upper = NaN;
  let lower = NaN;
  let up = true;
  for (let i = 0; i < c.length; i++) {
    if (Number.isNaN(a[i])) continue;
    const mid = (h[i] + l[i]) / 2;
    const basicUpper = mid + mult * a[i];
    const basicLower = mid - mult * a[i];
    if (Number.isNaN(upper)) {
      upper = basicUpper;
      lower = basicLower;
      up = c[i] >= mid;
    } else {
      upper = basicUpper < upper || c[i - 1] > upper ? basicUpper : upper;
      lower = basicLower > lower || c[i - 1] < lower ? basicLower : lower;
      if (up && c[i] < lower) up = false;
      else if (!up && c[i] > upper) up = true;
    }
    out[i] = up ? lower : upper;
  }
  return out;
}

export function runningMax(x: Arr): Arr {
  const out = nan(x.length);
  let m = -Infinity;
  for (let i = 0; i < x.length; i++) {
    if (x[i] > m) m = x[i];
    out[i] = m;
  }
  return out;
}

/** % change over n bars. */
export function pctChange(x: Arr, n: number): Arr {
  const out = nan(x.length);
  for (let i = n; i < x.length; i++) out[i] = (x[i] / x[i - n] - 1) * 100;
  return out;
}

/**
 * Days since the last pullback of at least `pct` (0.10 = 10%).
 * A pullback completes when the day's low trades `pct` below the highest high of the current leg;
 * the counter then resets and a new leg starts from that day's close.
 */
export function daysSinceDrawdown(h: Arr, l: Arr, c: Arr, pct: number): Arr {
  const out = nan(c.length);
  let peak = h[0];
  let count = 0;
  for (let i = 0; i < c.length; i++) {
    if (h[i] > peak) peak = h[i];
    if (l[i] <= peak * (1 - pct)) {
      count = 0;
      peak = c[i];
    } else {
      count++;
    }
    out[i] = count;
  }
  return out;
}

/**
 * Days since the last rally of at least `pct` (0.10 = 10%): the mirror of `daysSinceDrawdown`.
 * A rally completes when the day's high trades `pct` above the lowest low of the current leg;
 * the counter then resets and a new leg starts from that day's close.
 */
export function daysSinceRally(h: Arr, l: Arr, c: Arr, pct: number): Arr {
  const out = nan(c.length);
  let trough = l[0];
  let count = 0;
  for (let i = 0; i < c.length; i++) {
    if (l[i] < trough) trough = l[i];
    if (h[i] >= trough * (1 + pct)) {
      count = 0;
      trough = c[i];
    } else {
      count++;
    }
    out[i] = count;
  }
  return out;
}

export function map(x: Arr, fn: (v: number, i: number) => number): Arr {
  const out = nan(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Number.isNaN(x[i]) ? NaN : fn(x[i], i);
  return out;
}

/** Shift a series forward in time by `n` bars (value known at i-n is used at i). */
export function lag(x: Arr, n: number): Arr {
  if (n <= 0) return x;
  const out = nan(x.length);
  for (let i = n; i < x.length; i++) out[i] = x[i - n];
  return out;
}

/** Carry the last valid value forward for at most `maxGap` bars. */
export function ffill(x: Arr, maxGap: number): Arr {
  const out = Float64Array.from(x);
  let last = NaN;
  let age = Infinity;
  for (let i = 0; i < out.length; i++) {
    if (!Number.isNaN(out[i])) {
      last = out[i];
      age = 0;
    } else if (++age <= maxGap) {
      out[i] = last;
    }
  }
  return out;
}
