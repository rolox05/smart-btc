import type {
  EdgeState,
  ForecastResult,
  KeyLevel,
  LiquidityLevel,
  LiquidityReport,
  MarketEvent,
  ModelsReport,
  TodayChange,
  TodayScenario,
  TodaySnapshot,
  TodaySummary,
} from '@smart-btc/shared';
import { EN, type T } from '../i18n/index.js';

/**
 * The conclusion first. Everything here is a reading of numbers computed elsewhere (the three models,
 * the analog forecast, the event calendar, the liquidity estimate); nothing is modelled again.
 *
 * The thresholds are deliberately conservative: the walk-forward tests put the models a few points
 * ahead of the base rate at best, so on most days the honest reading is "nothing unusual".
 */
export const TODAY = {
  /** P(up) this far from 50% counts as a lean, and this far as a clear one. */
  lean: 0.05,
  clearLean: 0.15,
  /** Distance from the base rate below which the models say nothing new, and above which they say something. */
  noEdge: 0.03,
  edge: 0.07,
  /** Walk-forward skill at or below this is indistinguishable from the base rate. */
  minSkill: 0.005,
  /** Changes smaller than this (in probability, or in % for the median) are not reported. */
  changeP: 0.03,
  changePct: 1,
  maxEvents: 3,
} as const;

export interface TodayInputs {
  models: ModelsReport;
  /** The analog forecast, when the user has inputs selected; supplies the confidence grade. */
  forecast: ForecastResult | null;
  /** Upcoming scheduled events, any order. */
  events: MarketEvent[];
  liquidity: LiquidityReport | null;
  previous: TodaySnapshot | null;
  /** Unix seconds. */
  now: number;
  /** Length of one bar in days. */
  barDays: number;
}

const DAY = 86_400;

export function edgeState(pUp: number, basePUp: number, skill: number | null, agreement: ModelsReport['agreement'], confidence: TodaySnapshot['confidence']): EdgeState {
  const gap = Math.abs(pUp - basePUp);
  // A model that has not beaten the base rate in testing has no claim to an edge, whatever it says today.
  if (gap < TODAY.noEdge || (skill != null && skill <= TODAY.minSkill)) return 'none';
  if (gap >= TODAY.edge && agreement !== 'mixed' && confidence !== 'low' && skill != null) return 'present';
  return 'weak';
}

function scenarios(m: ModelsReport, price: number): TodayScenario[] {
  const a = m.adjusted;
  const T = m.thresholdPct;
  const at = (pct: number) => price * (1 + pct / 100);
  return [
    { id: 'bear', probability: a.pDecline, baseProbability: m.base?.pDecline ?? null, lowPrice: at(Math.min(a.q10, -T)), highPrice: at(-T) },
    { id: 'base', probability: a.pRange, baseProbability: m.base ? Math.max(0, 1 - m.base.pRally - m.base.pDecline) : null, lowPrice: at(-T), highPrice: at(T) },
    { id: 'bull', probability: a.pRally, baseProbability: m.base?.pRally ?? null, lowPrice: at(T), highPrice: at(Math.max(a.q90, T)) },
  ];
}

function levels(m: ModelsReport, price: number, liquidity: LiquidityReport | null): KeyLevel[] {
  const out: KeyLevel[] = [];
  const add = (kind: KeyLevel['kind'], p: number, notionalUsd: number | null = null) => {
    if (p > 0 && Number.isFinite(p)) out.push({ kind, price: p, distancePct: (p / price - 1) * 100, notionalUsd });
  };
  const a = m.adjusted;
  add('rangeHigh', price * (1 + a.q90 / 100));
  add('median', price * (1 + a.q50 / 100));
  add('rangeLow', price * (1 + a.q10 / 100));
  // The largest estimated liquidation cluster on each side: where a move would find fuel.
  const strongest = (side: LiquidityLevel['side']) =>
    (liquidity?.liquidations ?? []).filter((l) => l.side === side).sort((x, y) => y.strength - x.strength)[0];
  const above = strongest('buy-side');
  const below = strongest('sell-side');
  if (above) add('liqAbove', above.price, above.notionalUsd);
  if (below) add('liqBelow', below.price, below.notionalUsd);
  return out.sort((x, y) => y.price - x.price);
}

