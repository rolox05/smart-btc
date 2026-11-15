# Smart BTC

A local workbench that reads Bitcoin's current state (momentum, drawdown streaks, volatility,
on-chain cost bases, derivatives positioning, liquidity) and answers, with numbers that are
checked against history:

- **What is the most probable scenario** over the next 7–90 days, with target prices and the
  typical number of days the move takes to develop.
- **What are the odds of price touching ±X%** inside that window, and which side tends to be hit first.
- **How would a given long/short bracket have played out** (stop-loss, take-profit, leverage,
  position size for a fixed account risk).
- **Can the selected inputs be trusted?** Every configuration is backtested walk-forward against
  the plain base rate, and the verdict is shown next to the forecast.

Everything runs on your machine. Data comes from free public APIs (no keys) and is cached in a
local SQLite file.

> Research tool, not financial advice. Probabilities are historical frequencies of similar
> situations. They are uncertain, they do not know about news, and leverage can lose the whole margin.

## Run it

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`).

```bash
npm install
npm run dev
```

Open http://localhost:5173. The first start downloads ~15 years of history (a few seconds).

| Command | What it does |
|---|---|
| `npm run dev` | API on `127.0.0.1:4747` + web app on `localhost:5173`, both with hot reload |
| `npm run build` | Type-checks and builds the web app into `apps/web/dist` |
| `npm start` | Runs the API, which also serves the built web app on `127.0.0.1:4747` |
| `npm run typecheck` | Type-checks every workspace |

Environment variables: `API_PORT` (4747), `API_HOST` (127.0.0.1), `DATA_DIR` (`./data`),
`SYNC=off` (serve only what is already in the local database), `API_URL` (dev proxy target).

## Using the dashboard

- **Timeframe.** 15m, 1h, 4h, 24h, 1w or 1M, chosen above the chart. It applies to the candles, the
  price indicators (RSI, moving averages, Bollinger, momentum, volatility, divergences) and to the
  forecast, odds, trade setup, backtest, ranking and correlations. Horizons and stop/target ladders
  rescale with it. On-chain, derivatives, sentiment and pullback-counter metrics are daily figures on
  every timeframe (each bar sees the last completed day). Intraday candles come from Binance
  (15m: last 3 years; 1h and 4h: since 2017); weekly and monthly bars are built from daily history.
- **Language.** English, Spanish or Portuguese, chosen in the header (the first visit follows the
  browser language). Interface text lives in `apps/web/src/locales`, server-generated text (readings,
  forecast sentences, warnings) in `apps/server/src/i18n`, and metric descriptions and reading guides
  in `apps/server/src/i18n/metrics.ts`. Translations are keyed by the English text: edit the tables in
  `scripts/i18n/*.py`, run `npm run i18n:build`, and `npm run i18n:check` lists any string still missing.
- **Hints.** The "Hints" switch in the header turns hover explanations on or off: rest the cursor on
  a metric, a chart layer, or a line, level or marker on the chart to see what it means.

- **Metrics list (left).** The eye icon draws a metric on the chart; the chip icon makes it an
  input of the forecast model. Hover a row for its definition, source and history start.
- **Signals on a metric.** Some metrics carry an extra signal that can be drawn on their pane,
  toggled on the indented row under the metric (currently RSI divergences). Click a metric's name
  to open its entry in the Guide.
- **Chart layers.** Forecast cone (median, 50% and 80% bands), scenario targets, liquidity pools
  (unswept swing highs/lows), estimated liquidation clusters, order-book walls, log scale.
- **Horizon and model settings.** Horizon, number of analogs, minimum spacing between analogs,
  history start year, base-rate blend, recency weighting, scenario threshold, volatility rescaling.
  Any change re-runs the forecast and its backtest.
- **Tabs.** Forecast · Odds (touch probabilities and return distribution) · Trade ·
  Backtest · Ranking (backtests every metric alone and against your current set of inputs) ·
  Liquidity · Guide (what each metric means, correlations between metrics, method). Data source
  status opens from the header.

## How the forecast works

1. Today is described by the readings of the metrics selected as model inputs, taken at the last
   **closed** bar (the forming bar is only used for the starting price). Coin Metrics inputs are
   lagged one day because they are published a few hours after each day closes.
2. The model finds the `k` most similar past days with a Mahalanobis distance (inputs are
   whitened with their past-only covariance, so correlated inputs are not counted twice), keeping
   them at least a few days apart so one episode cannot dominate. Closer analogs weigh more
   (Gaussian kernel, bandwidth = median analog distance).
3. What price did after each of those days, rescaled toward today's volatility (by the 90-bar volatility ratio raised to 0.75: partial rescaling scored better than full rescaling, which over-reacts to noisy volatility estimates), is one possible path.
   The analog paths are blended with the all-history base rate (50% by default) to tame the noise
   of a small sample.
4. Scenario probabilities, targets, timings, touch odds and stop/target outcomes are weighted
   counts over those paths.
   The reported effective sample counts *independent* analogs: analogs closer together than the
   horizon share part of their future, so their outcomes are discounted (1 / ΣΣ wⱼwₖρⱼₖ with
   ρ = overlap of the two forward windows).
5. The **walk-forward backtest** repeats 1–4 for each past date using only data available then
   (analogs must have fully played out; standardisation uses past data only) and scores the
   probabilities with the Brier skill score against the base rate known on that date.

What to expect: on Bitcoin's history most classic indicators add little or nothing over the base
rate for direction; the range and touch probabilities are well calibrated (the 80% band contains
the outcome about 80% of the time), which is what matters for placing stops and targets. The app
tells you which case you are in rather than assuming an edge.

Model choices are compared with `npx tsx scripts/model-bench.mts`, which runs the same walk-forward
backtest for several variants (distance, kernel, analog spacing, adaptive blending, `k`) at 7, 30
and 90 days. Only variants that won consistently are defaults; picking them on the same history is
still mild over-fitting, so treat small skill differences as noise.

## Three models and a consensus (Models tab)

| Model | What it does | Basis |
|---|---|---|
| Historical analogs | Finds the past days most similar to today on the inputs you chose | The app's original model |
| Quantile regression | Estimates each quantile of the outcome as a weighted sum of momentum, volatility, sentiment and macro inputs, and shows the weight of each | Koenker & Bassett (1978) |
| Trend + volatility | A small momentum tilt on top of past returns standardised by a GARCH-style volatility forecast | Moskowitz, Ooi & Pedersen (2012); Liu & Tsyvinski (2021); Barone-Adesi et al. (1999) |

All three are scored on the same past dates with only the data available on each date, and their
equal-weight consensus is scored too. On this history neither new model beats the base rate on its
own; the consensus matches or improves on the analog model's range quality. Scheduled events inside
the horizon (Events tab: Fed decisions, CPI releases, monthly option expiries) widen the consensus
range only as much as past event days were riskier than ordinary ones.

Live liquidations arrive over the Binance and Bybit websockets and are stored locally from the
moment the server first runs (Liquidity tab); neither exchange offers an archive.

## Data sources

| Source | Used for | Notes |
|---|---|---|
| Binance spot (`api.binance.com`, mirror `data-api.binance.vision`) | Daily candles since 2017, live price, hourly candles, order book | Mirror is used automatically where the main host is blocked |
| Bitstamp | Daily candles 2011–2017, fallback price feed, order book | |
| Binance USD-M futures | Funding since 2019, open interest, long/short ratio | OI and L/S are only served for 30 days; history accumulates locally |
| Coin Metrics Community | MVRV / realized price, market cap, supply, exchange flows and balances, issuance (Puell multiple), fees, transactions | Since 2010 |
| BGeometrics (bitcoin-data.com) | Short-term-holder realized price, STH-SOPR | Free tier: last 4 years, delayed 7 days, 15 requests/day (synced once a day) |
| Deribit | DVOL implied volatility | Since 2021 |
| alternative.me | Fear & Greed index | Since 2018 |
| DefiLlama | Total stablecoin supply | Since 2017 |
| Coinbase, Kraken | Order book depth | |
| Bybit | Open interest and long/short account ratio | Daily since 2020 |
| Binance premium index | Perpetual premium over spot | Daily since Dec 2019 |
| Hyperliquid | Funding on the largest on-chain perpetuals exchange | Hourly since May 2023 |
| Deribit options | Put/call open-interest ratio | Live only; history builds up locally |
| CFTC Commitments of Traders | CME Bitcoin futures positioning (leveraged funds, asset managers) | Weekly since 2018, stored on the publication day |
| Yahoo Finance | US dollar index, 10-year yield, Nasdaq, gold, IBIT ETF volume | Daily since 2010 (IBIT since 2024); unofficial endpoint |

Delayed series are lagged by the same amount inside the model, so the backtest only ever sees
what would have been available live.

Liquidity views (swing pools, estimated liquidation clusters, order-book walls) have no free
historical archive, so they are context for targets and stops, not model inputs. The liquidation
clusters are an estimate (Binance open-interest growth × an assumed leverage mix), not
exchange-reported positions.

## Project layout

```
packages/shared      Types and constants shared by API and web app
apps/server
  src/providers      One file per data source (incremental sync into the store)
  src/store          Persistence interface + SQLite implementation
  src/sync.ts        Scheduler: runs providers when due, tracks their status
  src/analytics      Indicators, metric catalogue, aligned daily dataset, liquidity analysis
  src/forecast       Analog model, forecast, walk-forward backtest, trade-setup simulator
  src/routes.ts      HTTP API (validated with zod)
apps/web
  src/components     Chart (lightweight-charts), panels (Recharts), UI primitives
  src/hooks          Data fetching (TanStack Query)
  src/lib            API client, formatting, palette, persisted UI state
```

### Extending it

- **New data source:** add a provider in `apps/server/src/providers` and register it in `index.ts`.
- **New metric:** describe it in `analytics/metrics.ts` and compute it in `analytics/dataset.ts`
  (plus a model transform if it should be usable as an input). The UI and the model pick it up.
- **Scaling beyond one machine:** the `Store` interface is async and can be re-implemented on
  Postgres/TimescaleDB; the API is stateless apart from in-memory caches; the forecast and backtest
  functions are pure and can move to worker threads or a job queue unchanged.

## Quality checks

```bash
npm run check   # typecheck + tests + translation coverage: run before committing
npm test        # model tests only (apps/server/test)
npm run bench   # walk-forward comparison of model variants on your local data
```

The tests run on a seeded synthetic price history, so they need neither the network nor the local
database. They cover the statistics (weighted quantiles, the independent sample count), the
no-lookahead guarantee (rewriting every bar after a date must not change the analogs or the
volatility estimates at that date), end-to-end sanity (probabilities sum to one, wider confidence
means wider bands, no claimed edge on a pure random walk) and the trade maths (Kelly sizing against
the textbook value, Value at Risk vs Expected Shortfall, ATR and R-multiple brackets, position size).

## Known limits of this first version

- Daily resolution only. Intraday stop/target ordering is unknown, so a day that touches both
  levels counts as a stop.
- Short-term-holder inputs are limited to four years on the free feed; using them as model inputs
  shortens the analog history accordingly.
- The halving-cycle input backtests best but rests on three completed cycles.
- Backtests run in the API process (about one second); heavy parameter sweeps would belong in a worker.
