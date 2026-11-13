import { durationLabel, type MetricDef, type Timeframe } from '@smart-btc/shared';
import { GUIDE } from './guide.js';

/**
 * Metric catalogue. To add a metric: describe it here, compute it in dataset.ts,
 * and (if `forecastable`) give it a model transform there. The UI and the model pick it up automatically.
 */
const CATALOGUE: MetricDef[] = [
  // ── price overlays ──
  {
    id: 'sma200', name: '200-day moving average', short: 'SMA 200', group: 'trend',
    description: 'Long-term trend line. Price above it is the classic bull-market regime.',
    source: 'Computed from daily closes', display: 'overlay', unit: 'price', colorSlot: 0,
    forecastable: false, defaultVisible: true, defaultInModel: false,
  },
  {
    id: 'sma50', name: '50-day moving average', short: 'SMA 50', group: 'trend',
    description: 'Medium-term trend line.',
    source: 'Computed from daily closes', display: 'overlay', unit: 'price', colorSlot: 3,
    forecastable: false, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'supertrend', name: 'Supertrend (10, 3)', short: 'Supertrend', group: 'trend',
    description: 'A trailing line set three average true ranges from price. Below price (green) the trend is up; above price (red) it is down. A close through the line flips it.',
    source: 'Computed from highs, lows and closes', display: 'overlay', unit: 'price', colorSlot: 2,
    forecastable: false, defaultVisible: false, defaultInModel: false, colorByPrice: true,
  },
  {
    id: 'bbUpper', name: 'Bollinger Bands (20, 2σ)', short: 'Bollinger', group: 'volatility',
    description: 'Two standard deviations around the 20-day average. Tight bands precede expansion.',
    source: 'Computed from daily closes', display: 'overlay', unit: 'price', colorSlot: 6,
    forecastable: false, defaultVisible: false, defaultInModel: false, companions: ['bbLower'],
  },
  {
    id: 'sthRealizedPrice', name: 'Short-term holder realized price', short: 'STH cost basis', group: 'onchain',
    description: 'Average on-chain cost basis of coins moved in the last 155 days. Acts as support in uptrends and resistance in downtrends. The free feed covers the last 4 years.',
    source: 'BGeometrics', display: 'overlay', unit: 'price', colorSlot: 1,
    forecastable: false, defaultVisible: true, defaultInModel: false, delayedDays: 7,
  },
  {
    id: 'realizedPrice', name: 'Realized price', short: 'Realized price', group: 'onchain',
    description: 'Average on-chain cost basis of all coins (market cap ÷ MVRV ÷ supply). Historic bear-market floor.',
    source: 'Coin Metrics', display: 'overlay', unit: 'price', colorSlot: 4,
    forecastable: false, defaultVisible: false, defaultInModel: false,
  },

  // ── momentum / trend ──
  {
    id: 'rsi14', name: 'RSI (14)', short: 'RSI', group: 'momentum',
    description: 'Relative Strength Index on daily closes. Above 70 is overbought, below 30 oversold.',
    source: 'Computed from daily closes', display: 'pane', pane: 'rsi', unit: 'index', colorSlot: 6,
    forecastable: true, defaultVisible: true, defaultInModel: true,
    bands: [{ value: 70, label: 'Overbought' }, { value: 30, label: 'Oversold' }],
  },
  {
    id: 'mom30', name: '30-day return', short: 'Mom 30d', group: 'momentum',
    description: 'Price change over the last 30 days.',
    source: 'Computed from daily closes', display: 'pane', pane: 'mom', unit: 'pct', colorSlot: 0,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 0, label: '' }],
  },
  {
    id: 'mayer', name: 'Mayer multiple', short: 'Mayer', group: 'trend',
    description: 'Price ÷ 200-day average. Above 2.4 has marked overheated markets; below 0.8 deep value.',
    source: 'Computed from daily closes', display: 'pane', pane: 'mayer', unit: 'ratio', colorSlot: 0,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 2.4, label: 'Overheated' }, { value: 1, label: '200d avg' }],
  },

  // ── volatility ──
  {
    id: 'vol30', name: 'Realized volatility (30d)', short: 'Vol 30d', group: 'volatility',
    description: 'Annualised standard deviation of daily returns over 30 days.',
    source: 'Computed from daily closes', display: 'pane', pane: 'vol', unit: 'pct', colorSlot: 3,
    forecastable: true, defaultVisible: false, defaultInModel: true,
  },
  {
    id: 'dvol', name: 'Implied volatility (DVOL)', short: 'DVOL', group: 'volatility',
    description: 'Deribit 30-day implied volatility index: what the options market is pricing in.',
    source: 'Deribit', display: 'pane', pane: 'vol', unit: 'pct', colorSlot: 4,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },

  // ── drawdown ──
  {
    id: 'ddDays10', name: 'Days without a 10% pullback', short: 'No −10% for', group: 'drawdown',
    description: 'Days since price last fell 10% from the high of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'dddays', unit: 'days', colorSlot: 0,
    forecastable: true, defaultVisible: true, defaultInModel: true,
  },
  {
    id: 'ddDays15', name: 'Days without a 15% pullback', short: 'No −15% for', group: 'drawdown',
    description: 'Days since price last fell 15% from the high of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'dddays', unit: 'days', colorSlot: 1,
    forecastable: true, defaultVisible: true, defaultInModel: false,
  },
  {
    id: 'ddDays20', name: 'Days without a 20% pullback', short: 'No −20% for', group: 'drawdown',
    description: 'Days since price last fell 20% from the high of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'dddays', unit: 'days', colorSlot: 2,
    forecastable: true, defaultVisible: true, defaultInModel: true,
  },
  {
    id: 'ddDays25', name: 'Days without a 25% pullback', short: 'No −25% for', group: 'drawdown',
    description: 'Days since price last fell 25% from the high of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'dddays', unit: 'days', colorSlot: 3,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'ddDays30', name: 'Days without a 30% pullback', short: 'No −30% for', group: 'drawdown',
    description: 'Days since price last fell 30% from the high of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'dddays', unit: 'days', colorSlot: 4,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'ddDays35', name: 'Days without a 35% pullback', short: 'No −35% for', group: 'drawdown',
    description: 'Days since price last fell 35% from the high of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'dddays', unit: 'days', colorSlot: 6,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'ddAth', name: 'Drawdown from all-time high', short: 'From ATH', group: 'drawdown',
    description: 'How far price sits below its all-time high.',
    source: 'Computed from daily highs', display: 'pane', pane: 'ddath', unit: 'pct', colorSlot: 7,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },

  // ── on-chain ──
  {
    id: 'sthMvrv', name: 'STH-MVRV', short: 'STH-MVRV', group: 'onchain',
    description: 'Price ÷ short-term holder cost basis: the unrealized gain/loss of recent buyers. Below 1 they are underwater. Free feed: last 4 years only, so using it as a model input shortens the analog history.',
    source: 'BGeometrics + price', display: 'pane', pane: 'sthmvrv', unit: 'ratio', colorSlot: 1,
    forecastable: true, defaultVisible: true, defaultInModel: false, delayedDays: 7,
    bands: [{ value: 1, label: 'Break-even' }],
  },
  {
    id: 'sthBehavior', name: 'Short-term holder behavioral analysis', short: 'STH behavior', group: 'onchain',
    description: 'STH-MVRV measured against its own 90-day average, with bands one standard deviation above and below its usual level. It shows when recent buyers are unusually deep in profit or in loss compared with the last three months.',
    source: 'BGeometrics + price', display: 'pane', pane: 'sthbehavior', unit: 'ratio', colorSlot: 0,
    forecastable: true, defaultVisible: false, defaultInModel: false, delayedDays: 7,
    companions: ['sthBehaviorUpper', 'sthBehaviorLower'],
    companionInfo: { sthBehaviorUpper: { label: '+1σ', colorSlot: 4 }, sthBehaviorLower: { label: '−1σ', colorSlot: 2 } },
    bands: [{ value: 0, label: '' }],
  },
  {
    id: 'sthSopr', name: 'STH-SOPR (7d avg)', short: 'STH-SOPR', group: 'onchain',
    description: 'Realized profit/loss ratio of coins spent by short-term holders. Below 1 they are selling at a loss (capitulation); well above 1 they are taking profit. Free feed: last 4 years only, so using it as a model input shortens the analog history.',
    source: 'BGeometrics', display: 'pane', pane: 'sthsopr', unit: 'ratio', colorSlot: 2,
    forecastable: true, defaultVisible: false, defaultInModel: false, delayedDays: 7,
    bands: [{ value: 1, label: 'Break-even' }],
  },
  {
    id: 'mvrv', name: 'MVRV', short: 'MVRV', group: 'onchain',
    description: 'Market value ÷ realized value of all coins. Above ~3.5 has marked cycle tops, below 1 cycle bottoms.',
    source: 'Coin Metrics', display: 'pane', pane: 'mvrv', unit: 'ratio', colorSlot: 4,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 3.5, label: 'Top zone' }, { value: 1, label: 'Break-even' }],
  },
  {
    id: 'exchNetflow', name: 'Exchange netflow (7d, % of mkt cap)', short: 'Exch. netflow', group: 'onchain',
    description: 'Coins sent to exchanges minus coins withdrawn over 7 days, relative to market cap. Positive = supply moving to exchanges.',
    source: 'Coin Metrics', display: 'pane', pane: 'netflow', unit: 'pct', colorSlot: 5,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 0, label: '' }],
  },

  // ── derivatives ──
  {
    id: 'funding', name: 'Perp funding (7d avg, annualised)', short: 'Funding', group: 'derivatives',
    description: 'What longs pay shorts on Binance perpetuals. High positive funding = crowded longs; negative = crowded shorts.',
    source: 'Binance futures', display: 'pane', pane: 'funding', unit: 'pct', colorSlot: 3,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 0, label: '' }],
  },
  {
    id: 'oi', name: 'Open interest (Binance, USD)', short: 'Open interest', group: 'derivatives',
    description: 'Notional value of open BTCUSDT perpetual contracts. History accumulates locally (the API only serves 30 days).',
    source: 'Binance futures', display: 'pane', pane: 'oi', unit: 'usd', colorSlot: 0,
    forecastable: false, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'lsRatio', name: 'Long/short account ratio', short: 'L/S ratio', group: 'derivatives',
    description: 'Accounts net long ÷ accounts net short on Binance futures. Retail positioning gauge.',
    source: 'Binance futures', display: 'pane', pane: 'ls', unit: 'ratio', colorSlot: 4,
    forecastable: false, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 1, label: 'Balanced' }],
  },

  // ── sentiment / liquidity / cycle ──
  {
    id: 'fng', name: 'Fear & Greed index', short: 'Fear & Greed', group: 'sentiment',
    description: 'Composite sentiment index, 0 (extreme fear) to 100 (extreme greed).',
    source: 'alternative.me', display: 'pane', pane: 'fng', unit: 'index', colorSlot: 1,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 75, label: 'Extreme greed' }, { value: 25, label: 'Extreme fear' }],
  },
  {
    id: 'stableGrowth', name: 'Stablecoin supply growth (30d)', short: 'Stablecoin Δ30d', group: 'liquidity',
    description: 'Change in total USD stablecoin supply over 30 days: new buying power entering crypto.',
    source: 'DefiLlama', display: 'pane', pane: 'stables', unit: 'pct', colorSlot: 2,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 0, label: '' }],
  },
  {
    id: 'cycleDay', name: 'Days since halving', short: 'Since halving', group: 'cycle',
    description: 'Position in the four-year halving cycle. Backtests best of all inputs, but rests on only three completed cycles - treat it as a prior, not a law.',
    source: 'Protocol schedule', display: 'pane', pane: 'cycle', unit: 'days', colorSlot: 5,
    forecastable: true, defaultVisible: false, defaultInModel: true,
  },
];

