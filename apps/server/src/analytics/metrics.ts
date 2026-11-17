import { durationLabel, type MetricDef, type Timeframe } from '@smart-btc/shared';
import { GUIDE } from './guide.js';
import { EN, type T } from '../i18n/index.js';
import { METRIC_TEXT } from '../i18n/metrics.js';

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
    id: 'ddDays40', name: 'Days without a 40% pullback', short: 'No −40% for', group: 'drawdown',
    description: 'Days since price last fell 40% from the high of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'dddays', unit: 'days', colorSlot: 5,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'ddDays45', name: 'Days without a 45% pullback', short: 'No −45% for', group: 'drawdown',
    description: 'Days since price last fell 45% from the high of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'dddays', unit: 'days', colorSlot: 7,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'ddDays50', name: 'Days without a 50% pullback', short: 'No −50% for', group: 'drawdown',
    description: 'Days since price last fell 50% from the high of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'dddays', unit: 'days', colorSlot: 3,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'ddAth', name: 'Drawdown from all-time high', short: 'From ATH', group: 'drawdown',
    description: 'How far price sits below its all-time high.',
    source: 'Computed from daily highs', display: 'pane', pane: 'ddath', unit: 'pct', colorSlot: 7,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },

  // ── gain ──
  {
    id: 'gainDays10', name: 'Days without a 10% rally', short: 'No +10% for', group: 'gain',
    description: 'Days since price last rose 10% from the low of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'gaindays', unit: 'days', colorSlot: 0,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'gainDays15', name: 'Days without a 15% rally', short: 'No +15% for', group: 'gain',
    description: 'Days since price last rose 15% from the low of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'gaindays', unit: 'days', colorSlot: 1,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'gainDays20', name: 'Days without a 20% rally', short: 'No +20% for', group: 'gain',
    description: 'Days since price last rose 20% from the low of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'gaindays', unit: 'days', colorSlot: 2,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'gainDays25', name: 'Days without a 25% rally', short: 'No +25% for', group: 'gain',
    description: 'Days since price last rose 25% from the low of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'gaindays', unit: 'days', colorSlot: 3,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'gainDays30', name: 'Days without a 30% rally', short: 'No +30% for', group: 'gain',
    description: 'Days since price last rose 30% from the low of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'gaindays', unit: 'days', colorSlot: 4,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'gainDays35', name: 'Days without a 35% rally', short: 'No +35% for', group: 'gain',
    description: 'Days since price last rose 35% from the low of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'gaindays', unit: 'days', colorSlot: 6,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'gainDays40', name: 'Days without a 40% rally', short: 'No +40% for', group: 'gain',
    description: 'Days since price last rose 40% from the low of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'gaindays', unit: 'days', colorSlot: 5,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'gainDays45', name: 'Days without a 45% rally', short: 'No +45% for', group: 'gain',
    description: 'Days since price last rose 45% from the low of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'gaindays', unit: 'days', colorSlot: 7,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'gainDays50', name: 'Days without a 50% rally', short: 'No +50% for', group: 'gain',
    description: 'Days since price last rose 50% from the low of the current leg.',
    source: 'Computed from daily highs/lows', display: 'pane', pane: 'gaindays', unit: 'days', colorSlot: 3,
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
  {
    id: 'puell', name: 'Puell multiple', short: 'Puell', group: 'onchain',
    description: 'Daily value of newly mined coins ÷ its 365-day average: how flush miners are. Above ~4 has marked cycle tops, below ~0.5 miner capitulation near cycle lows.',
    source: 'Coin Metrics', display: 'pane', pane: 'puell', unit: 'ratio', colorSlot: 3,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 4, label: 'Top zone' }, { value: 0.5, label: 'Capitulation' }],
  },
  {
    id: 'exSupply', name: 'Supply on exchanges (% of supply)', short: 'Exch. supply', group: 'onchain',
    description: 'Share of all bitcoin held in known exchange wallets. A falling share means coins are moving into self-custody; a rising one, coins becoming available to sell.',
    source: 'Coin Metrics', display: 'pane', pane: 'exsupply', unit: 'pct', colorSlot: 6,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'txCount', name: 'Transactions per day (30d avg)', short: 'Transactions', group: 'onchain',
    description: 'On-chain transactions per day, averaged over 30 days: a rough gauge of network use.',
    source: 'Coin Metrics', display: 'pane', pane: 'tx', unit: 'index', colorSlot: 0,
    forecastable: false, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'fees', name: 'Transaction fees (7d avg, USD/day)', short: 'Fees', group: 'onchain',
    description: 'Fees paid to miners per day in USD, averaged over 7 days. Spikes mark crowded blocks, typically during speculative bursts.',
    source: 'Coin Metrics + price', display: 'pane', pane: 'fees', unit: 'usd', colorSlot: 1,
    forecastable: false, defaultVisible: false, defaultInModel: false,
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
    id: 'premium', name: 'Perp premium over spot (7d avg)', short: 'Perp premium', group: 'derivatives',
    description: 'How far Binance perpetual futures trade above (or below) spot, averaged over 7 days. A wide premium means traders pay up for leverage on the long side.',
    source: 'Binance futures', display: 'pane', pane: 'premium', unit: 'pct', colorSlot: 5,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 0, label: '' }],
  },
  {
    id: 'hlFunding', name: 'Hyperliquid funding (7d avg, annualised)', short: 'HL funding', group: 'derivatives',
    description: 'What longs pay shorts on Hyperliquid, the largest on-chain perpetuals exchange. A second view of crowding, from a different set of traders than Binance.',
    source: 'Hyperliquid', display: 'pane', pane: 'funding', unit: 'pct', colorSlot: 6,
    forecastable: false, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'oi', name: 'Open interest (Bybit, USD)', short: 'Open interest', group: 'derivatives',
    description: 'Notional value of open BTCUSDT perpetual contracts on Bybit, daily since 2020.',
    source: 'Bybit + price', display: 'pane', pane: 'oi', unit: 'usd', colorSlot: 0,
    forecastable: false, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'oiChange30', name: 'Open interest change (30d)', short: 'OI Δ30d', group: 'derivatives',
    description: 'Change in Bybit open interest (in BTC) over 30 days. Fast growth means leverage is building; a sharp fall, that positions were flushed out.',
    source: 'Bybit', display: 'pane', pane: 'oichange', unit: 'pct', colorSlot: 7,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 0, label: '' }],
  },
  {
    id: 'lsRatio', name: 'Long/short account ratio', short: 'L/S ratio', group: 'derivatives',
    description: 'Accounts net long ÷ accounts net short on Bybit perpetuals, daily since 2020. Retail positioning gauge.',
    source: 'Bybit', display: 'pane', pane: 'ls', unit: 'ratio', colorSlot: 4,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 1, label: 'Balanced' }],
  },
  {
    id: 'putCall', name: 'Options put/call ratio (open interest)', short: 'Put/call', group: 'derivatives',
    description: 'Open interest in BTC put options ÷ call options on Deribit. Higher means more hedging against a fall. No free history: it builds up locally from the day the app first ran.',
    source: 'Deribit', display: 'pane', pane: 'putcall', unit: 'ratio', colorSlot: 2,
    forecastable: false, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 1, label: 'Balanced' }],
  },
  {
    id: 'cotLevNet', name: 'CME leveraged funds net position (% of OI)', short: 'CME lev. funds', group: 'derivatives',
    description: 'Hedge funds and other leveraged traders on CME Bitcoin futures: longs minus shorts, as a share of open interest. Weekly, from the CFTC Commitments of Traders report.',
    source: 'CFTC', display: 'pane', pane: 'cot', unit: 'pct', colorSlot: 1,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 0, label: '' }],
  },
  {
    id: 'cotAssetNet', name: 'CME asset managers net position (% of OI)', short: 'CME asset mgrs', group: 'derivatives',
    description: 'Asset managers on CME Bitcoin futures: longs minus shorts, as a share of open interest. Weekly, from the CFTC Commitments of Traders report.',
    source: 'CFTC', display: 'pane', pane: 'cot', unit: 'pct', colorSlot: 2,
    forecastable: false, defaultVisible: false, defaultInModel: false,
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
    id: 'dxy', name: 'US dollar index (DXY)', short: 'DXY', group: 'macro',
    description: 'The dollar against a basket of major currencies. A rising dollar has tended to weigh on bitcoin and other risk assets.',
    source: 'Yahoo Finance', display: 'pane', pane: 'dxy', unit: 'ratio', colorSlot: 0,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'us10y', name: 'US 10-year Treasury yield', short: 'US 10y', group: 'macro',
    description: 'Yield on 10-year US government bonds: the price of money. Fast rises tighten financial conditions.',
    source: 'Yahoo Finance', display: 'pane', pane: 'us10y', unit: 'pct', colorSlot: 7,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'nasdaqMom', name: 'Nasdaq 30-day return', short: 'Nasdaq 30d', group: 'macro',
    description: 'How the Nasdaq Composite moved over the last 30 days. Bitcoin has often traded with tech stocks in risk-on and risk-off waves.',
    source: 'Yahoo Finance', display: 'pane', pane: 'macromom', unit: 'pct', colorSlot: 0,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 0, label: '' }],
  },
  {
    id: 'goldMom', name: 'Gold 30-day return', short: 'Gold 30d', group: 'macro',
    description: 'How gold moved over the last 30 days: the traditional store of value bitcoin is often compared with.',
    source: 'Yahoo Finance', display: 'pane', pane: 'macromom', unit: 'pct', colorSlot: 3,
    forecastable: true, defaultVisible: false, defaultInModel: false,
  },
  {
    id: 'ibitVolume', name: 'IBIT spot-ETF dollar volume (20d avg)', short: 'IBIT volume', group: 'macro',
    description: 'Daily traded value of BlackRock\'s IBIT, the largest US spot bitcoin ETF, averaged over 20 days: a proxy for institutional activity. History since January 2024.',
    source: 'Yahoo Finance', display: 'pane', pane: 'ibit', unit: 'usd', colorSlot: 4,
    forecastable: false, defaultVisible: false, defaultInModel: false,
  },

  {
    id: 'hashRibbon', name: 'Hash ribbon (30d ÷ 60d hash rate)', short: 'Hash ribbon', group: 'onchain',
    description: 'The 30-day average of the network hash rate divided by its 60-day average. Below 1 the network is shrinking: miners are switching machines off.',
    source: 'Coin Metrics', display: 'pane', pane: 'hashribbon', unit: 'ratio', colorSlot: 2,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 1, label: 'Flat' }],
  },
  {
    id: 'cbPremium', name: 'Coinbase premium (7d avg)', short: 'Coinbase premium', group: 'sentiment',
    description: 'How far the dollar price on Coinbase sits above (or below) the tether price on Binance. Coinbase is where US funds and institutions trade, so a premium points to US buying.',
    source: 'Coinbase', display: 'pane', pane: 'cbpremium', unit: 'pct', colorSlot: 1,
    forecastable: true, defaultVisible: false, defaultInModel: false,
    bands: [{ value: 0, label: '' }],
  },
  {
    id: 'netLiquidity', name: 'Net dollar liquidity (Fed)', short: 'Net liquidity', group: 'liquidity',
    description: 'The Federal Reserve balance sheet minus the Treasury cash account and the reverse-repo facility: a rough measure of the dollars available to financial markets.',
    source: 'FRED', display: 'pane', pane: 'netliq', unit: 'usd', colorSlot: 6,
    forecastable: true, defaultVisible: false, defaultInModel: false,
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

/**
 * The downloaded sources behind each metric (ids from providers/). Where several are listed the first
 * is the main one and the others stand in for it; metrics computed from price alone are not listed.
 */
export const METRIC_PROVIDERS: Record<string, string[]> = {
  sthRealizedPrice: ['bgeometrics'], sthMvrv: ['bgeometrics'], sthBehavior: ['bgeometrics'], sthSopr: ['bgeometrics'],
  realizedPrice: ['coinmetrics'], mvrv: ['coinmetrics'], exchNetflow: ['coinmetrics'], puell: ['coinmetrics'], exSupply: ['coinmetrics'], fees: ['coinmetrics'],
  txCount: ['coinmetrics', 'blockchain-com'], hashRibbon: ['coinmetrics', 'blockchain-com', 'mempool'],
  dvol: ['deribit'], putCall: ['deribit-options'],
  funding: ['binance-futures', 'bybit', 'okx'], premium: ['binance-premium'], hlFunding: ['hyperliquid'],
  oi: ['bybit', 'binance-futures'], oiChange30: ['bybit'], lsRatio: ['bybit', 'binance-futures'],
  cotLevNet: ['cftc'], cotAssetNet: ['cftc'],
  fng: ['alternative-me'], stableGrowth: ['defillama'],
  dxy: ['yahoo'], us10y: ['yahoo', 'fred'], nasdaqMom: ['yahoo'], goldMom: ['yahoo'], ibitVolume: ['yahoo'],
  cbPremium: ['coinbase', 'binance-spot'], netLiquidity: ['fred'],
};


/** Ids of the metrics recomputed on each timeframe's own bars (see NATIVE_METRICS in dataset.ts). */
const NATIVE = new Set(['sma200', 'sma50', 'bbUpper', 'supertrend', 'rsi14', 'mom30', 'vol30']);

/**
 * The catalogue as it reads on a given timeframe: bar-based indicators are renamed to say what they
 * span there, and daily metrics are marked as such.
 */
/** A metric's display text in the requested language (structure and numbers are unchanged). */
export function localizeMetric(m: MetricDef, t: T): MetricDef {
  const tx = t.lang === 'en' ? undefined : METRIC_TEXT[t.lang]?.[m.id];
  return {
    ...m,
    name: tx?.name ?? m.name,
    short: tx?.short ?? m.short,
    description: tx?.description ?? m.description,
    source: t(m.source),
    bands: m.bands?.map((b) => ({ ...b, label: b.label ? t(b.label) : '' })),
    guide: m.guide && { read: tx?.read ?? m.guide.read, caveat: tx?.caveat ?? m.guide.caveat },
  };
}

/** Short name of a metric in the requested language. */
export function metricShort(id: string, t: T): string {
  const m = METRIC_BY_ID.get(id);
  return m ? localizeMetric(m, t).short : id;
}

/**
 * The catalogue as it reads on a given timeframe and language: bar-based indicators are renamed to say
 * what they span there, and daily metrics are marked as such.
 */
export function metricsFor(tf: Timeframe, t: T = EN): MetricDef[] {
  const base = METRICS.map((m) => localizeMetric(m, t));
  if (tf === '1d') return base;
  const span = (bars: number) => t.dur(tf, bars);
  const renamed: Record<string, Partial<MetricDef>> = {
    sma200: { name: t('200-bar moving average ({span})', { span: span(200) }), description: t('Average close of the last 200 bars on this timeframe.') },
    sma50: { name: t('50-bar moving average ({span})', { span: span(50) }), description: t('Average close of the last 50 bars on this timeframe.') },
    bbUpper: { description: t('Two standard deviations around the 20-bar average ({span}). Tight bands precede expansion.', { span: span(20) }) },
    rsi14: { description: t('Relative Strength Index over 14 bars ({span}). Above 70 is overbought, below 30 oversold.', { span: span(14) }) },
    mom30: { name: t('{span} return', { span: span(30) }), short: t('Mom {span}', { span: span(30) }), description: t('Price change over the last 30 bars ({span}).', { span: span(30) }) },
    vol30: { name: t('Realized volatility (30 bars)'), short: t('Vol 30'), description: t('Annualised standard deviation of returns over the last 30 bars ({span}).', { span: span(30) }) },
  };
  return base.map((m) => {
    if (!NATIVE.has(m.id)) return { ...m, source: t('{source} · daily value', { source: m.source }) };
    const extra = t('Here it is computed on {tf} bars, so it describes a shorter stretch than the daily version and turns more often.', { tf });
    const guide = m.guide && { ...m.guide, caveat: m.guide.caveat ? `${m.guide.caveat} ${extra}` : extra };
    return { ...m, ...renamed[m.id], guide };
  });
}

/** Short names of the metrics a source feeds, for the data-sources list. */
export function feedsOf(providerId: string, t: T = EN): string[] {
  return METRICS.filter((m) => METRIC_PROVIDERS[m.id]?.includes(providerId)).map((m) => localizeMetric(m, t).short);
}
