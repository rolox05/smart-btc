import type { KellySizing, RiskStats, TradeGridCell, TradeOutcome, TradeSetupRequest, TradeSetupResult } from '@smart-btc/shared';
import { weightedQuantiles } from './stats.js';
import type { Dataset } from '../analytics/dataset.js';
import { MAINT_MARGIN, liquidationPrice as liqPrice } from '../analytics/leverage.js';
import type { Prepared } from './analog.js';
import { forecastContext, type Sample } from './forecast.js';
import { EN, type T } from '../i18n/index.js';


interface SimCosts {
  feePct: number;
  /** Funding paid per bar by this side, in % of notional (negative = received). */
  fundingPctPerBar: number;
}

/**
 * Replay a stop-loss / take-profit bracket over every sample path.
 * Bars cannot tell which level was hit first when both trade inside the same bar,
 * so that case is counted as a stop: the pessimistic reading.
 */
export function simulate(
  prep: Prepared,
  s: Sample,
  side: 'long' | 'short',
  stopPct: number,
  takePct: number,
  costs: SimCosts,
): TradeOutcome {
  const { logC, logH, logL, H } = prep;
  const dir = side === 'long' ? 1 : -1;
  const stopLvl = side === 'long' ? Math.log(1 - stopPct / 100) : Math.log(1 + stopPct / 100);
  const takeLvl = side === 'long' ? Math.log(1 + takePct / 100) : Math.log(1 - Math.min(takePct, 99) / 100);
  let pTake = 0;
  let pStop = 0;
  let pTimeout = 0;
  let timeoutRet = 0;
  let takeBars = 0;
  let stopBars = 0;
  let holdBars = 0;

  for (let j = 0; j < s.idx.length; j++) {
    const i = s.idx[j];
    const sc = s.scale[j];
    const w = s.w[j];
    let done = false;
    for (let d = 1; d <= H; d++) {
      const hi = (logH[i + d] - logC[i]) * sc;
      const lo = (logL[i + d] - logC[i]) * sc;
      const stopped = side === 'long' ? lo <= stopLvl : hi >= stopLvl;
      const taken = side === 'long' ? hi >= takeLvl : lo <= takeLvl;
      if (stopped) {
        pStop += w;
        stopBars += w * d;
        holdBars += w * d;
        done = true;
        break;
      }
      if (taken) {
        pTake += w;
        takeBars += w * d;
        holdBars += w * d;
        done = true;
        break;
      }
    }
    if (!done) {
      pTimeout += w;
      timeoutRet += w * dir * (Math.exp((logC[i + H] - logC[i]) * sc) - 1) * 100;
      holdBars += w * H;
    }
  }
  const avgTimeoutPct = pTimeout > 0 ? timeoutRet / pTimeout : 0;
  const evPct = pTake * takePct - pStop * stopPct + pTimeout * avgTimeoutPct;
  const costPct = costs.feePct + costs.fundingPctPerBar * holdBars;
  return {
    pTake,
    pStop,
    pTimeout,
    avgTimeoutPct,
    daysToTake: pTake > 0 ? takeBars / pTake : null,
    daysToStop: pStop > 0 ? stopBars / pStop : null,
    evPct,
    evR: (evPct - costPct) / stopPct,
  };
}

/**
 * Kelly sizing on the bracket's outcome distribution: the share f of the account risked per trade that
 * maximises expected log growth, Σ p·ln(1 + f·x), with x the outcome in R (target, stop, or the average
 * result at the horizon) after costs. Full Kelly is very volatile, which is why traders use a fraction.
 */
export function kellySizing(o: TradeOutcome, stopPct: number, takePct: number, fraction: number): KellySizing {
  const costR = Math.max(0, o.evPct / stopPct - o.evR);
  const outcomes: [number, number][] = [
    [o.pTake, takePct / stopPct - costR],
    [o.pStop, -1 - costR],
    [o.pTimeout, o.avgTimeoutPct / stopPct - costR],
  ];
  const fMax = 0.99 / (1 + costR);
  let best = 0;
  let bestG = 0;
  for (let f = 0.0005; f < Math.min(fMax, 0.6); f += 0.0005) {
    let g = 0;
    for (const [p, x] of outcomes) if (p > 0) g += p * Math.log(1 + f * x);
    if (g > bestG) {
      bestG = g;
      best = f;
    }
  }
  return { fullRiskPct: best * 100, suggestedRiskPct: best * 100 * fraction, fraction };
}

