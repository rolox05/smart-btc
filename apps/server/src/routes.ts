import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  HEATMAP_WINDOWS,
  TIMEFRAMES,
  type BacktestRequest,
  type BacktestResult,
  type BacktestSummary,
  type Overview,
  type SeriesPayload,
  type Ticker,
  type Timeframe,
} from '@smart-btc/shared';
import { type Dataset, type DatasetService, snapshot } from './analytics/dataset.js';
import { ANNOTATIONS, buildAnnotation } from './analytics/divergence.js';
import { HEATMAP_TIMEFRAME, liquidationHeatmap, liquidityReport } from './analytics/liquidity.js';
import { metricsFor } from './analytics/metrics.js';
import { buildRelations } from './analytics/relations.js';
import { PreparedCache } from './forecast/analog.js';
import { runBacktest } from './forecast/backtest.js';
import { ForecastError, runForecast } from './forecast/forecast.js';
import { runTradeSetup } from './forecast/tradeSetup.js';
import { fetchJsonAny, ttlCache } from './lib/http.js';
import { BINANCE_SPOT_HOSTS } from './providers/binance.js';
import type { SyncService } from './sync.js';

const tfSchema = z.enum(TIMEFRAMES).default('1d');

const settingsSchema = z.object({
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

export function registerRoutes(app: FastifyInstance, datasets: DatasetService, sync: SyncService) {
  const prepared = new PreparedCache();
  const results = new ResultCache();

  const dataset = async (tf: Timeframe = '1d'): Promise<Dataset> => {
    // Intraday history is paged in from the oldest bar, so it is only usable once a sync has completed.
    if ((tf === '15m' || tf === '1h' || tf === '4h') && !(await sync.everSynced(`binance-${tf}`))) {
      throw new NotReady(`Downloading ${tf} candles for the first time. This takes up to a minute.`);
    }
    const ds = await datasets.get(tf);
    if (!ds) throw new NotReady('Price history is still downloading. This takes a few seconds on first start.');
    return ds;
  };
  /** Cache key that changes with the data of a timeframe (bar count and last bar), not on every tick. */
  const stamp = (ds: Dataset) => `${ds.tf}:${ds.t[ds.n - 1]}:${ds.n}`;

  app.setErrorHandler((err: Error, _req, reply) => {
    if (err instanceof NotReady) return reply.status(503).send({ error: err.message, code: 'not_ready' });
    if (err instanceof ForecastError) return reply.status(422).send({ error: err.message });
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    app.log.error(err);
    return reply.status(500).send({ error: err.message || 'Internal error' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/overview', async (req): Promise<Overview> => {
    const { tf } = z.object({ tf: tfSchema }).parse(req.query);
    const ds = await dataset(tf);
    return {
      timeframe: tf,
      asOf: ds.t[ds.n - 1],
      price: ds.c[ds.n - 1],
      metrics: metricsFor(tf),
      annotations: ANNOTATIONS,
      snapshot: snapshot(ds),
      sources: await sync.status(),
      history: { from: ds.t[0], to: ds.t[ds.n - 1], days: ds.n },
    };
  });

  app.get('/api/sources', async () => sync.status());

  app.post('/api/refresh', async () => {
    await sync.runDue(true);
    return sync.status();
  });

  app.get('/api/candles', async (req) => {
    const { tf } = z.object({ tf: tfSchema }).parse(req.query);
    const ds = await dataset(tf);
    const out = [];
    for (let i = Math.max(0, ds.n - MAX_CHART_BARS); i < ds.n; i++) {
      out.push({ t: ds.t[i], o: ds.o[i], h: ds.h[i], l: ds.l[i], c: ds.c[i], v: ds.v[i] });
    }
    return out;
  });

  app.get('/api/series', async (req): Promise<SeriesPayload> => {
    const { ids, tf } = z.object({ ids: z.string().default(''), tf: tfSchema }).parse(req.query);
    const ds = await dataset(tf);
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
  app.get('/api/ticker', async (): Promise<Ticker> => {
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
        source: 'last daily candle',
        at: ds.builtAt,
      };
    }
  });

  // Liquidity does not depend on the chart timeframe: it always reads daily and 4h swings plus live books.
  app.get('/api/liquidity', async () => liquidityReport(await dataset()));

  app.get('/api/liquidation-heatmap', async (req) => {
    const { window } = z.object({ window: z.enum(HEATMAP_WINDOWS).default('2w') }).parse(req.query);
    const ds = await dataset(HEATMAP_TIMEFRAME(window));
    // One build per window and per data update; the still-open bar changes little within that.
    return results.get(`h:${ds.version}:${window}`, () => liquidationHeatmap(window, ds));
  });

  app.get('/api/annotations/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { tf } = z.object({ tf: tfSchema }).parse(req.query);
    const ds = await dataset(tf);
    const payload = results.get(`a:${stamp(ds)}:${id}`, () => {
      const full = buildAnnotation(ds, id);
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
    const ds = await dataset(q.tf);
    return results.get(`r:${stamp(ds)}:${JSON.stringify(q)}`, () => buildRelations(ds, q.window, q.horizon, q.startYear));
  });

  app.post('/api/forecast', async (req) => {
    const settings = settingsSchema.parse(req.body);
    const ds = await dataset(settings.timeframe);
    return results.get(`f:${ds.version}:${JSON.stringify(settings)}`, () =>
      runForecast(ds, prepared.get(ds, settings.horizon), settings),
    );
  });

  // The still-open candle moves a backtest by nothing material, so its cache follows completed bars only.
  const backtestFor = (ds: Dataset, body: BacktestRequest): BacktestResult =>
    results.get(`b:${stamp(ds)}:${JSON.stringify(body)}`, () => runBacktest(ds, prepared.get(ds, body.settings.horizon), body));

  app.post('/api/backtest', async (req) => {
    const body = backtestSchema.parse(req.body);
    return backtestFor(await dataset(body.settings.timeframe), body);
  });

  // Same computation, trimmed to what the input ranking needs.
  app.post('/api/backtest/summary', async (req): Promise<BacktestSummary> => {
    const body = backtestSchema.parse(req.body);
    const r = backtestFor(await dataset(body.settings.timeframe), body);
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
    const ds = await dataset(body.settings.timeframe);
    return results.get(`t:${ds.version}:${JSON.stringify(body)}`, () =>
      runTradeSetup(ds, prepared.get(ds, body.settings.horizon), body),
    );
  });
}
