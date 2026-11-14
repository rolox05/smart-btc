import {
  addBars,
  type AnalogMatch,
  type ConePoint,
  type DistributionStats,
  type ForecastResult,
  type ForecastSettings,
  type HistogramBin,
  type Scenario,
  type ScenarioId,
  type TouchProbability,
} from '@smart-btc/shared';
import type { Dataset } from '../analytics/dataset.js';
import { metricShort } from '../analytics/metrics.js';
import { EN, type T as Translator } from '../i18n/index.js';
import {
  buildModel,
  featureStats,
  baseWeight,
  findNeighbors,
  makeScratch,
  moveUnit,
  scenarioThreshold,
  volScale,
  type Neighbors,
  type Prepared,
} from './analog.js';
import { clamp, weightedMedian, weightedQuantiles } from './stats.js';

export class ForecastError extends Error {}

const pct = (logRet: number) => (Math.exp(logRet) - 1) * 100;
const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const signed = (x: number, digits = Math.abs(x) < 1 ? 2 : 1) => `${x >= 0 ? '+' : ''}${x.toFixed(digits)}%`;

/** Multiples of the move unit that make up the touch-level ladder. */
const LADDER = [1, 2, 3, 4, 6, 8, 10, 12];
/** The fan chart is sampled at no more than this many points. */
const MAX_CONE_POINTS = 60;

/** A set of historical start bars with weights and volatility scaling - either the analogs or the base rate. */
export interface Sample {
  idx: ArrayLike<number>;
  w: ArrayLike<number>;
  scale: ArrayLike<number>;
}

/** Every (thinned) bar whose forward window is complete: the unconditional base rate the model must beat. */
export function baseSample(ds: Dataset, prep: Prepared, start: number, q: number, maxCand: number, s: ForecastSettings): Sample {
  const idx: number[] = [];
  const scale: number[] = [];
  const stride = ds.stride;
  for (let i = Math.ceil(start / stride) * stride; i <= maxCand; i += stride) {
    if (Number.isNaN(prep.fwd[i])) continue;
    idx.push(i);
    scale.push(volScale(ds, q, i, s.volAdjust, s));
  }
  const w = new Float64Array(idx.length).fill(1 / Math.max(1, idx.length));
  return { idx, w, scale };
}

/** Mixture of the analogs and the base rate: `blend` is the weight given to the base rate. */
export function mixSamples(nb: Sample, base: Sample, blend: number): Sample {
  if (blend <= 0 || base.idx.length === 0) return nb;
  if (blend >= 1) return base;
  const n1 = nb.idx.length;
  const n = n1 + base.idx.length;
  const idx = new Array<number>(n);
  const w = new Float64Array(n);
  const scale = new Float64Array(n);
  for (let j = 0; j < n1; j++) {
    idx[j] = nb.idx[j];
    w[j] = nb.w[j] * (1 - blend);
    scale[j] = nb.scale[j];
  }
  for (let j = 0; j < base.idx.length; j++) {
    idx[n1 + j] = base.idx[j];
    w[n1 + j] = base.w[j] * blend;
    scale[n1 + j] = base.scale[j];
  }
  return { idx, w, scale };
}

function terminalStats(prep: Prepared, s: Sample): { stats: DistributionStats; returns: Float64Array } {
  const n = s.idx.length;
  const returns = new Float64Array(n);
  let up = 0;
  let mean = 0;
  for (let j = 0; j < n; j++) {
    returns[j] = pct(prep.fwd[s.idx[j]] * s.scale[j]);
    if (returns[j] > 0) up += s.w[j];
    mean += returns[j] * s.w[j];
  }
  const [p10, p25, p50, p75, p90] = weightedQuantiles(returns, s.w, [0.1, 0.25, 0.5, 0.75, 0.9]);
  return { stats: { probUp: up, mean, p10, p25, p50, p75, p90 }, returns };
}