/**
 * Value at Risk, Expected Shortfall and adverse excursion over the horizon from the modelled paths,
 * holding the position without a stop: the tail the stop is there to cut off.
 */
export function riskStats(prep: Prepared, s: Sample, side: 'long' | 'short', confidence: number, stopPct: number, notional: number): RiskStats {
  const { logC, logH, logL, H } = prep;
  const n = s.idx.length;
  const loss = new Float64Array(n);
  const mae = new Float64Array(n);
  let beyond = 0;
  for (let j = 0; j < n; j++) {
    const i = s.idx[j];
    const sc = s.scale[j];
    const r = Math.exp((logC[i + H] - logC[i]) * sc) - 1;
    loss[j] = (side === 'long' ? -r : r) * 100;
    let worst = 0;
    for (let d = 1; d <= H; d++) {
      const against = side === 'long' ? 1 - Math.exp((logL[i + d] - logC[i]) * sc) : Math.exp((logH[i + d] - logC[i]) * sc) - 1;
      if (against > worst) worst = against;
    }
    mae[j] = worst * 100;
    if (mae[j] >= stopPct) beyond += s.w[j];
  }
  const [varPct] = weightedQuantiles(loss, s.w, [confidence]);
  const [maePct] = weightedQuantiles(mae, s.w, [confidence]);
  // Expected Shortfall: weighted mean of the losses at or beyond VaR.
  let num = 0;
  let den = 0;
  for (let j = 0; j < n; j++) {
    if (loss[j] >= varPct) {
      num += s.w[j] * loss[j];
      den += s.w[j];
    }
  }
  const esPct = den > 0 ? num / den : varPct;
  return {
    confidence,
    varPct,
    esPct,
    maePct,
    varUsd: (Math.max(0, varPct) / 100) * notional,
    esUsd: (Math.max(0, esPct) / 100) * notional,
    pBeyondStop: beyond,
  };
}

/** Stop and target distances of the comparison grid, as multiples of the move unit. */
const GRID_STOPS = [1, 1.5, 2, 3, 4];
const GRID_TAKES = [1.5, 2, 3, 4, 6, 8];

