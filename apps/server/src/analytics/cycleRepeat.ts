import { DAY, type CycleBack, type CyclePath, type CyclePoint, type CycleRepeat, type CycleSpan } from '@smart-btc/shared';
import { EN, type T } from '../i18n/index.js';
import { HALVINGS, type Dataset } from './dataset.js';

/**
 * Cycle repeat: what price would do from here if the rest of this halving cycle moved like a past
 * one. Each past cycle is lined up on its own halving day; from today's day-in-cycle onwards its
 * day-by-day percentage moves are applied to today's price. Before today the same scaling shows how
 * that cycle would have arrived here, which is the honest check of how alike the two have been.
 *
 * It is a scenario, not a forecast: three completed cycles, each smaller than the one before.
 */

/** 210,000 blocks at ten minutes each. */
export const CYCLE_DAYS = 1458;
/** Step and span of the returns compared for the `match` figure. */
const MATCH_SPAN = 30;
const MATCH_STEP = 7;

function correlation(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 8) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** End point and extremes of a path after today. */
function summarise(values: (number | null)[], t: number[], today: number, price: number): Pick<CyclePath, 'end' | 'high' | 'low'> {
  const at = (i: number): CyclePoint => ({ t: t[i], price: values[i]!, pct: (values[i]! / price - 1) * 100 });
  let end = -1;
  let hi = -1;
  let lo = -1;
  for (let i = today + 1; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    end = i;
    if (hi < 0 || v > values[hi]!) hi = i;
    if (lo < 0 || v < values[lo]!) lo = i;
  }
  return { end: end < 0 ? null : at(end), high: hi < 0 ? null : at(hi), low: lo < 0 ? null : at(lo) };
}

const SPAN_DAYS: Record<Exclude<CycleSpan, 'halving'>, number> = { '6m': 182, '1y': 365, '2y': 730 };
const BACK_DAYS: Record<Exclude<CycleBack, 'halving'>, number> = { '6m': 182, '1y': 365 };

export function cycleRepeat(ds: Dataset, opts: { cycles: number[]; span: CycleSpan; back: CycleBack }, t: T = EN): CycleRepeat {
  // The still-forming daily bar is left out: every past day it is compared with is a finished one.
  const q = ds.lastClosed;
  const price = ds.c[q];
  const asOf = ds.t[q];
  const past = HALVINGS.filter((h) => h <= asOf);
  const halving = past[past.length - 1];
  const cycleDay = Math.round((asOf - halving) / DAY);
  const indexOf = (time: number) => Math.round((time - ds.t[0]) / DAY);

  const back = opts.back === 'halving' ? cycleDay : Math.min(BACK_DAYS[opts.back], cycleDay);
  // Past the estimated halving date the window falls back to one year.
  const days = opts.span === 'halving' ? (CYCLE_DAYS - cycleDay >= 30 ? CYCLE_DAYS - cycleDay : 365) : SPAN_DAYS[opts.span];
  const len = back + days + 1;
  const times = Array.from({ length: len }, (_, i) => asOf + (i - back) * DAY);
  const actual = times.map((_, i) => (i <= back ? ds.c[q - back + i] : null));

  const cycles: CyclePath[] = past.slice(0, -1).map((h, k) => {
    const anchor = indexOf(h) + cycleDay;
    const base = anchor >= 0 && anchor <= q ? ds.c[anchor] : NaN;
    const values = times.map((_, i) => {
      const j = anchor + i - back;
      // Only days that had already happened by today: a cycle never borrows from the present one.
      return j >= 0 && j <= q && base > 0 && ds.c[j] > 0 ? (price * ds.c[j]) / base : null;
    });
    // How alike the two cycles moved over the look-back: correlation of overlapping 30-day returns.
    const mine: number[] = [];
    const theirs: number[] = [];
    for (let d = back; d - MATCH_SPAN >= 0; d -= MATCH_STEP) {
      const j = anchor - (back - d);
      const i = q - (back - d);
      if (j - MATCH_SPAN < 0 || !(ds.c[j - MATCH_SPAN] > 0)) break;
      mine.push(Math.log(ds.c[i] / ds.c[i - MATCH_SPAN]));
      theirs.push(Math.log(ds.c[j] / ds.c[j - MATCH_SPAN]));
    }
    const next = past[k + 1];
    return {
      id: k + 1,
      label: `${new Date(h * 1000).getUTCFullYear()}–${new Date(next * 1000).getUTCFullYear()}`,
      halving: h,
      values,
      ...summarise(values, times, back, price),
      match: correlation(mine, theirs),
    };
  });

  const usable = cycles.filter((c) => c.end != null);
  const selected = opts.cycles.filter((id) => usable.some((c) => c.id === id));
  const chosen = usable.filter((c) => selected.includes(c.id));
  let average: CycleRepeat['average'] = null;
  if (chosen.length >= 2) {
    const values: (number | null)[] = [];
    const low: (number | null)[] = [];
    const high: (number | null)[] = [];
    for (let i = 0; i < len; i++) {
      const xs = chosen.map((c) => c.values[i]);
      if (xs.some((x) => x == null)) {
        values.push(null);
        low.push(null);
        high.push(null);
        continue;
      }
      const v = xs as number[];
      // Averaging the logs gives each cycle's percentage path equal weight, whatever its size.
      values.push(Math.exp(v.reduce((s, x) => s + Math.log(x), 0) / v.length));
      low.push(Math.min(...v));
      high.push(Math.max(...v));
    }
    const s = summarise(values, times, back, price);
    average = { values, low, high, end: s.end, high_: s.high, low_: s.low };
  }

  const notes = [
    t('Each line is today\'s price moved day by day the way that cycle moved from day {d} after its own halving. Left of today it shows how that cycle would have arrived at the current price.', { d: cycleDay }),
    t('This is a what-if, not a forecast. There are only three completed cycles, each had smaller swings than the one before, and nothing obliges the next stretch to follow any of them.'),
  ];
  if (average) notes.push(t('The combined line is the average of the selected cycles\' percentage paths; the shaded band runs from the lowest to the highest of them.'));

  return { asOf, price, cycleDay, halving, nextHalving: halving + CYCLE_DAYS * DAY, t: times, today: back, actual, cycles, selected, average, notes };
}