function touchStats(prep: Prepared, s: Sample, levelPct: number) {
  const upT = Math.log(1 + levelPct / 100);
  const dnT = Math.log(1 - levelPct / 100);
  const { logC, logH, logL, H } = prep;
  let up = 0;
  let down = 0;
  let upFirst = 0;
  let downFirst = 0;
  const upDays: number[] = [];
  const upW: number[] = [];
  const dnDays: number[] = [];
  const dnW: number[] = [];
  for (let j = 0; j < s.idx.length; j++) {
    const i = s.idx[j];
    const sc = s.scale[j];
    const w = s.w[j];
    // Cheap rejection using the precomputed path extremes.
    const touchesUp = prep.mx[i] * sc >= upT;
    const touchesDn = prep.mn[i] * sc <= dnT;
    if (!touchesUp && !touchesDn) continue;
    let dUp = 0;
    let dDn = 0;
    for (let d = 1; d <= H && (!dUp || !dDn); d++) {
      if (!dUp && (logH[i + d] - logC[i]) * sc >= upT) dUp = d;
      if (!dDn && (logL[i + d] - logC[i]) * sc <= dnT) dDn = d;
      if ((dUp && !touchesDn) || (dDn && !touchesUp)) break;
    }
    if (dUp) {
      up += w;
      upDays.push(dUp);
      upW.push(w);
    }
    if (dDn) {
      down += w;
      dnDays.push(dDn);
      dnW.push(w);
    }
    // Touches of both levels inside one bar cannot be ordered: split them evenly.
    if (dUp && (!dDn || dUp < dDn)) upFirst += w;
    else if (dDn && (!dUp || dDn < dUp)) downFirst += w;
    else {
      upFirst += w / 2;
      downFirst += w / 2;
    }
  }
  return {
    up,
    down,
    upDays: upDays.length ? weightedMedian(upDays, upW) : null,
    downDays: dnDays.length ? weightedMedian(dnDays, dnW) : null,
    upFirst: upFirst + downFirst > 0 ? upFirst / (upFirst + downFirst) : 0.5,
  };
}

function buildScenarios(
  prep: Prepared,
  nb: Sample,
  analogCount: number,
  returns: Float64Array,
  baseReturns: Float64Array,
  price: number,
  T: number,
  H: number,
  dur: (bars: number) => string,
  tr: Translator,
): Scenario[] {
  const { logC, logH, logL } = prep;
  const baseShare = (test: (r: number) => boolean) => {
    let c = 0;
    for (let j = 0; j < baseReturns.length; j++) if (test(baseReturns[j])) c++;
    return baseReturns.length ? c / baseReturns.length : 0;
  };
  const defs: { id: ScenarioId; label: string; test: (r: number) => boolean; fallback: number }[] = [
    { id: 'rally', label: tr('Rally'), test: (r) => r >= T, fallback: T },
    { id: 'range', label: tr('Range'), test: (r) => r > -T && r < T, fallback: 0 },
    { id: 'decline', label: tr('Decline'), test: (r) => r <= -T, fallback: -T },
  ];
  const upT = Math.log(1 + T / 100);
  const dnT = Math.log(1 - T / 100);

  return defs.map((def) => {
    const members: number[] = [];
    for (let j = 0; j < returns.length; j++) if (def.test(returns[j])) members.push(j);
    const w = members.map((j) => nb.w[j]);
    const probability = w.reduce((a, b) => a + b, 0);
    const rets = members.map((j) => returns[j]);
    const [lo, mid, hi] = members.length ? weightedQuantiles(rets, w, [0.25, 0.5, 0.75]) : [def.fallback, def.fallback, def.fallback];

    const confirm: number[] = [];
    const confirmW: number[] = [];
    const extreme: number[] = [];
    const worst: number[] = [];
    const best: number[] = [];
    for (const j of members) {
      const i = nb.idx[j];
      const sc = nb.scale[j];
      let dConfirm = 0;
      let dExtreme = H;
      let ext = def.id === 'decline' ? Infinity : -Infinity;
      for (let d = 1; d <= H; d++) {
        const r = (logC[i + d] - logC[i]) * sc;
        if (!dConfirm && ((def.id === 'rally' && r >= upT) || (def.id === 'decline' && r <= dnT))) dConfirm = d;
        if (def.id === 'decline' ? r < ext : r > ext) {
          ext = r;
          dExtreme = d;
        }
      }
      if (dConfirm) {
        confirm.push(dConfirm);
        confirmW.push(nb.w[j]);
      }
      extreme.push(dExtreme);
      const maxUp = pct(prep.mx[i] * sc);
      const maxDn = pct(prep.mn[i] * sc);
      worst.push(def.id === 'decline' ? maxUp : maxDn);
      best.push(def.id === 'decline' ? maxDn : maxUp);
    }
    const adverse = members.length ? weightedMedian(worst, w) : 0;
    const favourable = members.length ? weightedMedian(best, w) : 0;
    const daysToConfirm = confirm.length ? Math.round(weightedMedian(confirm, confirmW)) : null;
    const daysToExtreme = def.id !== 'range' && members.length ? Math.round(weightedMedian(extreme, w)) : null;

    let description: string;
    const conf = daysToConfirm ? dur(daysToConfirm) : '–';
    const ext = dur(daysToExtreme ?? H);
    if (!members.length) {
      description =
        def.id === 'range'
          ? tr('None of the analogs ended within ±{t}%.', { t: T })
          : def.id === 'rally'
            ? tr('None of the analogs ended up {t}% or more.', { t: T })
            : tr('None of the analogs ended down {t}% or more.', { t: T });
    } else if (def.id === 'rally') {
      description = tr('Price ends at least {t}% higher. Analogs crossed +{t}% after about {confirm} and peaked around {extreme} in, after dipping {adverse} at worst on the way.', { t: T, confirm: conf, extreme: ext, adverse: signed(adverse) });
    } else if (def.id === 'decline') {
      description = tr('Price ends at least {t}% lower. Analogs broke −{t}% after about {confirm} and bottomed around {extreme} in, after bouncing {adverse} at best on the way.', { t: T, confirm: conf, extreme: ext, adverse: signed(adverse) });
    } else {
      description = tr('Price ends within ±{t}% of the current price. Typical swings inside the window: {low} low to {high} high.', { t: T, low: signed(adverse), high: signed(favourable) });
    }

    return {
      id: def.id,
      label: def.label,
      probability,
      baseProbability: baseShare(def.test),
      targetPct: mid,
      targetPrice: price * (1 + mid / 100),
      lowPrice: price * (1 + lo / 100),
      highPrice: price * (1 + hi / 100),
      daysToConfirm,
      daysToExtreme,
      adverseExcursionPct: adverse,
      favourableExcursionPct: favourable,
      analogs: members.filter((j) => j < analogCount).length,
      description,
    };
  });
}

