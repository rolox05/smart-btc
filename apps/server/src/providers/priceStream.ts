import type { Ticker } from '@smart-btc/shared';
import { ReconnectingSocket } from '../lib/reconnectingSocket.js';

/**
 * Live BTC/USDT price from Binance spot: the rolling 24-hour ticker, pushed about once per second.
 * Binance closes every connection after 24 hours; the socket reconnects on its own.
 */
const URLS = ['wss://stream.binance.com:9443/ws/btcusdt@ticker', 'wss://data-stream.binance.vision/ws/btcusdt@ticker'];

/** How long a pushed price counts as current. */
const FRESH_MS = 6_000;

export function parseTicker(msg: unknown, now: number): Ticker | null {
  const m = msg as Record<string, unknown>;
  if (m?.e !== '24hrTicker') return null;
  const price = Number(m.c);
  if (!(price > 0)) return null;
  return {
    price,
    change24hPct: Number(m.P),
    high24h: Number(m.h),
    low24h: Number(m.l),
    volume24hUsd: Number(m.q),
    source: 'Binance',
    at: now,
  };
}

export class PriceStream {
  private sockets: ReconnectingSocket[];
  private last: Ticker | null = null;
  private listeners = new Set<(t: Ticker) => void>();

  constructor(log: (msg: string) => void = () => {}) {
    // Two hosts carry the same stream; the second only matters where the first is unreachable.
    this.sockets = URLS.map(
      (url, i) =>
        new ReconnectingSocket(
          { url, staleAfterMs: 20_000 },
          (msg) => {
            // The backup host stays quiet while the main one is delivering.
            if (i > 0 && this.sockets[0].status.connected) return;
            const now = Date.now();
            const ticker = parseTicker(msg, now);
            if (!ticker) return;
            this.sockets[i].status.lastEventAt = now;
            this.last = ticker;
            for (const fn of this.listeners) fn(ticker);
          },
          () => log(`Binance price stream connected (${new URL(url).host})`),
        ),
    );
  }

  start() {
    for (const s of this.sockets) s.start();
  }

  stop() {
    for (const s of this.sockets) s.stop();
  }

  /** The latest pushed ticker, or null when the stream has gone quiet. */
  latest(now = Date.now()): Ticker | null {
    return this.last && now - this.last.at < FRESH_MS ? this.last : null;
  }

  onTicker(fn: (t: Ticker) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