export const METRICS: MetricDef[] = CATALOGUE.map((m) => ({ ...m, guide: GUIDE[m.id] }));

export const METRIC_BY_ID = new Map(METRICS.map((m) => [m.id, m]));

/** Ids of the metrics recomputed on each timeframe's own bars (see NATIVE_METRICS in dataset.ts). */
const NATIVE = new Set(['sma200', 'sma50', 'bbUpper', 'supertrend', 'rsi14', 'mom30', 'vol30']);

/**
 * The catalogue as it reads on a given timeframe: bar-based indicators are renamed to say what they
 * span there, and daily metrics are marked as such.
 */
export function metricsFor(tf: Timeframe): MetricDef[] {
  if (tf === '1d') return METRICS;
  const span = (bars: number) => durationLabel(tf, bars);
  const renamed: Record<string, Partial<MetricDef>> = {
    sma200: { name: `200-bar moving average (${span(200)})`, description: 'Average close of the last 200 bars on this timeframe.' },
    sma50: { name: `50-bar moving average (${span(50)})`, description: 'Average close of the last 50 bars on this timeframe.' },
    bbUpper: { description: `Two standard deviations around the 20-bar average (${span(20)}). Tight bands precede expansion.` },
    rsi14: { description: `Relative Strength Index over 14 bars (${span(14)}). Above 70 is overbought, below 30 oversold.` },
    mom30: { name: `${span(30)} return`, short: `Mom ${span(30)}`, description: `Price change over the last 30 bars (${span(30)}).` },
    vol30: { name: 'Realized volatility (30 bars)', short: 'Vol 30', description: `Annualised standard deviation of returns over the last 30 bars (${span(30)}).` },
  };
  return METRICS.map((m) => {
    if (!NATIVE.has(m.id)) return { ...m, source: `${m.source} · daily value` };
    const guide = m.guide && {
      ...m.guide,
      caveat: `${m.guide.caveat ? `${m.guide.caveat} ` : ''}Here it is computed on ${tf} bars, so it describes a shorter stretch than the daily version and turns more often.`,
    };
    return { ...m, ...renamed[m.id], guide };
  });
}