function histogram(returns: Float64Array, w: ArrayLike<number>, baseReturns: Float64Array): HistogramBin[] {
  const uniform = new Float64Array(baseReturns.length).fill(1);
  const [lo, hi] = weightedQuantiles(baseReturns, uniform, [0.02, 0.98]);
  const all = weightedQuantiles(returns, w, [0.02, 0.98]);
  const min = Math.min(lo, all[0]);
  const max = Math.max(hi, all[1]);
  const span = max - min || 1;
  const step = [0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20].find((s) => span / s <= 30) ?? 25;
  const from = Math.floor(min / step) * step;
  const bins = Math.max(1, Math.ceil((max - from) / step));
  const out: HistogramBin[] = Array.from({ length: bins }, (_, b) => ({
    from: +(from + b * step).toFixed(4),
    to: +(from + (b + 1) * step).toFixed(4),
    model: 0,
    base: 0,
  }));
  const bin = (r: number) => clamp(Math.floor((r - from) / step), 0, bins - 1);
  for (let j = 0; j < returns.length; j++) out[bin(returns[j])].model += w[j];
  for (let j = 0; j < baseReturns.length; j++) out[bin(baseReturns[j])].base += 1 / baseReturns.length;
  return out;
}

export interface ForecastContext {
  ds: Dataset;
  prep: Prepared;
  /** Latest bar (possibly still forming): the forecast starts from its time and price. */
  q: number;
  /** Last closed bar: model inputs, analogs and the base rate are all taken from here. */
  qf: number;
  price: number;
  nb: Neighbors;
  base: Sample;
  /** Analogs blended with the base rate: the sample every reported statistic is computed on. */
  mix: Sample;
  dropped: { id: string; reason: string }[];
  featureIds: string[];
  thresholdPct: number;
  /** One step of the touch / bracket ladder, in %. */
  unitPct: number;
  model: ReturnType<typeof buildModel>['model'];
}

