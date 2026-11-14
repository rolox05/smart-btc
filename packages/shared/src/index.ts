/**
 * Types and constants shared by the API server and the web client.
 * Keep this package free of runtime dependencies so both sides can import it as source.
 */

export const DAY = 86_400;

// ───────────────────────── languages ─────────────────────────

export const LANGS = ['en', 'es', 'pt'] as const;
export type Lang = (typeof LANGS)[number];
export const LANG_NAME: Record<Lang, string> = { en: 'English', es: 'Español', pt: 'Português' };

/** Translation table: English source text → translated text. A missing entry falls back to the English text. */
export type Dict = Record<string, string>;
export type Vars = Record<string, string | number>;

/** Look up `key` (the English text) in `dict` and fill its {placeholders} from `vars`. */
export function translate(dict: Dict | undefined, key: string, vars?: Vars): string {
  const s = dict?.[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Pick the supported language closest to a browser or Accept-Language value. */
export function pickLang(value: string | null | undefined): Lang {
  const v = (value ?? '').toLowerCase();
  for (const part of v.split(',')) {
    const code = part.trim().slice(0, 2);
    if ((LANGS as readonly string[]).includes(code)) return code as Lang;
  }
  return 'en';
}

const UNITS: Record<Lang, { min: string; h: string; d: string; w: string; mo: string }> = {
  en: { min: 'm', h: 'h', d: 'd', w: 'w', mo: 'mo' },
  es: { min: 'min', h: 'h', d: 'd', w: 'sem', mo: 'mes' },
  pt: { min: 'min', h: 'h', d: 'd', w: 'sem', mo: 'mês' },
};

// ───────────────────────── timeframes ─────────────────────────

export const TIMEFRAMES = ['15m', '1h', '4h', '1d', '1w', '1M'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface TimeframeInfo {
  label: string;
  /** Bar length in seconds (the monthly value is the average month). */
  barSec: number;
  barsPerYear: number;
  /** Forecast horizons offered on this timeframe, in bars. */
  horizons: number[];
  defaultHorizon: number;
  /** Chart ranges offered on this timeframe, in bars (0 = everything loaded). */
  ranges: { id: string; bars: number }[];
  defaultRange: string;
  /** Sensible starting stop / target distances (%) for the trade setup. */
  bracket: { stopPct: number; takePct: number };
}

export const TF_INFO: Record<Timeframe, TimeframeInfo> = {
  '15m': {
    label: '15m', barSec: 900, barsPerYear: 35_040, horizons: [16, 48, 96, 192], defaultHorizon: 96,
    ranges: [{ id: '1D', bars: 96 }, { id: '3D', bars: 288 }, { id: '1W', bars: 672 }, { id: '2W', bars: 1344 }, { id: '1M', bars: 2880 }],
    defaultRange: '3D', bracket: { stopPct: 0.5, takePct: 1 },
  },
  '1h': {
    label: '1h', barSec: 3600, barsPerYear: 8760, horizons: [12, 24, 72, 168], defaultHorizon: 24,
    ranges: [{ id: '3D', bars: 72 }, { id: '1W', bars: 168 }, { id: '2W', bars: 336 }, { id: '1M', bars: 720 }, { id: '3M', bars: 2160 }],
    defaultRange: '2W', bracket: { stopPct: 1, takePct: 2 },
  },
  '4h': {
    label: '4h', barSec: 14_400, barsPerYear: 2190, horizons: [6, 18, 42, 84], defaultHorizon: 42,
    ranges: [{ id: '2W', bars: 84 }, { id: '1M', bars: 180 }, { id: '3M', bars: 540 }, { id: '6M', bars: 1095 }, { id: '1Y', bars: 2190 }],
    defaultRange: '3M', bracket: { stopPct: 2.5, takePct: 5 },
  },
  '1d': {
    label: '24h', barSec: 86_400, barsPerYear: 365, horizons: [7, 14, 30, 60, 90], defaultHorizon: 30,
    ranges: [{ id: '3M', bars: 92 }, { id: '6M', bars: 183 }, { id: '1Y', bars: 365 }, { id: '2Y', bars: 730 }, { id: '4Y', bars: 1461 }, { id: 'All', bars: 0 }],
    defaultRange: '1Y', bracket: { stopPct: 5, takePct: 10 },
  },
  '1w': {
    label: '1w', barSec: 604_800, barsPerYear: 52.18, horizons: [4, 8, 13, 26], defaultHorizon: 8,
    ranges: [{ id: '1Y', bars: 52 }, { id: '2Y', bars: 104 }, { id: '4Y', bars: 209 }, { id: '8Y', bars: 417 }, { id: 'All', bars: 0 }],
    defaultRange: '4Y', bracket: { stopPct: 10, takePct: 20 },
  },
  '1M': {
    label: '1M', barSec: 2_629_800, barsPerYear: 12, horizons: [3, 6, 12], defaultHorizon: 3,
    ranges: [{ id: '4Y', bars: 48 }, { id: '8Y', bars: 96 }, { id: 'All', bars: 0 }],
    defaultRange: 'All', bracket: { stopPct: 15, takePct: 30 },
  },
};

/** Human label for a number of bars on a timeframe, e.g. (15m, 16) → "4h", (1d, 30) → "30d". */
export function durationLabel(tf: Timeframe, bars: number, lang: Lang = 'en'): string {
  const u = UNITS[lang];
  const n = Math.round(bars * 10) / 10;
  if (tf === '1M') return `${Math.round(n)}${u.mo}`;
  if (tf === '1w') return `${Math.round(n)}${u.w}`;
  const hours = (n * TF_INFO[tf].barSec) / 3600;
  if (hours < 1) return `${Math.round(hours * 60)}${u.min}`;
  if (hours < 48 && hours % 24 !== 0) return `${Math.round(hours)}${u.h}`;
  const days = hours / 24;
  return `${Number.isInteger(days) ? days : days.toFixed(1).replace('.', lang === 'en' ? '.' : ',')}${u.d}`;
}

/** Unix time (seconds) of the bar `k` bars after the bar that opens at `t`. */
export function addBars(tf: Timeframe, t: number, k: number): number {
  if (tf !== '1M') return t + k * TF_INFO[tf].barSec;
  const d = new Date(t * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1) / 1000;
}

// ───────────────────────── market data ─────────────────────────

/** OHLCV bar. `t` is the bar's opening time in unix seconds (UTC). */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Ticker {
  price: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  volume24hUsd: number;
  source: string;
  at: number;
}

// ───────────────────────── metrics ─────────────────────────

export type MetricGroup =
  | 'trend'
  | 'momentum'
  | 'volatility'
  | 'drawdown'
  | 'onchain'
  | 'derivatives'
  | 'sentiment'
  | 'liquidity'
  | 'macro'
  | 'cycle';

export const METRIC_GROUP_LABEL: Record<MetricGroup, string> = {
  trend: 'Trend',
  momentum: 'Momentum',
  volatility: 'Volatility',
  drawdown: 'Drawdown',
  onchain: 'On-chain',
  derivatives: 'Derivatives',
  sentiment: 'Sentiment',
  liquidity: 'Liquidity',
  macro: 'Macro',
  cycle: 'Cycle',
};

export type MetricUnit = 'price' | 'pct' | 'ratio' | 'index' | 'days' | 'usd';

export interface MetricDef {
  id: string;
  name: string;
  short: string;
  group: MetricGroup;
  description: string;
  /** Human readable data source, shown in the UI. */
  source: string;
  /** `overlay` series share the price axis; `pane` series get their own pane. */
  display: 'overlay' | 'pane';
  /** Metrics with the same pane id are drawn in the same pane (same unit, same axis). */
  pane?: string;
  unit: MetricUnit;
  /** Categorical colour slot (0-7), resolved to a hex by the client. */
  colorSlot: number;
  /** Whether the metric can be used as a feature of the analog model. */
  forecastable: boolean;
  defaultVisible: boolean;
  defaultInModel: boolean;
  /** Horizontal reference levels, e.g. RSI 30 / 70. */
  bands?: { value: number; label: string }[];
  /** Days the free data source lags behind real time (values are carried forward). */
  delayedDays?: number;
  /** Extra series drawn with the same style (e.g. the lower Bollinger band). */
  companions?: string[];
  /** Label and colour slot for companion series that need their own identity (e.g. ±1σ bands). */
  companionInfo?: Record<string, { label: string; colorSlot: number }>;
  /** Colour the line by its side of price: bullish colour while it runs below price, bearish above. */
  colorByPrice?: boolean;
  /** Longer explanation shown in the guide: how to read the metric, and where it misleads. */
  guide?: { read: string[]; caveat?: string };
}

// ───────────────────────── chart annotations ─────────────────────────

/** A signal drawn on top of a metric's pane, e.g. RSI divergences. Toggled independently of the metric. */
export interface AnnotationDef {
  id: string;
  metricId: string;
  name: string;
  description: string;
}

export interface AnnotationSegment {
  kind: 'bullish' | 'bearish';
  /** The two points joined on the metric pane (metric values). */
  t1: number;
  v1: number;
  t2: number;
  v2: number;
  /** Prices at the same two points. */
  price1: number;
  price2: number;
  /** Day on which the second pivot was confirmed and the signal became knowable. */
  confirmedT: number;
}

export interface AnnotationStats {
  kind: 'bullish' | 'bearish';
  label: string;
  count: number;
  /**
   * How the move after past signals unfolded: time from confirmation to the best price in the signal's
   * direction within `lookahead` bars, and the size of that move. Null when there are no past signals.
   */
  move: { lookahead: number; n: number; avgBars: number; medianBars: number; medianPct: number } | null;
  /** Returns measured from the confirmation bar; `bars` is the look-ahead in bars of the timeframe. */
  horizons: { bars: number; n: number; medianPct: number; winRate: number; baseMedianPct: number; baseWinRate: number }[];
}

export interface AnnotationPayload {
  id: string;
  metricId: string;
  segments: AnnotationSegment[];
  stats: AnnotationStats[];
  notes: string[];
}

// ───────────────────────── relations between metrics ─────────────────────────

export type RelationWindow = 'all' | '4y' | '1y';

export interface ForwardRelation {
  id: string;
  /** Rank correlation between the metric's level and the forward return. */
  ic: number | null;
  n: number;
  /** Outcomes after the lowest and highest fifth of readings. */
  low: { medianPct: number; winRate: number; n: number } | null;
  high: { medianPct: number; winRate: number; n: number } | null;
}

export interface Relations {
  window: RelationWindow;
  timeframe: Timeframe;
  from: number;
  to: number;
  /** Look-ahead in bars. */
  horizon: number;
  ids: string[];
  /** Spearman rank correlation of daily levels; matrix[i][j] pairs ids[i] with ids[j]. */
  matrix: (number | null)[][];
  forward: ForwardRelation[];
  base: { medianPct: number; winRate: number; n: number };
}

export interface MetricSnapshot {
  id: string;
  value: number | null;
  /** Percentile (0-100) of the current value against its own history. */
  percentile: number | null;
  /** Change vs 7 days ago, in the metric's own unit. */
  change7d: number | null;
  /** Short qualitative reading, e.g. "oversold". */
  reading: string;
  tone: 'bullish' | 'bearish' | 'neutral';
  /** First day (unix seconds) for which the metric has data. */
  since: number | null;
  /** Last day that carried a fresh (not forward-filled) value. */
  lastFresh: number | null;
}

export interface SeriesPayload {
  /** Shared time axis, unix seconds (UTC day start). */
  t: number[];
  /** One array per requested metric id; `null` where the metric has no value. */
  series: Record<string, (number | null)[]>;
}

// ───────────────────────── data source status ─────────────────────────

export interface SourceStatus {
  id: string;
  name: string;
  url: string;
  provides: string;
  status: 'ok' | 'error' | 'pending' | 'stale';
  lastOk: number | null;
  lastAttempt: number | null;
  message: string;
  rows: number;
}

// ───────────────────────── liquidity ─────────────────────────

export interface LiquidityLevel {
  price: number;
  distancePct: number;
  /** buy-side = resting stops/liquidations above price, sell-side = below. */
  side: 'buy-side' | 'sell-side';
  kind: 'swing' | 'liquidation' | 'orderbook';
  /** Relative strength 0-1 inside its own kind. */
  strength: number;
  /** Estimated notional in USD where it can be estimated. */
  notionalUsd: number | null;
  label: string;
  detail: string;
}

export interface DepthBucket {
  price: number;
  distancePct: number;
  bidUsd: number;
  askUsd: number;
}

export interface LiquidityReport {
  at: number;
  price: number;
  swings: LiquidityLevel[];
  liquidations: LiquidityLevel[];
  walls: LiquidityLevel[];
  depth: DepthBucket[];
  /** Liquidation estimate profile, for the heat strip. */
  liqProfile: { price: number; distancePct: number; longUsd: number; shortUsd: number }[];
  summary: {
    bidDepthUsd: Record<string, number>;
    askDepthUsd: Record<string, number>;
    /** (bid - ask) / (bid + ask) within 2% of mid. */
    bookImbalance2Pct: number | null;
    nearestAbove: LiquidityLevel | null;
    nearestBelow: LiquidityLevel | null;
    /** Share of estimated liquidation notional within ±15% that sits above price. */
    liqSkewAbove: number | null;
    venues: string[];
    notes: string[];
  };
}

/**
 * Estimated liquidation levels through time: for every hour, how much leveraged notional would be
 * force-closed at each price. A level appears when positions are opened and disappears once price trades through it.
 */
export const HEATMAP_WINDOWS = ['12h', '24h', '48h', '3d', '1w', '2w', '1m', '3m', '6m', '1y', '2y', '3y', '4y', 'All'] as const;
export type HeatmapWindow = (typeof HEATMAP_WINDOWS)[number];

export interface LiquidationHeatmap {
  at: number;
  window: HeatmapWindow;
  /** Bar size the map is drawn at for this window. */
  timeframe: Timeframe;
  /** Column times (bar opens, unix seconds). */
  t: number[];
  /** Price of the lower edge of row 0, and the height of one row, in USD. */
  priceMin: number;
  priceStep: number;
  rows: number;
  /** rows × cols intensities 0-255, row-major from the lowest price row, base64-encoded. */
  data: string;
  /** Estimated notional (USD) represented by intensity 255. */
  maxUsd: number;
  /** Candles for the same columns. */
  candles: Candle[];
  notes: string[];
}

// ───────────────────────── forecast ─────────────────────────

export interface ForecastSettings {
  /** Bar size everything is computed on. */
  timeframe: Timeframe;
  /** Forecast horizon in bars of the timeframe. */
  horizon: number;
  /** Metric ids used to measure similarity between today and past days. */
  features: string[];
  /** Number of historical analogs. */
  k: number;
  /** Minimum spacing between two analogs, in bars (de-clustering). */
  minGapBars: number;
  /** Rescale analog paths to today's volatility regime. */
  volAdjust: boolean;
  /** Ignore history before this year. */
  startYear: number;
  /** Half life (years) for down-weighting old analogs. 0 = no decay. */
  recencyHalfLifeYears: number;
  /** Scenario threshold in % (rally >= +x, decline <= -x). 0 = auto from volatility. */
  scenarioThresholdPct: number;
  /**
   * Weight (0-1) of the unconditional base rate in the final distribution.
   * 0 = analogs only, 1 = base rate only. Blending tames the noise of a small analog sample.
   */
  baseRateBlend: number;
  /**
   * Model internals, normally left unset so the tested defaults apply (see MODEL_DEFAULTS on the server).
   * Exposed so the research bench can compare alternatives with the same walk-forward backtest.
   */
  distance?: 'euclidean' | 'mahalanobis';
  /** Minimum spacing between analogs as a fraction of the horizon (on top of minGapBars). */
  analogGapFraction?: number;
  /** Kernel bandwidth: the furthest analog ('wide') or the median analog distance ('median'). */
  kernel?: 'wide' | 'median';
  /** 'adaptive' sets the base-rate weight from the evidence: κ / (independent analogs + κ). */
  blendMode?: 'fixed' | 'adaptive';
  blendKappa?: number;
}

export const DEFAULT_FORECAST_SETTINGS: ForecastSettings = {
  timeframe: '1d',
  horizon: 30,
  features: [],
  k: 60,
  minGapBars: 5,
  volAdjust: true,
  startYear: 2013,
  recencyHalfLifeYears: 0,
  scenarioThresholdPct: 0,
  baseRateBlend: 0.5,
};


export interface FeatureUse {
  id: string;
  name: string;
  value: number;
  /** z-score of today's value against history (after the metric's transform). */
  z: number;
}

export interface ConePoint {
  /** Bars ahead (0 = now). */
  day: number;
  t: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface DistributionStats {
  /** Probability that price is higher at the horizon. */
  probUp: number;
  /** Returns in %. */
  mean: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export type ScenarioId = 'rally' | 'range' | 'decline';

export interface Scenario {
  id: ScenarioId;
  label: string;
  probability: number;
  /** Same scenario's probability in the unconditional base rate. */
  baseProbability: number;
  /** Median outcome of the analogs in this scenario. */
  targetPrice: number;
  targetPct: number;
  /** Inter-quartile range of the scenario's outcomes. */
  lowPrice: number;
  highPrice: number;
  /** Median bar on which the move crossed the scenario threshold (in bars of the timeframe). */
  daysToConfirm: number | null;
  /** Median bar of the path extreme (peak for rally, trough for decline). */
  daysToExtreme: number | null;
  /** Typical (median) worst move against the scenario on the way, in %. */
  adverseExcursionPct: number;
  /** Typical (median) best move in favour, in %. */
  favourableExcursionPct: number;
  analogs: number;
  description: string;
}

export interface TouchProbability {
  pct: number;
  /** P(high reaches +pct% within the horizon). */
  up: number;
  /** P(low reaches -pct% within the horizon). */
  down: number;
  baseUp: number;
  baseDown: number;
  /** Median bars to first touch among paths that touched. */
  upDays: number | null;
  downDays: number | null;
  /** P(+pct% is reached before -pct%). */
  upFirst: number;
  upPrice: number;
  downPrice: number;
}

export interface AnalogMatch {
  t: number;
  price: number;
  distance: number;
  weight: number;
  /** Realised (not vol-adjusted) forward return over the horizon, %. */
  fwdReturnPct: number;
  /** Vol-adjusted forward return actually used by the model, %. */
  usedReturnPct: number;
  maxUpPct: number;
  maxDownPct: number;
}

export interface HistogramBin {
  from: number;
  to: number;
  model: number;
  base: number;
}

export interface ForecastResult {
  asOf: number;
  price: number;
  settings: ForecastSettings;
  thresholdPct: number;
  /** Size of one step of the touch-level ladder, in % (a quarter of the expected move over the horizon). */
  moveUnitPct: number;
  featuresUsed: FeatureUse[];
  featuresDropped: { id: string; reason: string }[];
  sample: {
    candidates: number;
    neighbors: number;
    effectiveN: number;
    from: number;
    to: number;
    avgDistance: number;
  };
  cone: ConePoint[];
  terminal: DistributionStats;
  base: DistributionStats;
  histogram: HistogramBin[];
  /** Central probability bands, e.g. "60% of outcomes ended between low and high". */
  bands: { confidence: number; lowPrice: number; highPrice: number; lowPct: number; highPct: number }[];
  scenarios: Scenario[];
  touch: TouchProbability[];
  analogs: AnalogMatch[];
  confidence: {
    label: 'low' | 'moderate' | 'good';
    score: number;
    notes: string[];
  };
  headline: string;
}

// ───────────────────────── backtest ─────────────────────────

export interface BacktestRequest {
  settings: ForecastSettings;
  /** Evaluate every n-th bar. */
  stepBars: number;
  /** Touch level (%) scored in the backtest. 0 = automatic (about one expected move). */
  touchPct: number;
}

export interface EventScore {
  event: string;
  label: string;
  /** Observed frequency of the event. */
  frequency: number;
  brier: number;
  brierBase: number;
  /** 1 - brier / brierBase. > 0 means better than the base rate. */
  skill: number;
}

export interface CalibrationBin {
  from: number;
  to: number;
  predicted: number;
  observed: number;
  n: number;
}

export interface SignalBucket {
  label: string;
  n: number;
  winRate: number;
  avgReturnPct: number;
  medianReturnPct: number;
}

export interface BacktestResult {
  settings: ForecastSettings;
  stepBars: number;
  touchPct: number;
  evaluations: number;
  /** Rough number of non-overlapping samples (evaluations * step / horizon). */
  independentSamples: number;
  from: number;
  to: number;
  scores: EventScore[];
  calibration: CalibrationBin[];
  coverage: { nominal: number; observed: number }[];
  signals: SignalBucket[];
  directional: { accuracy: number; alwaysLong: number; n: number };
  /** Mean absolute error of the median forecast vs a naive "no change" forecast, in % points. */
  medianError: { model: number; base: number };
  equity: { t: number; strategy: number; buyHold: number }[];
  strategy: {
    rule: string;
    trades: number;
    totalReturnPct: number;
    buyHoldReturnPct: number;
    maxDrawdownPct: number;
    buyHoldMaxDrawdownPct: number;
    exposure: number;
  };
  timeline: { t: number; pUp: number; realizedPct: number }[];
  verdict: { label: 'no edge' | 'weak edge' | 'measurable edge'; text: string };
  tookMs: number;
}

/** Compact backtest result, used to compare many input sets side by side. */
export interface BacktestSummary {
  features: string[];
  /** Brier skill vs the base rate, averaged over the five scored events. */
  avgSkill: number;
  skills: Record<string, number>;
  evaluations: number;
  from: number;
  to: number;
  /** Directional accuracy minus the always-long hit rate. */
  directionalEdge: number;
  coverage80: number;
  verdict: BacktestResult['verdict']['label'];
}

// ───────────────────────── trade setup ─────────────────────────

export interface TradeSetupRequest {
  settings: ForecastSettings;
  side: 'long' | 'short';
  /** Entry price; 0 = current price. */
  entry: number;
  stopPct: number;
  takePct: number;
  leverage: number;
  accountUsd: number;
  /** % of the account lost if the stop is hit. */
  riskPct: number;
  /** Taker fee per side in basis points. */
  feeBps: number;
}

export interface TradeOutcome {
  pTake: number;
  pStop: number;
  pTimeout: number;
  avgTimeoutPct: number;
  /** Mean bars until the target / the stop was hit. */
  daysToTake: number | null;
  daysToStop: number | null;
  /** Expected value per trade in % of notional, before costs. */
  evPct: number;
  /** Expected value in multiples of the amount risked (R), after costs. */
  evR: number;
}

export interface TradeGridCell {
  stopPct: number;
  takePct: number;
  pTake: number;
  pStop: number;
  evR: number;
}

export interface TradeSetupResult {
  side: 'long' | 'short';
  entry: number;
  stopPrice: number;
  takePrice: number;
  liquidationPrice: number;
  /** Leverage above which liquidation would hit before the stop. */
  maxSafeLeverage: number;
  rewardRisk: number;
  breakevenWinRate: number;
  positionNotionalUsd: number;
  positionBtc: number;
  marginUsd: number;
  riskUsd: number;
  rewardUsd: number;
  costPct: number;
  fundingPctPerDay: number;
  /** Average true range of one bar, % of price. */
  atrPct: number;
  model: TradeOutcome;
  base: TradeOutcome;
  /** The opposite side with the same distances, for comparison. */
  opposite: TradeOutcome;
  grid: TradeGridCell[];
  warnings: string[];
  timeframe: Timeframe;
  /** Horizon in bars. */
  horizon: number;
  effectiveN: number;
}

// ───────────────────────── overview ─────────────────────────

export interface Overview {
  timeframe: Timeframe;
  asOf: number;
  price: number;
  metrics: MetricDef[];
  annotations: AnnotationDef[];
  snapshot: MetricSnapshot[];
  sources: SourceStatus[];
  history: { from: number; to: number; days: number };
}
