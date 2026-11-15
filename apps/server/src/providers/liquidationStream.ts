import type { LiquidationFeed, LiquidationPrint } from '@smart-btc/shared';
import { ReconnectingSocket, type SocketSpec } from '../lib/reconnectingSocket.js';
import type { Store } from '../store/store.js';

/**
 * Live forced liquidations from the two largest BTC perpetual venues, over their public websockets:
 *
 *  - Binance USD-M  wss://fstream.binance.com/ws/btcusdt@forceOrder   (largest order per second)
 *  - Bybit linear   wss://stream.bybit.com/v5/public/linear           (allLiquidation.BTCUSDT)
 *
 * Neither venue offers a historical archive, so every print is stored locally: the history starts the
 * day this collector first runs and grows from there. Both feeds are sampled by the exchanges
 * (Binance pushes at most one order per second), so totals are a floor, not the full amount.
 */

type Venue = 'Binance' | 'Bybit';

interface Feed extends SocketSpec {
  venue: Venue;
  parse(msg: unknown): LiquidationPrint[];
}

const num = (x: unknown) => (typeof x === 'string' || typeof x === 'number' ? Number(x) : NaN);

export const FEEDS: Feed[] = [
  {
    venue: 'Binance',
    url: 'wss://fstream.binance.com/ws/btcusdt@forceOrder',
    parse(msg) {
      const o = (msg as { o?: Record<string, unknown> }).o;
      if (!o) return [];
      const price = num(o.ap) || num(o.p);
      const qty = num(o.z) || num(o.q);
      // A forced SELL closes a long; a forced BUY closes a short.
      const side = o.S === 'SELL' ? 'long' : 'short';
      return [{ t: num(o.T), venue: 'Binance', side, price, usd: price * qty }];
    },
  },
  {
    venue: 'Bybit',
    url: 'wss://stream.bybit.com/v5/public/linear',
    hello: [{ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] }],
    ping: { everyMs: 20_000, message: { op: 'ping' } },
    parse(msg) {
      const m = msg as { topic?: string; data?: Record<string, unknown>[] };
      if (!m.topic?.startsWith('allLiquidation') || !Array.isArray(m.data)) return [];
      return m.data.map((d) => {
        const price = num(d.p);
        // Bybit reports the side of the position that was liquidated.
        return { t: num(d.T), venue: 'Bybit' as const, side: d.S === 'Buy' ? ('long' as const) : ('short' as const), price, usd: price * num(d.v) };
      });
    },
  },
];

export class LiquidationStream {
  private sockets: { venue: Venue; socket: ReconnectingSocket; events: number }[];
  private buffer: LiquidationPrint[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(prints: LiquidationPrint[]) => void>();

  constructor(
    private store: Store,
    private log: (msg: string) => void = () => {},
  ) {
    this.sockets = FEEDS.map((feed) => {
      const entry = {
        venue: feed.venue,
        events: 0,
        socket: new ReconnectingSocket(
          feed,
          (msg) => {
            const prints = feed.parse(msg).filter((p) => Number.isFinite(p.t) && p.price > 0 && p.usd > 0);
            if (!prints.length) return;
            entry.events += prints.length;
            entry.socket.status.lastEventAt = Date.now();
            this.buffer.push(...prints);
            for (const fn of this.listeners) fn(prints);
          },
          () => log(`${feed.venue} liquidation stream connected`),
        ),
      };
      return entry;
    });
  }

  start() {
    if (this.flushTimer) return;
    for (const s of this.sockets) s.socket.start();
    // Prints are written in small batches rather than one transaction per message.
    this.flushTimer = setInterval(() => void this.flush(), 5000);
  }

  async stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    for (const s of this.sockets) s.socket.stop();
    await this.flush();
  }

  status() {
    return this.sockets.map((s) => ({ venue: s.venue, ...s.socket.status, events: s.events }));
  }

  /** Called with every batch of prints as it arrives, before it is stored. */
  onPrints(fn: (prints: LiquidationPrint[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Writes the prints received since the last flush, so a read right after sees them. */
  async flush() {
    if (!this.buffer.length) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      await this.store.addLiquidations(rows);
    } catch (err) {
      this.log(`could not store ${rows.length} liquidations: ${(err as Error).message}`);
    }
  }
}

const WINDOWS: [id: '1h' | '4h' | '24h', ms: number][] = [
  ['1h', 3_600_000],
  ['4h', 4 * 3_600_000],
  ['24h', 24 * 3_600_000],
];
const BUCKET_PCT = 0.25;

/** Summary of the stored prints for the interface: totals by window, the largest recent ones and a price profile. */
export async function liquidationFeed(store: Store, stream: LiquidationStream, price: number): Promise<LiquidationFeed> {
  await stream.flush();
  const now = Date.now();
  const rows = await store.getLiquidations(now - 24 * 3_600_000);
  const since = await store.firstLiquidationT();
  const totals = WINDOWS.map(([window, ms]) => {
    let longUsd = 0;
    let shortUsd = 0;
    let count = 0;
    for (const r of rows) {
      if (r.t < now - ms) continue;
      count++;
      if (r.side === 'long') longUsd += r.usd;
      else shortUsd += r.usd;
    }
    return { window, longUsd, shortUsd, count };
  });
  // Where the last day's liquidations happened, in 0.25% price steps around the current price.
  const step = (price * BUCKET_PCT) / 100;
  const byBucket = new Map<number, { longUsd: number; shortUsd: number }>();
  for (const r of rows) {
    const k = Math.round(r.price / step);
    const b = byBucket.get(k) ?? { longUsd: 0, shortUsd: 0 };
    if (r.side === 'long') b.longUsd += r.usd;
    else b.shortUsd += r.usd;
    byBucket.set(k, b);
  }
  const profile = [...byBucket]
    .map(([k, b]) => ({ price: k * step, ...b }))
    .sort((a, b) => b.longUsd + b.shortUsd - (a.longUsd + a.shortUsd))
    .slice(0, 14)
    .sort((a, b) => b.price - a.price);
  const largest = [...rows].sort((a, b) => b.usd - a.usd).slice(0, 12).sort((a, b) => b.t - a.t);
  return { at: now, since, venues: stream.status(), totals, largest, profile };
}
