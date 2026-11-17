import {
  type BacktestRequest,
  type BacktestResult,
  type CalibrationBin,
  type EventScore,
  type SignalBucket,
} from '@smart-btc/shared';
import type { Dataset } from '../analytics/dataset.js';
import { EN, type T } from '../i18n/index.js';
import { baseWeight, buildModel, findNeighbors, makeScratch, moveUnit, scenarioThreshold, volScale, type Prepared } from './analog.js';
import { ForecastError } from './forecast.js';
import { weightedQuantiles } from './stats.js';

/**
 * Walk-forward backtest.
 *
 * For every evaluation date the forecast is rebuilt using only information available on that date
 * (analogs must have fully completed by then; standardisation uses past data only) and its
 * probabilities are compared with what actually happened, and with the unconditional base rate
 * known on that same date. Skill > 0 means the selected inputs added information over "BTC usually does X".
 */

const EVENTS = ['up', 'rally', 'decline', 'touchUp', 'touchDown'] as const;
type EventId = (typeof EVENTS)[number];

const LONG_ABOVE = 0.55;
const SHORT_BELOW = 0.45;
const TRADE_COST = 0.001; // 10 bps round trip per position
/** Upper bound on scored forecasts, so long intraday histories stay as fast as the daily one. */
const MAX_EVALS = 1500;