export function diffReadings(prev: TodaySnapshot, cur: TodaySnapshot): TodayChange[] {
  const out: TodayChange[] = [];
  if (prev.direction !== cur.direction) out.push({ field: 'direction', from: prev.direction, to: cur.direction });
  if (Math.abs(prev.pUp - cur.pUp) >= TODAY.changeP) out.push({ field: 'pUp', from: prev.pUp, to: cur.pUp });
  if (prev.edge !== cur.edge) out.push({ field: 'edge', from: prev.edge, to: cur.edge });
  if (prev.confidence && cur.confidence && prev.confidence !== cur.confidence) out.push({ field: 'confidence', from: prev.confidence, to: cur.confidence });
  if (Math.abs(prev.medianPct - cur.medianPct) >= TODAY.changePct) out.push({ field: 'medianPct', from: prev.medianPct, to: cur.medianPct });
  return out;
}

export function buildToday(input: TodayInputs, t: T = EN): TodaySummary | null {
  const { models: m, forecast, now } = input;
  const consensus = m.models.find((x) => x.id === 'ensemble' && x.available);
  if (!consensus) return null;

  const price = m.price;
  const pUp = consensus.pUp;
  const basePUp = m.base?.pUp ?? forecast?.base.probUp ?? 0.5;
  const skill = consensus.skill?.avg ?? null;
  const confidence = forecast?.confidence.label ?? null;
  const lean = Math.abs(pUp - 0.5);
  const direction = lean < TODAY.lean ? 'neutral' : pUp > 0.5 ? 'up' : 'down';
  const strength = direction === 'neutral' ? null : lean >= TODAY.clearLean ? 'clear' : 'slight';
  const edge = edgeState(pUp, basePUp, skill, m.agreement, confidence);
  const h = t.dur(m.timeframe, m.horizon);
  const pc = (x: number) => Math.round(x * 100);

  const headline =
    edge === 'none'
      ? Math.abs(pUp - basePUp) < TODAY.noEdge
        ? t('Nothing unusual over {h}: the odds are about what any day gives', { h })
        : t('No tested edge over {h}: the models differ from history, but that has not paid in testing', { h })
      : direction === 'neutral'
        ? t('No directional lean over {h}', { h })
        : t(
            direction === 'up'
              ? strength === 'clear' ? 'Clear upward lean over {h}' : 'Slight upward lean over {h}'
              : strength === 'clear' ? 'Clear downward lean over {h}' : 'Slight downward lean over {h}',
            { h },
          );

  const reasons: string[] = [];
  reasons.push(t('The models give a {p}% chance of a higher price in {h}; on any day in history it is {base}%.', { p: pc(pUp), h, base: pc(basePUp) }));
  if (skill != null && skill <= TODAY.minSkill) {
    reasons.push(t('In testing at this horizon the consensus did no better than the base rate, so treat its lean as noise.'));
  } else if (skill != null) {
    reasons.push(t('In testing at this horizon the consensus beat the base rate by {x}%: a small edge, not a call.', { x: (skill * 100).toFixed(1) }));
  }
  reasons.push(
    m.agreement === 'mixed'
      ? t('The three models disagree on direction.')
      : t(m.agreement === 'bullish' ? 'All the models lean up.' : 'All the models lean down.'),
  );
  if (confidence === 'low') reasons.push(t('Few comparable days in history: confidence is low.'));
  if (!forecast) reasons.push(t('No inputs are selected for the analog model, so this reading rests on the other two.'));

  const horizonEnd = now + m.horizon * input.barDays * DAY;
  const events = input.events
    .filter((e) => e.t + DAY > now && e.t <= horizonEnd)
    .sort((x, y) => x.t - y.t)
    .slice(0, TODAY.maxEvents)
    .map((e) => ({ kind: e.kind, t: e.t, title: e.title, days: Math.max(0, Math.round((e.t - now) / DAY)), estimated: e.estimated }));

  const snapshot: TodaySnapshot = { asOf: m.asOf, price, pUp, medianPct: m.adjusted.q50, edge, direction, confidence };
  const previous = input.previous && input.previous.asOf < m.asOf ? input.previous : null;

  return {
    ...snapshot,
    timeframe: m.timeframe,
    horizon: m.horizon,
    basePUp,
    strength,
    agreement: m.agreement,
    skill,
    headline,
    reasons,
    thresholdPct: m.thresholdPct,
    scenarios: scenarios(m, price),
    events,
    levels: levels(m, price, input.liquidity),
    previous,
    changes: previous ? diffReadings(previous, snapshot) : [],
  };
}

/** The fields of a summary worth keeping for the next comparison. */
export const snapshotOf = (s: TodaySummary): TodaySnapshot => ({
  asOf: s.asOf,
  price: s.price,
  pUp: s.pUp,
  medianPct: s.medianPct,
  edge: s.edge,
  direction: s.direction,
  confidence: s.confidence,
});
