import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  HEATMAP_WINDOWS,
  TIMEFRAMES,
  type BacktestRequest,
  type BacktestResult,
  type BacktestSummary,
  type ForecastResult,
  type ForecastSettings,
  type Overview,
  type SeriesPayload,
  type Ticker,
  type Timeframe,
  type TodaySnapshot,
  type TodaySummary,
} from '@smart-btc/shared';
import { type Dataset, type DatasetService, snapshot } from './analytics/dataset.js';
import { annotationsFor, buildAnnotation } from './analytics/divergence.js';
import { langOf, makeT, type T } from './i18n/index.js';
import { HEATMAP_TIMEFRAME, liquidationHeatmap } from './analytics/liquidationHeatmap.js';
import { liquidityReport } from './analytics/liquidity.js';
import { metricsFor } from './analytics/metrics.js';
import { buildRelations } from './analytics/relations.js';
import { eventData, eventOverlay, eventsReport } from './analytics/events.js';
import { buildToday, snapshotOf } from './analytics/today.js';
import { PreparedCache } from './forecast/analog.js';
import { runModels } from './forecast/models.js';
import { type LiquidationStream, liquidationFeed } from './providers/liquidationStream.js';
import type { PriceStream } from './providers/priceStream.js';
import type { Store } from './store/store.js';
import { runBacktest } from './forecast/backtest.js';
import { ForecastError, runForecast } from './forecast/forecast.js';
import { runTradeSetup } from './forecast/tradeSetup.js';
import { fetchJsonAny, ttlCache } from './lib/http.js';
import { BINANCE_SPOT_HOSTS } from './providers/binance.js';
import type { SyncService } from './sync.js';

const tfSchema = z.enum(TIMEFRAMES).default('1d');

export const settingsSchema = z.object({
  timeframe: tfSchema,
  horizon: z.number().int().min(1).max(400),
  features: z.array(z.string()).max(30),
  k: z.number().int().min(10).max(400),
  minGapBars: z.number().int().min(1).max(500),
  volAdjust: z.boolean(),
  startYear: z.number().int().min(2011).max(2030),
  recencyHalfLifeYears: z.number().min(0).max(20),
  scenarioThresholdPct: z.number().min(0).max(60),
  baseRateBlend: z.number().min(0).max(1),
});
const backtestSchema = z.object({
  settings: settingsSchema,
  stepBars: z.number().int().min(1).max(500),
  touchPct: z.number().min(0).max(50),
});
const tradeSchema = z.object({
  settings: settingsSchema,
  side: z.enum(['long', 'short']),
  entry: z.number().min(0),
  stopPct: z.number().min(0.02).max(50),
  takePct: z.number().min(0.02).max(200),
  leverage: z.number().min(1).max(125),
  accountUsd: z.number().min(1),
  riskPct: z.number().min(0.05).max(100),
  feeBps: z.number().min(0).max(50),
  stopMode: z.enum(['pct', 'atr']).default('pct'),
  stopAtr: z.number().min(0.25).max(10).default(2),
  takeMode: z.enum(['pct', 'r']).default('pct'),
  takeR: z.number().min(0.25).max(10).default(2),
  kellyFraction: z.number().min(0.05).max(1).default(0.25),
  confidence: z.number().min(0.5).max(0.999).default(0.95),
});

/** Chart payloads are capped: nobody scrolls through 100,000 intraday bars, and the browser should not have to. */
const MAX_CHART_BARS = 6000;

class NotReady extends Error {}

/** Small bounded cache for expensive, deterministic computations. */
class ResultCache {
  private map = new Map<string, unknown>();
  get<T>(key: string, compute: () => T): T {
    if (this.map.has(key)) return this.map.get(key) as T;
    const value = compute();
    if (this.map.size >= 240) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, value);
    return value;
  }
}