/** Shared by the forecast and the trade-setup endpoints: select today's analogs. */
export function forecastContext(ds: Dataset, prep: Prepared, s: ForecastSettings, tr: Translator = EN): ForecastContext {
  const q = ds.n - 1;
  const qf = ds.lastClosed;
  const { model, dropped } = buildModel(ds, s.features, s.startYear, tr, qf);
  if (model.ids.length === 0) {
    throw new ForecastError(
      dropped.length
        ? tr('None of the selected model inputs can be used right now ({ids}).', { ids: dropped.map((d) => metricShort(d.id, tr)).join(', ') })
        : tr('Select at least one metric as a model input.'),
    );
  }
  // Analogs must have finished their whole forward window by the last close.
  const maxCand = qf - s.horizon;
  const nb = findNeighbors(ds, model, prep, qf, maxCand, s, makeScratch(ds.n));
  if (!nb) {
    throw new ForecastError(tr('Not enough history for this combination of inputs. Try an earlier start year or fewer inputs.'));
  }
  const base = baseSample(ds, prep, model.start, qf, maxCand, s);
  return {
    ds,
    prep,
    q,
    qf,
    price: ds.c[q],
    nb,
    base,
    mix: mixSamples(nb, base, baseWeight(s, nb)),
    dropped,
    featureIds: model.ids,
    thresholdPct: scenarioThreshold(ds, qf, s),
    unitPct: moveUnit(ds, qf, s.horizon),
    model,
  };
}

