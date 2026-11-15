import { existsSync } from 'node:fs';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { DatasetService } from './analytics/dataset.js';
import { config } from './config.js';
import { AlertEngine } from './alerts/engine.js';
import { registerAlertRoutes } from './alerts/routes.js';
import { registerLiveStream } from './liveStream.js';
import { registerRoutes, settingsSchema } from './routes.js';
import { openSqliteStore } from './store/sqliteStore.js';
import { LiquidationStream } from './providers/liquidationStream.js';
import { PriceStream } from './providers/priceStream.js';
import { Notifier } from './notify/notifier.js';
import { SettingsService } from './settings.js';
import { registerSettingsRoutes } from './settingsRoutes.js';
import { SyncService } from './sync.js';

const app = Fastify({ logger: { level: 'warn' } });
await app.register(cors, { origin: true });

const store = openSqliteStore(config.dataDir);
const datasets = new DatasetService(store);
const sync = new SyncService(store, (msg) => console.log(`[sync] ${msg}`));
sync.onData(() => datasets.invalidate());

const liquidations = new LiquidationStream(store, (msg) => console.log(`[stream] ${msg}`));
const prices = new PriceStream((msg) => console.log(`[stream] ${msg}`));

const settings = new SettingsService(store);
const notifier = new Notifier(settings, store, undefined, (msg) => console.log(`[notify] ${msg}`));

const compute = registerRoutes(app, datasets, sync, { store, liquidations, prices });
registerSettingsRoutes(app, { settings, notifier, store });

const alerts = new AlertEngine({ store, notify: (m) => notifier.notify(m), today: compute.today, log: (msg) => console.log(`[alert] ${msg}`) });
registerAlertRoutes(app, alerts, settingsSchema);
registerLiveStream(app, { liquidations, prices, alerts });
// The feeds push into the engine; a failed check must never take a feed down with it.
const guarded = (what: string, run: Promise<void>) => void run.catch((err: Error) => console.log(`[alert] ${what} check failed: ${err.message}`));
prices.onTicker((ticker) => guarded('price', alerts.onPrice(ticker.price)));
liquidations.onPrints((prints) => guarded('liquidation', alerts.onPrints(prints)));
sync.onData(() => guarded('reading', alerts.checkReadings()));
/** Readings follow completed bars; this only catches a bar that closed between two syncs. */
const READING_CHECK_MS = 10 * 60_000;
let readingTimer: ReturnType<typeof setInterval> | null = null;

// In production the API also serves the built web app (npm run build && npm start).
if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.status(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
  );
}

await app.listen({ port: config.port, host: config.host });
console.log(`[server] smart-btc API on http://${config.host}:${config.port}`);
if (config.syncEnabled) {
  sync.start();
  liquidations.start();
  prices.start();
  void alerts.list();
  readingTimer = setInterval(() => guarded('reading', alerts.checkReadings()), READING_CHECK_MS);
} else console.log('[server] SYNC=off – serving local data only');

const shutdown = async () => {
  if (readingTimer) clearInterval(readingTimer);
  sync.stop();
  await liquidations.stop();
  prices.stop();
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