export function runTradeSetup(ds: Dataset, prep: Prepared, req: TradeSetupRequest, t: T = EN): TradeSetupResult {
  const ctx = forecastContext(ds, prep, req.settings, t);
  const { nb, base, mix, q, qf } = ctx;
  const entry = req.entry > 0 ? req.entry : ctx.price;
  const dir = req.side === 'long' ? 1 : -1;
  const atrPct = (ds.atr14[qf] / ctx.price) * 100;
  // Stops in ATR multiples and targets in R multiples, as most discretionary traders set them.
  const stopPct = req.stopMode === 'atr' && atrPct > 0 ? Math.min(50, Math.max(0.05, (req.stopAtr ?? 2) * atrPct)) : req.stopPct;
  const takePct = req.takeMode === 'r' ? Math.min(200, Math.max(0.05, (req.takeR ?? 2) * stopPct)) : req.takePct;
  const stopFrac = stopPct / 100;
  const takeFrac = takePct / 100;

  const funding = Number.isNaN(ds.fundingPerDay[qf]) ? 0 : ds.fundingPerDay[qf] * 100;
  const costsFor = (side: 'long' | 'short'): SimCosts => ({
    feePct: (2 * req.feeBps) / 100,
    fundingPctPerBar: (side === 'long' ? funding : -funding) * ds.barDays,
  });

  const model = simulate(prep, mix, req.side, stopPct, takePct, costsFor(req.side));
  const baseOut = simulate(prep, base, req.side, stopPct, takePct, costsFor(req.side));
  const other = req.side === 'long' ? 'short' : 'long';
  const opposite = simulate(prep, mix, other, stopPct, takePct, costsFor(other));

  const grid: TradeGridCell[] = [];
  for (const stopPct of GRID_STOPS.map((k) => +(k * ctx.unitPct).toFixed(4))) {
    for (const takePct of GRID_TAKES.map((k) => +(k * ctx.unitPct).toFixed(4))) {
      const o = simulate(prep, mix, req.side, stopPct, takePct, costsFor(req.side));
      grid.push({ stopPct, takePct, pTake: o.pTake, pStop: o.pStop, evR: o.evR });
    }
  }

  const liquidationPrice = liqPrice(entry, req.leverage, req.side);
  const stopPrice = entry * (1 - dir * stopFrac);
  const takePrice = entry * (1 + dir * takeFrac);
  const maxSafeLeverage = Math.max(1, Math.floor(1 / (stopFrac + MAINT_MARGIN + 0.005)));

  const riskUsd = (req.accountUsd * req.riskPct) / 100;
  const positionNotionalUsd = riskUsd / stopFrac;
  const marginUsd = positionNotionalUsd / req.leverage;
  const costPct = (2 * req.feeBps) / 100;

  const warnings: string[] = [];
  if (req.leverage > maxSafeLeverage) {
    warnings.push(
      t('At {lev}× the position is liquidated near {liq} – before your stop at {stop}. Use {safe}× or less for this stop distance.', { lev: req.leverage, liq: Math.round(liquidationPrice).toLocaleString('en-US'), stop: Math.round(stopPrice).toLocaleString('en-US'), safe: maxSafeLeverage }),
    );
  }
  if (marginUsd > req.accountUsd) {
    warnings.push(
      t('This size needs ${margin} of margin, more than the account. Raise leverage to at least {lev}× (if the stop allows it) or lower the risk per trade.', { margin: Math.round(marginUsd).toLocaleString('en-US'), lev: Math.ceil(positionNotionalUsd / req.accountUsd) }),
    );
  }
  if (req.riskPct > 2) warnings.push(t('Risking more than 2% of the account per trade makes a normal losing streak very costly.'));
  if (model.evR <= 0) warnings.push(t('After costs, this bracket had a negative expected value in the analog sample.'));
  if (nb.effectiveN < 15) warnings.push(t('Small analog sample: the hit probabilities below carry wide error bars.'));
  if (req.entry > 0 && Math.abs(req.entry / ctx.price - 1) > 0.01) {
    warnings.push(t('Probabilities assume you are filled at the entry price now; a resting limit order may never fill.'));
  }
  const kelly = kellySizing(model, stopPct, takePct, req.kellyFraction ?? 0.25);
  const risk = riskStats(prep, mix, req.side, req.confidence ?? 0.95, stopPct, positionNotionalUsd);
  if (kelly.fullRiskPct > 0 && req.riskPct > kelly.fullRiskPct) {
    warnings.push(t('You risk more per trade ({r}%) than full Kelly on these odds ({k}%): beyond that point a larger size lowers long-run growth.', { r: req.riskPct, k: kelly.fullRiskPct.toFixed(2) }));
  }
  if (stopPct < atrPct) {
    warnings.push(
      t('The stop is tighter than the average range of a single bar ({pct}%): ordinary noise will often hit it.', { pct: ((ds.atr14[qf] / ctx.price) * 100).toFixed(1) }),
    );
  }

  return {
    side: req.side,
    entry,
    stopPrice,
    takePrice,
    liquidationPrice,
    maxSafeLeverage,
    stopPct,
    takePct,
    risk,
    kelly,
    rewardRisk: takePct / stopPct,
    breakevenWinRate: stopPct / (stopPct + takePct),
    positionNotionalUsd,
    positionBtc: positionNotionalUsd / entry,
    marginUsd,
    riskUsd,
    rewardUsd: positionNotionalUsd * takeFrac,
    costPct,
    fundingPctPerDay: req.side === 'long' ? funding : -funding,
    atrPct,
    model,
    base: baseOut,
    opposite,
    grid,
    warnings,
    timeframe: ds.tf,
    horizon: req.settings.horizon,
    effectiveN: nb.effectiveN,
  };
}
