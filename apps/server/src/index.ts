import { existsSync } from 'node:fs';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { DatasetService } from './analytics/dataset.js';
import { config } from './config.js';
import { registerRoutes } from './routes.js';
import { openSqliteStore } from './store/sqliteStore.js';
import { LiquidationStream } from './providers/liquidationStream.js';
import { PriceStream } from './providers/priceStream.js';
import { SyncService } from './sync.js';

const app = Fastify({ logger: { level: 'warn' } });
await app.register(cors, { origin: true });

const store = openSqliteStore(config.dataDir);
const datasets = new DatasetService(store);
const sync = new SyncService(store, (msg) => console.log(`[sync] ${msg}`));
sync.onData(() => datasets.invalidate());

const liquidations = new LiquidationStream(store, (msg) => console.log(`[stream] ${msg}`));
const prices = new PriceStream((msg) => console.log(`[stream] ${msg}`));

registerRoutes(app, datasets, sync, { store, liquidations, prices });

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
} else console.log('[server] SYNC=off – serving local data only');

const shutdown = async () => {
  sync.stop();
  await liquidations.stop();
  prices.stop();
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
