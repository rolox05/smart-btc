import type { LiveEvents } from '@smart-btc/shared';
import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { AlertEngine } from './alerts/engine.js';
import type { LiquidationStream } from './providers/liquidationStream.js';
import type { PriceStream } from './providers/priceStream.js';

/** Comment line sent while nothing else is, so proxies keep the connection and the browser can tell it is alive. */
const HEARTBEAT_MS = 15_000;

const frame = <K extends keyof LiveEvents>(event: K, data: LiveEvents[K]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/**
 * GET /api/stream – one Server-Sent Events connection per browser tab carrying what changes by the
 * second: the price, each forced liquidation and every alert that fires. The exchange websockets stay on the server; the
 * browser only listens here, so nothing has to be polled while the stream is up.
 */
export function registerLiveStream(app: FastifyInstance, live: { liquidations: LiquidationStream; prices: PriceStream; alerts: AlertEngine }) {
  const clients = new Set<ServerResponse>();
  const broadcast = (text: string) => {
    for (const res of clients) res.write(text);
  };

  live.prices.onTicker((ticker) => clients.size && broadcast(frame('ticker', ticker)));
  live.liquidations.onPrints((prints) => clients.size && broadcast(frame('liquidations', prints)));
  live.alerts.onAlert((event) => broadcast(frame('alert', event)));
  const heartbeat = setInterval(() => broadcast(': keep-alive\n\n'), HEARTBEAT_MS);
  heartbeat.unref();

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const ticker = live.prices.latest();
    if (ticker) res.write(frame('ticker', ticker));
    clients.add(res);
    req.raw.on('close', () => clients.delete(res));
  });

  // Open streams would otherwise keep the server from shutting down.
  app.addHook('preClose', async () => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    clients.clear();
  });
}