export function registerRoutes(
  app: FastifyInstance,
  datasets: DatasetService,
  sync: SyncService,
  live: { store: Store; liquidations: LiquidationStream; prices: PriceStream },
) {
  const prepared = new PreparedCache();
  const results = new ResultCache();

  const dataset = async (tf: Timeframe = '1d', t?: T): Promise<Dataset> => {
    const tr = t ?? makeT('en');
    // Intraday history is paged in from the oldest bar, so it is only usable once a sync has completed.
    if ((tf === '15m' || tf === '1h' || tf === '4h') && !(await sync.everSynced(`binance-${tf}`))) {
      throw new NotReady(tr('Downloading {tf} candles for the first time. This takes up to a minute.', { tf }));
    }
    const ds = await datasets.get(tf);
    if (!ds) throw new NotReady(tr('Price history is still downloading. This takes a few seconds on first start.'));
    return ds;
  };
  /** Translator for the language the client asked for. */
  const trOf = (req: Parameters<typeof langOf>[0]) => makeT(langOf(req));
  /** Cache key that changes with the data of a timeframe (bar count and last bar), not on every tick. */
  const stamp = (ds: Dataset) => `${ds.tf}:${ds.t[ds.n - 1]}:${ds.n}`;

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof NotReady) return reply.status(503).send({ error: err.message, code: 'not_ready' });
    if (err instanceof ForecastError) return reply.status(422).send({ error: err.message });
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: err.message || 'Internal error' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/overview', async (req): Promise<Overview> => {
    const { tf } = z.object({ tf: tfSchema }).parse(req.query);
    const t = trOf(req);
    const ds = await dataset(tf, t);
    return {
      timeframe: tf,
      asOf: ds.t[ds.n - 1],
      price: ds.c[ds.n - 1],
      metrics: metricsFor(tf, t),
      annotations: annotationsFor(t),
      snapshot: snapshot(ds, t),
      sources: await sync.status(t),
      history: { from: ds.t[0], to: ds.t[ds.n - 1], days: ds.n },
    };
  });

  app.get('/api/sources', async (req) => sync.status(trOf(req)));

  app.post('/api/refresh', async (req) => {
    await sync.runDue(true);
    return sync.status(trOf(req));
  });

  app.get('/api/candles', async (req) => {
    const { tf } = z.object({ tf: tfSchema }).parse(req.query);
    const ds = await dataset(tf, trOf(req));
    const out = [];
    for (let i = Math.max(0, ds.n - MAX_CHART_BARS); i < ds.n; i++) {
      out.push({ t: ds.t[i], o: ds.o[i], h: ds.h[i], l: ds.l[i], c: ds.c[i], v: ds.v[i] });
    }
    return out;
  });

  app.get('/api/series', async (req): Promise<SeriesPayload> => {
    const { ids, tf } = z.object({ ids: z.string().default(''), tf: tfSchema }).parse(req.query);
    const ds = await dataset(tf, trOf(req));
    const start = Math.max(0, ds.n - MAX_CHART_BARS);
    const series: SeriesPayload['series'] = {};
    for (const id of ids.split(',').filter(Boolean)) {
      const x = ds.series.get(id);
      if (!x) continue;
      const arr: (number | null)[] = [];
      for (let i = start; i < ds.n; i++) arr.push(Number.isNaN(x[i]) ? null : +x[i].toPrecision(7));
      series[id] = arr;
    }
    return { t: ds.t.slice(start), series };
  });

  const loadTicker = ttlCache(4_000, async (): Promise<Ticker> => {
    const r = await fetchJsonAny<Record<string, string>>(
      BINANCE_SPOT_HOSTS.map((h) => `${h}/api/v3/ticker/24hr?symbol=BTCUSDT`),
      { timeoutMs: 6_000, retries: 0 },
    );
    return {
      price: +r.lastPrice,
      change24hPct: +r.priceChangePercent,
      high24h: +r.highPrice,
      low24h: +r.lowPrice,
      volume24hUsd: +r.quoteVolume,
      source: 'Binance',
      at: Date.now(),
    };
  });
  app.get('/api/ticker', async (req): Promise<Ticker> => {
    const pushed = live.prices.latest();
    if (pushed) return pushed;
    try {
      return await loadTicker();
    } catch {
      const ds = await dataset();
      const i = ds.n - 1;
      return {
        price: ds.c[i],
        change24hPct: (ds.c[i] / ds.c[i - 1] - 1) * 100,
        high24h: ds.h[i],
        low24h: ds.l[i],
        volume24hUsd: ds.v[i] * ds.c[i],
        source: trOf(req)('last daily candle'),
        at: ds.builtAt,
      };
    }
  });

  // Liquidity does not depend on the chart timeframe: it always reads daily and 4h swings plus live books.
  app.get('/api/liquidity', async (req) => {
    const t = trOf(req);
    return liquidityReport(await dataset('1d', t), t);
  });

  // Liquidations received over the exchange websockets and stored locally.
  app.get('/api/liquidations', async () => {
    const ds = await dataset('1d');
    return liquidationFeed(live.store, live.liquidations, ds.c[ds.n - 1]);
  });

  app.get('/api/liquidation-heatmap', async (req) => {
    const { window } = z.object({ window: z.enum(HEATMAP_WINDOWS).default('2w') }).parse(req.query);
    const t = trOf(req);
    const ds = await dataset(HEATMAP_TIMEFRAME(window), t);
    const daily = await dataset('1d', t);
    // One build per window, language and data update; the still-open bar changes little within that.
    return results.get(`h:${t.lang}:${ds.version}:${window}`, () => liquidationHeatmap(window, ds, daily, t));
  });

  app.get('/api/annotations/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { tf } = z.object({ tf: tfSchema }).parse(req.query);
    const t = trOf(req);
    const ds = await dataset(tf, t);
    const payload = results.get(`a:${t.lang}:${stamp(ds)}:${id}`, () => {
      const full = buildAnnotation(ds, id, t);
      if (!full) return null;
      // Statistics use the whole history; only the segments the chart can show are sent.
      const firstT = ds.t[Math.max(0, ds.n - MAX_CHART_BARS)];
      return { ...full, segments: full.segments.filter((s) => s.t1 >= firstT) };
    });
    return payload ?? reply.status(404).send({ error: `Unknown annotation "${id}"` });
  });

  app.get('/api/relations', async (req) => {
    const q = z
      .object({
        tf: tfSchema,
        window: z.enum(['all', '4y', '1y']).default('all'),
        horizon: z.coerce.number().int().min(1).max(400).default(30),
        startYear: z.coerce.number().int().min(2011).max(2030).default(2013),
      })
      .parse(req.query);
    const ds = await dataset(q.tf, trOf(req));
    return results.get(`r:${stamp(ds)}:${JSON.stringify(q)}`, () => buildRelations(ds, q.window, q.horizon, q.startYear));
  });

  app.post('/api/forecast', async (req) => {
    const settings = settingsSchema.parse(req.body);
    const t = trOf(req);
    const ds = await dataset(settings.timeframe, t);
    return results.get(`f:${t.lang}:${ds.version}:${JSON.stringify(settings)}`, () =>
      runForecast(ds, prepared.get(ds, settings.horizon), settings, t),
    );
  });

  // Calendar of scheduled events, how Bitcoin behaved on past ones, option expiries and ETF activity.
  app.get('/api/events', async (req) => {
    const t = trOf(req);
    return eventsReport(await dataset('1d', t), live.store, t);
  });

  // The three models side by side, with the consensus widened for events inside the horizon.
  const modelsFor = async (settings: ForecastSettings, t: T) => {
    const ds = await dataset(settings.timeframe, t);
    const daily = await dataset('1d', t);
    const events = await eventData(daily, t);
    const overlay = eventOverlay(events.upcoming, events.studies, Math.floor(Date.now() / 1000), settings.horizon * ds.barDays);
    const report = results.get(`m:${t.lang}:${stamp(ds)}:${JSON.stringify(settings)}:${overlay.spreadMultiplier.toFixed(3)}`, () =>
      runModels(ds, prepared.get(ds, settings.horizon), settings, overlay, t),
    );
    return { ds, daily, events, report };
  };
  app.post('/api/models', async (req) => (await modelsFor(settingsSchema.parse(req.body), trOf(req))).report);

  // The conclusion first: one reading built from the models, the forecast, the calendar and liquidity.
  const todayFor = async (settings: ForecastSettings, t: T): Promise<TodaySummary | null> => {
    const { ds, daily, events, report } = await modelsFor(settings, t);
    let forecast: ForecastResult | null = null;
    if (settings.features.length) {
      try {
        forecast = results.get(`f:${t.lang}:${ds.version}:${JSON.stringify(settings)}`, () => runForecast(ds, prepared.get(ds, settings.horizon), settings, t));
      } catch (err) {
        if (!(err instanceof ForecastError)) throw err;
      }
    }
    // Order books are live calls to the exchanges; the summary does not wait on a failure there.
    const liquidity = await liquidityReport(daily, t).catch(() => null);
    const series = `${settings.timeframe}:${settings.horizon}`;
    let previous: TodaySnapshot | null = null;
    try {
      previous = JSON.parse((await live.store.previousReading(series, report.asOf)) ?? 'null') as TodaySnapshot | null;
    } catch {
      /* an unreadable saved reading is treated as none */
    }
    const summary = buildToday({ models: report, forecast, events: events.upcoming, liquidity, previous, now: Math.floor(Date.now() / 1000), barDays: ds.barDays }, t);
    if (summary) await live.store.saveReading(series, summary.asOf, JSON.stringify(snapshotOf(summary)));
    return summary;
  };
  app.post('/api/today', async (req, reply): Promise<TodaySummary | undefined> => {
    const t = trOf(req);
    const summary = await todayFor(settingsSchema.parse(req.body), t);
    return summary ?? reply.status(422).send({ error: t('Not enough history on this timeframe to fit the model.') });
  });

  // The still-open candle moves a backtest by nothing material, so its cache follows completed bars only.
  const backtestFor = (ds: Dataset, body: BacktestRequest, t: T): BacktestResult =>
    results.get(`b:${t.lang}:${stamp(ds)}:${JSON.stringify(body)}`, () => runBacktest(ds, prepared.get(ds, body.settings.horizon), body, t));

  app.post('/api/backtest', async (req) => {
    const body = backtestSchema.parse(req.body);
    const t = trOf(req);
    return backtestFor(await dataset(body.settings.timeframe, t), body, t);
  });

  // Same computation, trimmed to what the input ranking needs.
  app.post('/api/backtest/summary', async (req): Promise<BacktestSummary> => {
    const body = backtestSchema.parse(req.body);
    const t = trOf(req);
    const r = backtestFor(await dataset(body.settings.timeframe, t), body, t);
    return {
      features: body.settings.features,
      avgSkill: r.scores.reduce((a, s) => a + s.skill, 0) / r.scores.length,
      skills: Object.fromEntries(r.scores.map((s) => [s.event, s.skill])),
      evaluations: r.evaluations,
      from: r.from,
      to: r.to,
      directionalEdge: r.directional.accuracy - r.directional.alwaysLong,
      coverage80: r.coverage[0].observed,
      verdict: r.verdict.label,
    };
  });

  app.post('/api/trade-setup', async (req) => {
    const body = tradeSchema.parse(req.body);
    const t = trOf(req);
    const ds = await dataset(body.settings.timeframe, t);
    return results.get(`t:${t.lang}:${ds.version}:${JSON.stringify(body)}`, () =>
      runTradeSetup(ds, prepared.get(ds, body.settings.horizon), body, t),
    );
  });

  // What other parts of the server (the alert engine) may compute through the same caches.
  return { today: todayFor };
}
