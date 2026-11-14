import type { MetricDef } from '@smart-btc/shared';

/**
 * Plain-language reading notes per metric, shown in the Guide tab.
 * `read` lists what the common zones are taken to mean; `caveat` says where the metric misleads.
 * These are the conventional interpretations - the Ranking and Correlations views show how well they held up.
 */
export const GUIDE: Record<string, NonNullable<MetricDef['guide']>> = {
  sma200: {
    read: [
      'Price above a rising 200-day average: long-term uptrend. Pullbacks to the line have often found buyers.',
      'Price below a falling line: long-term downtrend. Rallies to the line have often been sold.',
      'A cross of the line marks a regime change more than an entry signal.',
    ],
    caveat: 'It is slow by design: it confirms a trend months after it started and whipsaws in sideways markets.',
  },
  sma50: {
    read: [
      'Tracks the medium-term trend. Above it, momentum favours buyers; below it, sellers.',
      'The 50-day crossing above the 200-day ("golden cross") or below it ("death cross") is a widely watched, lagging signal.',
    ],
    caveat: 'Crosses are frequent in choppy markets and often arrive after much of the move.',
  },
  supertrend: {
    read: [
      'Green and below price: uptrend. The line only moves up, so it works as a trailing stop for longs.',
      'Red and above price: downtrend. The line only moves down, a trailing stop for shorts.',
      'The flip (a close through the line) is the signal; the distance to the line is how much room the trend has before it would flip.',
    ],
    caveat: 'It always shows a trend, so in sideways markets it flips back and forth and each flip costs a little. It also reacts late by design.',
  },
  bbUpper: {
    read: [
      'Bands widen when volatility rises and tighten when it falls. Very tight bands ("squeeze") tend to precede a large move, direction unknown.',
      'A close outside a band shows unusual strength or weakness; in trends price can "ride" a band for weeks.',
    ],
    caveat: 'Touching a band is not by itself a reversal signal.',
  },
  sthRealizedPrice: {
    read: [
      'The average price paid by coins that moved in the last ~5 months: the break-even of recent buyers.',
      'In uptrends price tends to hold above it (recent buyers defend their entry). In downtrends it turns into resistance (they sell at break-even).',
    ],
    caveat: 'The free feed is 7 days late and covers 4 years, so use it as a zone, not an exact level.',
  },
  realizedPrice: {
    read: [
      'The average price at which every coin last moved: the market-wide cost basis.',
      'Price has only spent brief periods below it, at the depths of bear markets (2015, 2018–19, 2022).',
    ],
    caveat: 'It moves very slowly and says nothing about the next weeks.',
  },
  rsi14: {
    read: [
      'Above 70: overbought. Strong momentum, but stretched. Below 30: oversold. Heavy selling, but stretched.',
      'Around 50 is neutral; holding above 50 in pullbacks is typical of uptrends.',
      'Divergences (price and RSI disagreeing at successive highs or lows) hint that a move is losing force. Turn them on under RSI in the metrics list.',
    ],
    caveat: 'In strong trends RSI can stay overbought or oversold for weeks. Extremes say "stretched", not "about to reverse".',
  },
  mom30: {
    read: [
      'Simply how much price changed in 30 days. Large positive values mean a strong recent run; large negative values a sharp drop.',
      'Bitcoin has shown both momentum (strong months followed by more strength) and mean reversion after extreme moves.',
    ],
    caveat: 'Largely the same information as RSI; using both as model inputs adds little.',
  },
  mayer: {
    read: [
      'Above 2.4: price is far above its long-term trend, historically an overheated zone.',
      'Around 1: price sits at the 200-day average. Below 0.8: deep discount, seen near bear-market lows.',
    ],
    caveat: 'Peaks have been lower each cycle, so fixed thresholds from old cycles may never be reached again.',
  },
  vol30: {
    read: [
      'How much price has been moving, annualised. Low readings mean a quiet market; high readings a turbulent one.',
      'Volatility clusters: calm follows calm and storms follow storms, until a regime break. Unusually low readings have often preceded big moves in either direction.',
    ],
    caveat: 'It measures the size of moves, not their direction.',
  },
  dvol: {
    read: [
      'What option traders expect volatility to be over the next 30 days. Divide by ~19 for the implied typical daily move in %.',
      'Above realized volatility: the market is paying up for protection (nervous). Below it: complacency.',
    ],
    caveat: 'History starts in 2021, and like realized volatility it does not point in a direction.',
  },
  ddDays10: {
    read: [
      'Counts the days since price last fell 10% from the high of its current leg. Long counts mean an unusually smooth advance.',
      'Bitcoin rarely goes more than a few months without a 10% pullback, so high counts say one is statistically "due" - without saying when.',
    ],
    caveat: 'The counter resets on the pullback itself; a low count can mean either "just pulled back" or "in a slide".',
  },
  ddDays15: {
    read: ['Same idea with a 15% threshold: the time since the last medium-sized correction.'],
    caveat: 'Strongly related to the 10% and 20% counters; one of the three usually carries the information.',
  },
  ddDays20: {
    read: [
      'Days since the last 20% correction. Long stretches are typical of mature bull phases and of quiet, low-volatility ranges.',
      'Compared with the 10% counter it tells you whether recent weakness is a shallow dip (10% reset, 20% still counting) or a real correction.',
    ],
  },
  ddDays25: {
    read: ['Days since the last 25% correction. Drops of this size are rarer and usually mark the end of a leg rather than a dip inside it.'],
    caveat: 'Closely related to the 20% and 30% counters.',
  },
  ddDays30: {
    read: [
      'Days since the last 30% correction. In past bull markets 30% pullbacks were the typical "deep" correction; long counts mean the advance has gone unusually long without one.',
    ],
    caveat: 'Events are infrequent, so the counter says little about the next few weeks.',
  },
  ddDays35: {
    read: ['Days since the last 35% correction: a gauge of how long it has been since a major sell-off or the last bear leg.'],
    caveat: 'Only a few dozen such events exist in the whole history.',
  },
  ddAth: {
    read: [
      'How far price is below its all-time high. Near 0%: price discovery. −20% to −40%: ordinary bull-market correction or early bear.',
      'Beyond −50%: bear market. Past cycles bottomed around −75% to −85%.',
    ],
    caveat: 'It describes where we are in the cycle, not what happens next.',
  },
  sthMvrv: {
    read: [
      'Price divided by the cost basis of recent buyers. Above 1 they are in profit, below 1 at a loss.',
      'Around 1 is a decision point: support in uptrends, resistance in downtrends. Above ~1.3 recent buyers hold large gains and profit-taking usually follows.',
      'Well below 1 (0.8–0.9) marks capitulation of recent buyers, common near local lows.',
    ],
    caveat: 'Free data is delayed 7 days and limited to 4 years.',
  },
  sthBehavior: {
    read: [
      'Above the upper (+1σ) band: recent buyers are unusually far in profit versus the last 90 days. These overheated stretches have tended to come before local tops or pauses, as profit-taking builds.',
      'Below the lower (−1σ) band: recent buyers are unusually underwater. These capitulation stretches have tended to come near local lows, once the weakest holders have sold.',
      'Crossing back through zero marks the shift between recent buyers gaining and losing ground relative to their three-month norm.',
    ],
    caveat: 'In a sustained trend it can stay beyond a band for weeks. The free feed is delayed 7 days and covers 4 years, so the bands only start in 2023; the line follows a published Glassnode chart in spirit, not its exact formula.',
  },
  puell: {
    read: [
      'Miners sell part of what they mine to cover costs, so their income shapes steady selling pressure. Above ~4 they earn far more than usual and selling tends to rise; past cycle tops sat there.',
      'Below ~0.5 miners earn far less than usual and the weakest shut down: historically a capitulation zone near cycle lows.',
    ],
    caveat: 'Each halving cuts issuance in half, so readings shift abruptly around halvings, and fees play a growing role.',
  },
  exSupply: {
    read: [
      'Share of all coins sitting in known exchange wallets. A steady decline means holders are moving coins into self-custody, which shrinks readily sellable supply.',
      'A rising share means coins are flowing onto exchanges, often ahead of selling.',
    ],
    caveat: 'Exchange wallet labelling is imperfect, and spot ETFs and custodians hold coins outside exchanges, so the long-term trend is clearer than short swings.',
  },
  txCount: {
    read: ['Average number of on-chain transactions per day over 30 days. Rising use alongside rising price is a healthier rally than price alone.'],
    caveat: 'Transaction batching, layer-2 networks and inscription waves change the count without saying much about demand for bitcoin itself.',
  },
  fees: {
    read: ['Total fees paid to miners per day in USD. Spikes mark crowded blocks, usually during speculative bursts or market stress.'],
    caveat: 'A single wave of inscriptions or a congested week can dominate the series.',
  },
  premium: {
    read: [
      'Positive: perpetual futures trade above spot because traders pay up for leveraged longs. A wide, persistent premium is a sign of crowding.',
      'Negative: perps trade below spot, which tends to happen after flushes and in fearful markets.',
    ],
    caveat: 'Only Binance, and only since late 2019, so as a model input it shortens the analog history.',
  },
  hlFunding: {
    read: [
      'Same idea as the Binance funding rate, measured on Hyperliquid. When both are high at once, crowding is broad rather than limited to one venue.',
    ],
    caveat: 'History only starts in mid-2023, so it is shown on the chart but not offered as a model input.',
  },
  oiChange30: {
    read: [
      'Above ~+20%: open interest has grown fast, meaning new leverage is entering. Rallies built on leverage are prone to sharp liquidation cascades.',
      'Below ~−20%: positions were closed or liquidated; leverage has been washed out, which often clears the way for a calmer trend.',
    ],
    caveat: 'Bybit only and measured in BTC, history since 2020. As a model input it shortens the analog history to that period.',
  },
  putCall: {
    read: [
      'Above 1: more open put options than calls, so traders are hedging against a fall. Very high readings often come near local lows, when fear is priced in.',
      'Below ~0.6: call-heavy, optimistic positioning.',
    ],
    caveat: 'There is no free history: the line builds up locally from the day you first ran the app, one value per day.',
  },
  cotLevNet: {
    read: [
      'Hedge funds on CME are usually net short because they run basis trades (long spot or ETFs, short futures), so a negative reading is normal.',
      'Moves away from their usual level matter more than the sign: a short position that unwinds quickly can add buying pressure.',
    ],
    caveat: 'Weekly data, published three days after the positions are recorded, and the basis trade blurs the directional message.',
  },
  cotAssetNet: {
    read: ['Asset managers on CME are mostly net long: a gauge of institutional directional exposure through futures.'],
    caveat: 'Weekly, published with a three-day delay; spot ETFs now carry much of the institutional exposure outside futures.',
  },
  dxy: {
    read: [
      'A rising dollar tightens global financial conditions and has tended to weigh on bitcoin; a falling dollar has tended to help.',
      'As a model input the 30-day change is used rather than the level.',
    ],
    caveat: 'The relationship is loose and changes over time; there are long stretches where bitcoin ignores the dollar.',
  },
  us10y: {
    read: [
      'Higher long-term yields make cash and bonds more attractive and tend to pressure speculative assets, especially when they rise fast.',
      'As a model input the 30-day change in percentage points is used.',
    ],
    caveat: 'Yields can rise for good reasons (strong growth) as well as bad ones, so the direction alone is ambiguous.',
  },
  nasdaqMom: {
    read: ['Bitcoin has often moved with tech stocks during risk-on and risk-off waves. A sharp Nasdaq drop has tended to drag bitcoin with it.'],
    caveat: 'The correlation comes and goes; in some periods bitcoin trades on its own story.',
  },
  goldMom: {
    read: ['Gold and bitcoin are both seen as hedges against currency debasement; strong gold momentum sometimes precedes bitcoin catching up.'],
    caveat: 'The link is weak and inconsistent; treat it as context.',
  },
  ibitVolume: {
    read: ['Average daily traded value of the largest US spot bitcoin ETF. Volume surges mark periods of heavy institutional activity, in either direction.'],
    caveat: 'Volume is not net flow: it does not say whether money came in or went out. History only since January 2024.',
  },
  sthSopr: {
    read: [
      'Whether coins sold by recent buyers were sold at a profit (above 1) or a loss (below 1), averaged over 7 days.',
      'In uptrends dips to 1 tend to be bought (holders refuse to sell at a loss). In downtrends rallies to 1 tend to be sold.',
      'Sustained readings below 1 are capitulation; spikes well above 1 are aggressive profit-taking.',
    ],
    caveat: 'Delayed 7 days on the free feed, so it describes last week.',
  },
  mvrv: {
    read: [
      'Market value divided by the aggregate cost basis of all coins: the average holder\'s unrealized profit multiple.',
      'Above ~3.5: historic cycle-top zone. Below 1: the average holder is underwater, historic cycle-bottom zone.',
    ],
    caveat: 'A slow, cycle-scale gauge. Peaks have declined cycle after cycle.',
  },
  exchNetflow: {
    read: [
      'Coins flowing into exchanges minus coins flowing out, over 7 days. Inflows are potential selling supply; outflows suggest coins moving to storage.',
    ],
    caveat: 'Exchange wallet labelling is imperfect, and ETF and custody flows blur the picture.',
  },
  funding: {
    read: [
      'The fee longs pay shorts on perpetual futures. Positive and high: longs are crowded and paying to stay in, a setup for long liquidations.',
      'Negative: shorts are crowded, a setup for short squeezes. Around 10% annualised is the neutral baseline.',
    ],
    caveat: 'Extremes can persist through a trend; it is a positioning gauge more than a timing tool.',
  },
  oi: {
    read: [
      'The value of open futures positions. Rising with price: new money backing the move. Rising while price stalls: leverage building, liquidation risk growing.',
      'A sharp drop means positions were closed or liquidated - a "flush" that often clears the way.',
    ],
    caveat: 'Bybit only (one large exchange among several), daily since 2020.',
  },
  lsRatio: {
    read: [
      'Accounts net long divided by accounts net short. It counts accounts, not money, so it mostly reflects small traders.',
      'Often read as a contrarian gauge: very high readings mean the crowd is long.',
    ],
    caveat: 'The ratio sits above 1 most of the time, so compare it with its own history rather than with 1.',
  },
  fng: {
    read: [
      'A 0–100 blend of volatility, momentum, social media and dominance. Below 25: extreme fear. Above 75: extreme greed.',
      'Classic contrarian reading: fear near lows, greed near highs.',
    ],
    caveat: 'It is built largely from price itself, so it mostly restates recent performance.',
  },
  stableGrowth: {
    read: [
      'How fast the total supply of dollar stablecoins is growing. Growth means new buying power arriving in crypto; contraction means money leaving.',
    ],
    caveat: 'Stablecoins are also used outside trading (payments, DeFi), and supply reacts to price with a delay.',
  },
  cycleDay: {
    read: [
      'Days since the last halving of the block reward (roughly every four years). Past cycles peaked about 12–18 months after a halving and bottomed about a year later.',
    ],
    caveat: 'Three completed cycles is a tiny sample, and the supply effect of each halving is smaller than the last.',
  },
};