export function runForecast(ds: Dataset, prep: Prepared, s: ForecastSettings, tr: Translator = EN): ForecastResult {
  const ctx = forecastContext(ds, prep, s, tr);
  const { q, qf, price, nb, base, mix, model } = ctx;
  const H = s.horizon;
  const T = ctx.thresholdPct;
  const dur = (bars: number) => tr.dur(ds.tf, bars);

  const { stats: terminal, returns } = terminalStats(prep, mix);
  const { stats: baseStats, returns: baseReturns } = terminalStats(prep, base);

  // Fan chart: weighted quantiles of the modelled closes, bar by bar (thinned on long horizons).
  const cone: ConePoint[] = [{ day: 0, t: ds.t[q], p10: price, p25: price, p50: price, p75: price, p90: price }];
  const col = new Float64Array(mix.idx.length);
  const coneStep = Math.max(1, Math.ceil(H / MAX_CONE_POINTS));
  for (let d = coneStep; d <= H; d = d + coneStep > H && d < H ? H : d + coneStep) {
    for (let j = 0; j < mix.idx.length; j++) col[j] = (prep.logC[mix.idx[j] + d] - prep.logC[mix.idx[j]]) * mix.scale[j];
    const [a, b, c, e, f] = weightedQuantiles(col, mix.w, [0.1, 0.25, 0.5, 0.75, 0.9]);
    cone.push({
      day: d,
      t: addBars(ds.tf, ds.t[q], d),
      p10: price * Math.exp(a),
      p25: price * Math.exp(b),
      p50: price * Math.exp(c),
      p75: price * Math.exp(e),
      p90: price * Math.exp(f),
    });
  }

  const scenarios = buildScenarios(prep, mix, nb.idx.length, returns, baseReturns, price, T, H, dur, tr).sort((a, b) => b.probability - a.probability);

  const touch: TouchProbability[] = LADDER.map((k) => +(k * ctx.unitPct).toFixed(4)).map((level) => {
    const m = touchStats(prep, mix, level);
    const b = touchStats(prep, base, level);
    return {
      pct: level,
      up: m.up,
      down: m.down,
      baseUp: b.up,
      baseDown: b.down,
      upDays: m.upDays,
      downDays: m.downDays,
      upFirst: m.upFirst,
      upPrice: price * (1 + level / 100),
      downPrice: price * (1 - level / 100),
    };
  });

  const bandQs = weightedQuantiles(returns, mix.w, [0.25, 0.75, 0.2, 0.8, 0.1, 0.9]);
  const bands = [0.5, 0.6, 0.8].map((confidence, b) => ({
    confidence,
    lowPct: bandQs[b * 2],
    highPct: bandQs[b * 2 + 1],
    lowPrice: price * (1 + bandQs[b * 2] / 100),
    highPrice: price * (1 + bandQs[b * 2 + 1] / 100),
  }));

  const analogs: AnalogMatch[] = nb.idx.map((i, j) => ({
    t: ds.t[i],
    price: ds.c[i],
    distance: nb.dist[j],
    weight: nb.w[j],
    fwdReturnPct: pct(prep.fwd[i]),
    usedReturnPct: pct(prep.fwd[i] * nb.scale[j]),
    maxUpPct: pct(prep.mx[i] * nb.scale[j]),
    maxDownPct: pct(prep.mn[i] * nb.scale[j]),
  }));

  const featuresUsed = model.ids.map((id, f) => {
    const { mean, sd } = featureStats(model, f, qf);
    return {
      id,
      name: metricShort(id, tr),
      value: ds.series.get(id)?.[qf] ?? NaN,
      z: (model.cols[f][qf] - mean) / sd,
    };
  });
  for (const f of featuresUsed) {
    // Delayed series have no display value on the last bars: show the latest one instead.
    if (Number.isNaN(f.value)) {
      const x = ds.series.get(f.id);
      for (let i = qf; x && i >= 0 && i > qf - 45; i--) {
        if (!Number.isNaN(x[i])) {
          f.value = x[i];
          break;
        }
      }
    }
  }

  // Confidence = how much evidence backs the numbers, not how bullish or bearish they are.
  // effectiveN counts independent analogs (overlapping forward windows count once), so these
  // thresholds are lower than for raw analog counts.
  const essScore = clamp(nb.effectiveN / 30, 0, 1);
  const simScore = clamp((1.5 - nb.avgDistance) / 1.0, 0, 1);
  const score = 0.5 * essScore + 0.5 * simScore;
  // The label follows the weaker of the two: close matches are worth little if there are only a few.
  let matchLabel: 'low' | 'moderate' | 'good' = nb.avgDistance <= 0.6 ? 'good' : nb.avgDistance <= 1.1 ? 'moderate' : 'low';
  if (nb.effectiveN < 8) matchLabel = 'low';
  else if (nb.effectiveN < 20 && matchLabel === 'good') matchLabel = 'moderate';
  const notes: string[] = [];
  const dist = nb.avgDistance.toFixed(2);
  notes.push(
    nb.avgDistance <= 0.6
      ? tr('Analogs are close matches (average distance {d}σ per input).', { d: dist })
      : nb.avgDistance <= 1.1
        ? tr('Analogs are moderate matches (average distance {d}σ per input).', { d: dist })
        : tr('The current setup has few true precedents: the nearest analogs are {d}σ away per input. Use fewer inputs or treat the result as close to the base rate.', { d: dist }),
  );
  notes.push(
    tr('{k} analogs from {cand} eligible past bars (effective sample ≈ {ess}). With a {dur} horizon, a 10-point probability difference is within sampling noise below ~100 samples.', {
      k: nb.idx.length,
      cand: nb.candidates.toLocaleString('en-US'),
      ess: nb.effectiveN.toFixed(0),
      dur: dur(H),
    }),
  );
  const blendW = baseWeight(s, nb);
  if (blendW > 0) {
    notes.push(
      tr('Probabilities are {a}% analogs + {b}% base rate ({n} past {dur} windows).', {
        a: Math.round((1 - blendW) * 100),
        b: Math.round(blendW * 100),
        n: base.idx.length.toLocaleString('en-US'),
        dur: dur(H),
      }),
    );
  }
  if (ctx.dropped.length) {
    notes.push(tr('Ignored inputs: {list}.', { list: ctx.dropped.map((d) => `${metricShort(d.id, tr)} (${d.reason})`).join('; ') }));
  }
  const firstT = ds.t[Math.min(...nb.idx)];
  const lastT = ds.t[Math.max(...nb.idx)];

  const top = scenarios[0];
  const b60 = bands[1];
  const headline =
    tr('Most likely over the next {dur}: {scenario} ({p}%)', { dur: dur(H), scenario: top.label.toLowerCase(), p: Math.round(top.probability * 100) }) +
    (top.id === 'range'
      ? tr(', ending within ±{t}% of the current price, around {price}.', { t: T, price: usd(top.targetPrice) })
      : tr(', median target {price} ({pct})', { price: usd(top.targetPrice), pct: signed(top.targetPct) }) +
        (top.daysToExtreme
          ? tr(top.id === 'rally' ? ', typically peaking about {dur} in' : ', typically bottoming about {dur} in', { dur: dur(top.daysToExtreme) })
          : '') +
        '.') +
    tr(' 60% of modelled outcomes end between {low} and {high}.', { low: usd(b60.lowPrice), high: usd(b60.highPrice) });

  return {
    asOf: ds.t[q],
    price,
    settings: s,
    thresholdPct: T,
    moveUnitPct: ctx.unitPct,
    featuresUsed,
    featuresDropped: ctx.dropped,
    sample: {
      candidates: nb.candidates,
      neighbors: nb.idx.length,
      effectiveN: nb.effectiveN,
      from: firstT,
      to: lastT,
      avgDistance: nb.avgDistance,
    },
    cone,
    terminal,
    base: baseStats,
    histogram: histogram(returns, mix.w, baseReturns),
    bands,
    scenarios,
    touch,
    analogs,
    confidence: { label: matchLabel, score, notes },
    headline,
  };
}