export function runBacktest(ds: Dataset, prep: Prepared, req: BacktestRequest, t: T = EN): BacktestResult {
  const started = Date.now();
  const s = req.settings;
  const H = s.horizon;
  const dur = t.dur(ds.tf, H);
  const { model } = buildModel(ds, s.features, s.startYear, t);
  if (model.ids.length === 0) throw new ForecastError(t('Select at least one usable metric as a model input.'));
  const span = ds.n - model.start;
  const step = Math.max(1, Math.round(req.stepBars), Math.ceil((span - H) / MAX_EVALS));
  // Training history required before the first scored forecast; short series (weekly, monthly) get a lower bar.
  const minTrain = Math.min(250 * ds.stride, Math.floor(span * 0.35));
  const minCandidates = Math.min(Math.max(200, s.k * 2), Math.floor(minTrain / ds.stride));
  // Automatic touch level: about one expected move over the horizon at current volatility.
  const touchPct = req.touchPct > 0 ? req.touchPct : +(4 * moveUnit(ds, ds.n - 1, H)).toFixed(4);

  const scratch = makeScratch(ds.n);
  const upT = Math.log(1 + touchPct / 100);
  const dnT = Math.log(1 - touchPct / 100);

  const sums: Record<EventId, { brier: number; brierBase: number; hits: number }> = {
    up: { brier: 0, brierBase: 0, hits: 0 },
    rally: { brier: 0, brierBase: 0, hits: 0 },
    decline: { brier: 0, brierBase: 0, hits: 0 },
    touchUp: { brier: 0, brierBase: 0, hits: 0 },
    touchDown: { brier: 0, brierBase: 0, hits: 0 },
  };
  const calib = Array.from({ length: 10 }, () => ({ p: 0, o: 0, n: 0 }));
  const signalDefs: { label: string; lo: number; hi: number }[] = [
    { label: 'P(up) ≥ 65%', lo: 0.65, hi: 1.01 },
    { label: '55 – 65%', lo: 0.55, hi: 0.65 },
    { label: '45 – 55%', lo: 0.45, hi: 0.55 },
    { label: '35 – 45%', lo: 0.35, hi: 0.45 },
    { label: 'P(up) < 35%', lo: -0.01, hi: 0.35 },
  ];
  const signalRets: number[][] = signalDefs.map(() => []);
  let in80 = 0;
  let in50 = 0;
  let dirHits = 0;
  let absErrModel = 0;
  let absErrNaive = 0;
  let evals = 0;
  const timeline: { t: number; pUp: number; realizedPct: number }[] = [];

  // Non-overlapping strategy: one position per horizon.
  const equity: { t: number; strategy: number; buyHold: number }[] = [];
  let eq = 1;
  let bh = 1;
  let peakEq = 1;
  let peakBh = 1;
  let ddEq = 0;
  let ddBh = 0;
  let trades = 0;
  let exposed = 0;
  let periods = 0;
  let nextTradeIdx = -1;

  const rets = new Float64Array(s.k);
  let firstQ = -1;
  let lastQ = -1;

  for (let q = model.start; q + H < ds.n; q += step) {
    if (!model.complete[q]) continue;
    const maxCand = q - H;
    if (maxCand - model.start < minTrain) continue;
    const nb = findNeighbors(ds, model, prep, q, maxCand, s, scratch);
    if (!nb || nb.candidates < minCandidates) continue;
    const blend = baseWeight(s, nb);

    const T = scenarioThreshold(ds, q, s);
    const rallyT = Math.log(1 + T / 100);
    const declT = Math.log(1 - T / 100);

    // Model probabilities from the analogs.
    const p: Record<EventId, number> = { up: 0, rally: 0, decline: 0, touchUp: 0, touchDown: 0 };
    const m = nb.idx.length;
    const r = m === rets.length ? rets : new Float64Array(m);
    for (let j = 0; j < m; j++) {
      const i = nb.idx[j];
      const sc = nb.scale[j];
      const w = nb.w[j];
      const f = prep.fwd[i] * sc;
      r[j] = f;
      if (f > 0) p.up += w;
      if (f >= rallyT) p.rally += w;
      if (f <= declT) p.decline += w;
      if (prep.mx[i] * sc >= upT) p.touchUp += w;
      if (prep.mn[i] * sc <= dnT) p.touchDown += w;
    }

    // Base rate on the same date: every completed (thinned) bar, same volatility scaling.
    const b: Record<EventId, number> = { up: 0, rally: 0, decline: 0, touchUp: 0, touchDown: 0 };
    let bn = 0;
    // A thinned copy of the base returns is enough to blend the quantiles.
    const thin = Math.max(1, Math.floor((maxCand - model.start) / ds.stride / 500));
    const mixVals: number[] = [];
    for (let i = Math.ceil(model.start / ds.stride) * ds.stride; i <= maxCand; i += ds.stride) {
      const f0 = prep.fwd[i];
      if (Number.isNaN(f0)) continue;
      const sc = volScale(ds, q, i, s.volAdjust, s);
      const f = f0 * sc;
      bn++;
      if (blend > 0 && bn % thin === 0) mixVals.push(f);
      if (f > 0) b.up++;
      if (f >= rallyT) b.rally++;
      if (f <= declT) b.decline++;
      if (prep.mx[i] * sc >= upT) b.touchUp++;
      if (prep.mn[i] * sc <= dnT) b.touchDown++;
    }

    // Blend analogs and base rate exactly as the live forecast does.
    for (const e of EVENTS) p[e] = (1 - blend) * p[e] + blend * (b[e] / bn);
    const nBase = mixVals.length;
    const mixW: number[] = new Array(nBase).fill(nBase ? blend / nBase : 0);
    for (let j = 0; j < m; j++) {
      mixVals.push(r[j]);
      mixW.push(nb.w[j] * (nBase ? 1 - blend : 1));
    }
    const [q10, q25, q50, q75, q90] = weightedQuantiles(mixVals, mixW, [0.1, 0.25, 0.5, 0.75, 0.9]);

    // What actually happened (unscaled).
    const real = prep.fwd[q];
    const o: Record<EventId, number> = {
      up: real > 0 ? 1 : 0,
      rally: real >= rallyT ? 1 : 0,
      decline: real <= declT ? 1 : 0,
      touchUp: prep.mx[q] >= upT ? 1 : 0,
      touchDown: prep.mn[q] <= dnT ? 1 : 0,
    };

    for (const e of EVENTS) {
      const base = b[e] / bn;
      sums[e].brier += (p[e] - o[e]) ** 2;
      sums[e].brierBase += (base - o[e]) ** 2;
      sums[e].hits += o[e];
      const bin = Math.min(9, Math.floor(p[e] * 10));
      calib[bin].p += p[e];
      calib[bin].o += o[e];
      calib[bin].n++;
    }
    if (real >= q10 && real <= q90) in80++;
    if (real >= q25 && real <= q75) in50++;
    if (p.up >= 0.5 === real > 0) dirHits++;
    const realPct = (Math.exp(real) - 1) * 100;
    absErrModel += Math.abs(realPct - (Math.exp(q50) - 1) * 100);
    absErrNaive += Math.abs(realPct);
    const sIdx = signalDefs.findIndex((d) => p.up >= d.lo && p.up < d.hi);
    if (sIdx >= 0) signalRets[sIdx].push(realPct);
    timeline.push({ t: ds.t[q], pUp: p.up, realizedPct: realPct });

    if (q >= nextTradeIdx) {
      const pos = p.up >= LONG_ABOVE ? 1 : p.up <= SHORT_BELOW ? -1 : 0;
      const simple = Math.exp(real) - 1;
      if (equity.length === 0) equity.push({ t: ds.t[q], strategy: 1, buyHold: 1 });
      eq *= 1 + pos * simple - (pos !== 0 ? TRADE_COST : 0);
      eq = Math.max(eq, 0);
      bh *= 1 + simple;
      peakEq = Math.max(peakEq, eq);
      peakBh = Math.max(peakBh, bh);
      ddEq = Math.min(ddEq, eq / peakEq - 1);
      ddBh = Math.min(ddBh, bh / peakBh - 1);
      if (pos !== 0) {
        trades++;
        exposed++;
      }
      periods++;
      equity.push({ t: ds.t[q + H], strategy: eq, buyHold: bh });
      nextTradeIdx = q + H;
    }

    if (firstQ < 0) firstQ = q;
    lastQ = q;
    evals++;
  }

  if (evals < 20) {
    throw new ForecastError(
      t('Too little history to backtest this combination. Pick an earlier start year, a shorter horizon, or inputs with longer history.'),
    );
  }

  const labels: Record<EventId, string> = {
    up: t('Higher after {dur}', { dur }),
    rally: t('Rally scenario (≥ +threshold)'),
    decline: t('Decline scenario (≤ −threshold)'),
    touchUp: t('Touches +{pct}% within {dur}', { pct: touchPct, dur }),
    touchDown: t('Touches −{pct}% within {dur}', { pct: touchPct, dur }),
  };
  const scores: EventScore[] = EVENTS.map((e) => {
    const brier = sums[e].brier / evals;
    const brierBase = sums[e].brierBase / evals;
    return {
      event: e,
      label: labels[e],
      frequency: sums[e].hits / evals,
      brier,
      brierBase,
      skill: brierBase > 0 ? 1 - brier / brierBase : 0,
    };
  });
  const calibration: CalibrationBin[] = calib.map((c, i) => ({
    from: i / 10,
    to: (i + 1) / 10,
    predicted: c.n ? c.p / c.n : (i + 0.5) / 10,
    observed: c.n ? c.o / c.n : 0,
    n: c.n,
  }));
  const signals: SignalBucket[] = signalDefs.map((d, i) => {
    const xs = signalRets[i].slice().sort((a, b) => a - b);
    const n = xs.length;
    return {
      label: d.label,
      n,
      winRate: n ? xs.filter((x) => x > 0).length / n : 0,
      avgReturnPct: n ? xs.reduce((a, c) => a + c, 0) / n : 0,
      medianReturnPct: n ? xs[Math.floor(n / 2)] : 0,
    };
  });

  const avgSkill = scores.reduce((a, sc) => a + sc.skill, 0) / scores.length;
  // Forecasts spaced wider than the horizon do not overlap, so each one counts once at most.
  const independent = Math.max(1, Math.min(evals, Math.round((evals * step) / H)));
  const verdict: BacktestResult['verdict'] =
    avgSkill > 0.03
      ? {
          label: 'measurable edge',
          text: t('Across {n} out-of-sample forecasts these inputs beat the base rate by {skill}% (Brier skill, averaged over five events). That is a real but modest edge; it comes from roughly {windows} non-overlapping windows, so expect it to wobble.', { n: evals.toLocaleString('en-US'), skill: (avgSkill * 100).toFixed(1), windows: independent }),
        }
      : avgSkill > 0.005
        ? {
            label: 'weak edge',
            text: t('These inputs were only marginally better than the base rate (+{skill}% Brier skill). Treat the forecast as "BTC\'s usual behaviour, slightly tilted" rather than as a signal.', { skill: (avgSkill * 100).toFixed(1) }),
          }
        : {
            label: 'no edge',
            text: t('Out of sample, these inputs did not reliably beat the plain base rate ({skill}% Brier skill, inside the noise). The probabilities shown for this configuration are not more reliable than "what BTC usually does over {dur}". Try other inputs, a different horizon, or more analogs.', { skill: (avgSkill * 100).toFixed(1), dur }),
          };

  // Keep the timeline payload small.
  const stride = Math.max(1, Math.ceil(timeline.length / 700));
  return {
    settings: s,
    stepBars: step,
    touchPct,
    evaluations: evals,
    independentSamples: independent,
    from: ds.t[firstQ],
    to: ds.t[lastQ],
    scores,
    calibration,
    coverage: [
      { nominal: 0.8, observed: in80 / evals },
      { nominal: 0.5, observed: in50 / evals },
    ],
    signals,
    directional: { accuracy: dirHits / evals, alwaysLong: sums.up.hits / evals, n: evals },
    medianError: { model: absErrModel / evals, base: absErrNaive / evals },
    equity,
    strategy: {
      rule: t('Every {dur}: long if P(up) ≥ {long}%, short if ≤ {short}%, otherwise flat. 1× leverage, 0.10% cost per trade.', { dur, long: Math.round(LONG_ABOVE * 100), short: Math.round(SHORT_BELOW * 100) }),
      trades,
      totalReturnPct: (eq - 1) * 100,
      buyHoldReturnPct: (bh - 1) * 100,
      maxDrawdownPct: ddEq * 100,
      buyHoldMaxDrawdownPct: ddBh * 100,
      exposure: periods ? exposed / periods : 0,
    },
    timeline: timeline.filter((_, i) => i % stride === 0),
    verdict,
    tookMs: Date.now() - started,
  };
}
