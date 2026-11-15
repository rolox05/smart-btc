import type { LiquidationFeed, LiquidationPrint } from '@smart-btc/shared';
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

interface Feed {
  venue: Venue;
  url: string;
  /** Messages sent right after connecting (subscriptions). */
  hello?: unknown[];
  /** Application-level keep-alive, where the venue requires one. */
  ping?: { everyMs: number; message: unknown };
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

interface FeedState {
  connected: boolean;
  lastEventAt: number | null;
  events: number;
  error: string | null;
}

export class LiquidationStream {
  private state = new Map<Venue, FeedState>();
  private sockets = new Map<Venue, WebSocket>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private buffer: LiquidationPrint[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  constructor(
    private store: Store,
    private log: (msg: string) => void = () => {},
  ) {
    for (const f of FEEDS) this.state.set(f.venue, { connected: false, lastEventAt: null, events: 0, error: null });
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    for (const feed of FEEDS) this.connect(feed, 1000);
    // Prints are written in small batches rather than one transaction per message.
    this.flushTimer = setInterval(() => void this.flush(), 5000);
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.flushTimer) clearInterval(this.flushTimer);
    for (const ws of this.sockets.values()) ws.close();
    this.sockets.clear();
    await this.flush();
  }

  status() {
    return FEEDS.map((f) => ({ venue: f.venue, ...this.state.get(f.venue)! }));
  }

  private async flush() {
    if (!this.buffer.length) return;
    const rows = this.buffer;
    this.buffer = [];
    try {
      await this.store.addLiquidations(rows);
    } catch (err) {
      this.log(`could not store ${rows.length} liquidations: ${(err as Error).message}`);
    }
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private connect(feed: Feed, backoffMs: number) {
    if (this.stopped) return;
    const st = this.state.get(feed.venue)!;
    let ws: WebSocket;
    try {
      ws = new WebSocket(feed.url);
    } catch (err) {
      st.error = (err as Error).message;
      this.later(() => this.connect(feed, Math.min(60_000, backoffMs * 2)), backoffMs);
      return;
    }
    this.sockets.set(feed.venue, ws);
    let pinger: ReturnType<typeof setInterval> | null = null;
    let nextBackoff = backoffMs;

    ws.addEventListener('open', () => {
      st.connected = true;
      st.error = null;
      nextBackoff = 1000;
      this.log(`${feed.venue} liquidation stream connected`);
      for (const m of feed.hello ?? []) ws.send(JSON.stringify(m));
      if (feed.ping) pinger = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(feed.ping!.message)), feed.ping.everyMs);
    });
    ws.addEventListener('message', (ev) => {
      try {
        const prints = feed.parse(JSON.parse(String(ev.data))).filter((p) => Number.isFinite(p.t) && p.price > 0 && p.usd > 0);
        if (!prints.length) return;
        st.events += prints.length;
        st.lastEventAt = Date.now();
        this.buffer.push(...prints);
      } catch {
        /* a malformed frame is not worth dropping the connection for */
      }
    });
    ws.addEventListener('error', () => {
      st.error = 'connection error';
    });
    ws.addEventListener('close', () => {
      st.connected = false;
      if (pinger) clearInterval(pinger);
      if (this.stopped) return;
      this.later(() => this.connect(feed, Math.min(60_000, nextBackoff * 2)), nextBackoff);
    });
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
