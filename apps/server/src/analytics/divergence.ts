import { durationLabel, type AnnotationDef, type AnnotationPayload, type AnnotationSegment, type AnnotationStats } from '@smart-btc/shared';
import type { Dataset } from './dataset.js';

/**
 * Chart annotations: signals drawn on top of a metric's pane and toggled on their own.
 * To add one, describe it in ANNOTATIONS and return its payload from `buildAnnotation`.
 */
export const ANNOTATIONS: AnnotationDef[] = [
  {
    id: 'rsiDivergence',
    metricId: 'rsi14',
    name: 'RSI divergences',
    description:
      'Bullish: price makes a lower low while RSI makes a higher low (selling is losing force). Bearish: price makes a higher high while RSI makes a lower high (buying is losing force).',
  },
];

/** Bars on each side that must be higher/lower for a point to count as a pivot. */
const WING = 5;
/** Two pivots are compared only if they are this far apart, in bars. */
const MIN_GAP = 6;
const MAX_GAP = 60;
/** The first pivot must sit in weak (bullish case) or strong (bearish case) RSI territory. */
const BULL_ZONE = 40;
const BEAR_ZONE = 60;
const STUDY_HORIZONS = [7, 14, 30];
/** Bars after confirmation within which the follow-through move is measured. */
const MOVE_LOOKAHEAD = 60;

function pivots(x: Float64Array, wing: number, kind: 'low' | 'high'): number[] {
  const out: number[] = [];
  for (let i = wing; i < x.length - wing; i++) {
    if (Number.isNaN(x[i])) continue;
    let ok = true;
    for (let j = i - wing; j <= i + wing && ok; j++) {
      if (j === i) continue;
      if (Number.isNaN(x[j]) || (kind === 'low' ? x[j] <= x[i] : x[j] >= x[i])) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

function rsiDivergence(ds: Dataset): AnnotationPayload {
  const rsi = ds.series.get('rsi14')!;
  const segments: AnnotationSegment[] = [];
  const confirmIdx: { kind: 'bullish' | 'bearish'; idx: number }[] = [];

  // Price reference at an RSI pivot: the extreme within two bars, since the two rarely turn on the same day.
  const near = (i: number, kind: 'low' | 'high') => {
    let v = kind === 'low' ? Infinity : -Infinity;
    for (let j = Math.max(0, i - 2); j <= Math.min(ds.n - 1, i + 2); j++) {
      v = kind === 'low' ? Math.min(v, ds.l[j]) : Math.max(v, ds.h[j]);
    }
    return v;
  };

  for (const kind of ['bullish', 'bearish'] as const) {
    const side = kind === 'bullish' ? 'low' : 'high';
    const ps = pivots(rsi, WING, side);
    // Only consecutive pivots are compared, which also keeps the drawn segments from overlapping.
    for (let k = 1; k < ps.length; k++) {
      const a = ps[k - 1];
      const b = ps[k];
      if (b - a < MIN_GAP || b - a > MAX_GAP) continue;
      const pa = near(a, side);
      const pb = near(b, side);
      const isDiv =
        kind === 'bullish'
          ? rsi[a] <= BULL_ZONE && rsi[b] > rsi[a] + 1 && pb < pa
          : rsi[a] >= BEAR_ZONE && rsi[b] < rsi[a] - 1 && pb > pa;
      if (!isDiv) continue;
      const c = Math.min(ds.n - 1, b + WING);
      segments.push({ kind, t1: ds.t[a], v1: rsi[a], t2: ds.t[b], v2: rsi[b], price1: pa, price2: pb, confirmedT: ds.t[c] });
      confirmIdx.push({ kind, idx: b + WING });
    }
  }
  segments.sort((x, y) => x.t2 - y.t2);

  // Event study from the confirmation day (pivot + WING bars), so nothing here uses hindsight.
  const stats: AnnotationStats[] = (['bullish', 'bearish'] as const).map((kind) => {
    const events = confirmIdx.filter((e) => e.kind === kind).map((e) => e.idx);
    // Follow-through: when, within the look-ahead, price was furthest in the signal's direction.
    const durations: number[] = [];
    const sizes: number[] = [];
    for (const i of events) {
      if (i + MOVE_LOOKAHEAD >= ds.n) continue; // too recent to have played out
      let best = 0;
      let at = 0;
      for (let d = 1; d <= MOVE_LOOKAHEAD; d++) {
        const r = kind === 'bullish' ? ds.h[i + d] / ds.c[i] - 1 : 1 - ds.l[i + d] / ds.c[i];
        if (r > best) {
          best = r;
          at = d;
        }
      }
      durations.push(at);
      sizes.push(best * 100);
    }
    const move = durations.length
      ? {
          lookahead: MOVE_LOOKAHEAD,
          n: durations.length,
          avgBars: durations.reduce((a, b) => a + b, 0) / durations.length,
          medianBars: median(durations),
          medianPct: median(sizes),
        }
      : null;
    return {
      kind,
      label: kind === 'bullish' ? 'Bullish divergence' : 'Bearish divergence',
      count: events.length,
      move,
      horizons: STUDY_HORIZONS.map((bars) => {
        const days = bars;
        const rets: number[] = [];
        for (const i of events) if (i + days < ds.n) rets.push((ds.c[i + days] / ds.c[i] - 1) * 100);
        const base: number[] = [];
        for (let i = Math.min(250, ds.n >> 2); i + days < ds.n; i += ds.stride) base.push((ds.c[i + days] / ds.c[i] - 1) * 100);
        return {
          bars,
          n: rets.length,
          medianPct: median(rets),
          winRate: rets.length ? rets.filter((r) => r > 0).length / rets.length : 0,
          baseMedianPct: median(base),
          baseWinRate: base.length ? base.filter((r) => r > 0).length / base.length : 0,
        };
      }),
    };
  });

  return {
    id: 'rsiDivergence',
    metricId: 'rsi14',
    segments,
    stats,
    notes: [
      `Pivots need ${WING} lower/higher bars on each side, so a divergence is only confirmed ${durationLabel(ds.tf, WING)} after the second turn. The statistics are measured from that confirmation bar.`,
      `Rules: two consecutive RSI pivots ${MIN_GAP}–${MAX_GAP} bars apart; the first below ${BULL_ZONE} (bullish) or above ${BEAR_ZONE} (bearish).`,
    ],
  };
}

export function buildAnnotation(ds: Dataset, id: string): AnnotationPayload | null {
  if (id === 'rsiDivergence') return rsiDivergence(ds);
  return null;
}
