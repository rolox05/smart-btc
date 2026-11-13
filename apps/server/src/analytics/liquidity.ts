import type { Candle, DepthBucket, LiquidityLevel, LiquidityReport } from '@smart-btc/shared';
import { fetchJson, fetchJsonAny, ttlCache } from '../lib/http.js';
import { BINANCE_FUTURES, BINANCE_SPOT_HOSTS, fetchKlines } from '../providers/binance.js';
import type { Dataset } from './dataset.js';

/**
 * Three complementary views of "where the liquidity is":
 *  1. swing pools   - unswept swing highs/lows, where stop orders cluster
 *  2. liquidations  - estimated liquidation prices of leveraged positions opened recently
 *  3. order book    - resting limit orders across several spot venues
 * None of these has a free historical archive, so they are shown as context and are not model features.
 */

type Level = [price: number, size: number];
interface Book {
  venue: string;
  bids: Level[];
  asks: Level[];
}

const toLevels = (rows: (string | number)[][]): Level[] => rows.map((r) => [+r[0], +r[1]]);

async function fetchBooks(): Promise<Book[]> {
  const jobs: Promise<Book>[] = [
    fetchJsonAny<{ bids: string[][]; asks: string[][] }>(
      BINANCE_SPOT_HOSTS.map((h) => `${h}/api/v3/depth?symbol=BTCUSDT&limit=5000`),
    ).then((r) => ({ venue: 'Binance', bids: toLevels(r.bids), asks: toLevels(r.asks) })),
    fetchJson<{ bids: string[][]; asks: string[][] }>(
      'https://api.exchange.coinbase.com/products/BTC-USD/book?level=2',
    ).then((r) => ({ venue: 'Coinbase', bids: toLevels(r.bids), asks: toLevels(r.asks) })),
    fetchJson<{ bids: string[][]; asks: string[][] }>('https://www.bitstamp.net/api/v2/order_book/btcusd/').then(
      (r) => ({ venue: 'Bitstamp', bids: toLevels(r.bids), asks: toLevels(r.asks) }),
    ),
    fetchJson<{ result: Record<string, { bids: (string | number)[][]; asks: (string | number)[][] }> }>(
      'https://api.kraken.com/0/public/Depth?pair=XBTUSD&count=500',
    ).then((r) => {
      const book = Object.values(r.result)[0];
      return { venue: 'Kraken', bids: toLevels(book.bids), asks: toLevels(book.asks) };
    }),
  ];
  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
}

const BUCKET_PCT = 0.25;
const RANGE_PCT = 20;

function analyseBooks(books: Book[], mid: number) {
  const nb = Math.round((2 * RANGE_PCT) / BUCKET_PCT);
  const bid = new Float64Array(nb);
  const ask = new Float64Array(nb);
  const idx = (price: number) => Math.floor(((price / mid - 1) * 100 + RANGE_PCT) / BUCKET_PCT);
  for (const b of books) {
    for (const [p, s] of b.bids) {
      const i = idx(p);
      if (i >= 0 && i < nb && p < mid) bid[i] += p * s;
    }
    for (const [p, s] of b.asks) {
      const i = idx(p);
      if (i >= 0 && i < nb && p > mid) ask[i] += p * s;
    }
  }
  const depth: DepthBucket[] = [];
  for (let i = 0; i < nb; i++) {
    const distancePct = -RANGE_PCT + (i + 0.5) * BUCKET_PCT;
    depth.push({ price: mid * (1 + distancePct / 100), distancePct, bidUsd: bid[i], askUsd: ask[i] });
  }
  const within = (pct: number, side: 'bid' | 'ask') =>
    depth.reduce((s, d) => (Math.abs(d.distancePct) <= pct ? s + (side === 'bid' ? d.bidUsd : d.askUsd) : s), 0);
  const bidDepthUsd: Record<string, number> = {};
  const askDepthUsd: Record<string, number> = {};
  for (const pct of [1, 2, 5, 10]) {
    bidDepthUsd[pct] = within(pct, 'bid');
    askDepthUsd[pct] = within(pct, 'ask');
  }

  // A "wall" is a bucket holding several times the typical size on its side of the book.
  // Only buckets beyond 1.5% are considered: closer in, the book is dominated by fast market-maker quotes.
  const walls: LiquidityLevel[] = [];
  for (const side of ['bid', 'ask'] as const) {
    const cand = depth
      .filter((d) => Math.abs(d.distancePct) >= 1.5 && (side === 'bid' ? d.bidUsd : d.askUsd) > 0)
      .map((d) => ({ d, usd: side === 'bid' ? d.bidUsd : d.askUsd }));
    if (cand.length < 5) continue;
    const sorted = cand.map((x) => x.usd).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const top = cand
      .filter((x) => x.usd >= 3 * median)
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 5);
    const max = top[0]?.usd ?? 1;
    for (const { d, usd } of top) {
      walls.push({
        price: d.price,
        distancePct: d.distancePct,
        side: side === 'ask' ? 'buy-side' : 'sell-side',
        kind: 'orderbook',
        strength: usd / max,
        notionalUsd: usd,
        label: side === 'ask' ? 'Ask wall' : 'Bid wall',
        detail: `${(usd / median).toFixed(1)}× the median ${BUCKET_PCT}% bucket`,
      });
    }
  }
  const b2 = bidDepthUsd[2];
  const a2 = askDepthUsd[2];
  return {
    depth,
    walls,
    bidDepthUsd,
    askDepthUsd,
    bookImbalance2Pct: b2 + a2 > 0 ? (b2 - a2) / (b2 + a2) : null,
  };
}

// ───────────────────────── swing liquidity pools ─────────────────────────

interface Pivot {
  price: number;
  t: number;
  side: 'buy-side' | 'sell-side';
  tf: string;
}

/** Fractal pivots that price has not traded through since: stops are still resting behind them. */
function unsweptPivots(bars: Candle[], wing: number, tf: string): Pivot[] {
  const out: Pivot[] = [];
  const n = bars.length;
  const sufMax = new Float64Array(n + 1).fill(-Infinity);
  const sufMin = new Float64Array(n + 1).fill(Infinity);
  for (let i = n - 1; i >= 0; i--) {
    sufMax[i] = Math.max(sufMax[i + 1], bars[i].h);
    sufMin[i] = Math.min(sufMin[i + 1], bars[i].l);
  }
  for (let i = wing; i < n - wing; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - wing; j <= i + wing; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
    }
    if (isHigh && sufMax[i + 1] < bars[i].h) out.push({ price: bars[i].h, t: bars[i].t, side: 'buy-side', tf });
    if (isLow && sufMin[i + 1] > bars[i].l) out.push({ price: bars[i].l, t: bars[i].t, side: 'sell-side', tf });
  }
  return out;
}

function swingPools(pivots: Pivot[], price: number, now: number): LiquidityLevel[] {
  const levels: LiquidityLevel[] = [];
  for (const side of ['buy-side', 'sell-side'] as const) {
    const ps = pivots
      .filter((p) => p.side === side && (side === 'buy-side' ? p.price > price : p.price < price))
      .sort((a, b) => a.price - b.price);
    // Merge near-equal highs / lows (within 0.4%) into one pool: "equal highs" attract more stops.
    const groups: Pivot[][] = [];
    for (const p of ps) {
      const g = groups[groups.length - 1];
      if (g && p.price / g[0].price - 1 < 0.004) g.push(p);
      else groups.push([p]);
    }
    for (const g of groups) {
      const extreme = side === 'buy-side' ? Math.max(...g.map((p) => p.price)) : Math.min(...g.map((p) => p.price));
      const oldest = Math.min(...g.map((p) => p.t));
      const ageDays = Math.max(1, (now - oldest) / 86_400);
      const hasDaily = g.some((p) => p.tf === '1D');
      const score = g.length * Math.log(1 + ageDays) * (hasDaily ? 1.5 : 1);
      const distancePct = (extreme / price - 1) * 100;
      if (Math.abs(distancePct) > 35) continue;
      levels.push({
        price: extreme,
        distancePct,
        side,
        kind: 'swing',
        strength: score,
        notionalUsd: null,
        label: `${g.length > 1 ? `${g.length} equal ` : ''}${side === 'buy-side' ? 'swing high' : 'swing low'}${g.length > 1 ? 's' : ''}`,
        detail: `${hasDaily ? 'Daily' : '4h'} pivot, untouched for ${ageDays.toFixed(0)} days`,
      });
    }
  }
  const max = Math.max(1e-9, ...levels.map((l) => l.strength));
  for (const l of levels) l.strength /= max;
  const pick = (side: LiquidityLevel['side']) =>
    levels
      .filter((l) => l.side === side)
      .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
      .slice(0, 8);
  return [...pick('buy-side'), ...pick('sell-side')];
}

// ───────────────────────── estimated liquidation clusters ─────────────────────────

/** Assumed share of newly opened leverage by tier. A modelling assumption, not exchange data. */
const LEVERAGE_MIX: [lev: number, share: number][] = [
  [5, 0.15],
  [10, 0.3],
  [25, 0.3],
  [50, 0.17],
  [100, 0.08],
];
const MAINT_MARGIN = 0.005;
const LIQ_BUCKET_PCT = 0.5;
const LIQ_RANGE_PCT = 25;

function estimateLiquidations(hourly: Candle[], oi: { t: number; usd: number }[], price: number) {
  const n = hourly.length;
  const nb = Math.round((2 * LIQ_RANGE_PCT) / LIQ_BUCKET_PCT);
  const longUsd = new Float64Array(nb);
  const shortUsd = new Float64Array(nb);
  if (n < 48) return { profile: [], levels: [] as LiquidityLevel[], skew: null as number | null };

  // New positions per hour: positive open-interest change where we have it; otherwise volume scaled
  // by the observed OI-growth-per-dollar-traded ratio.
  const oiAt = new Map(oi.map((r) => [Math.floor(r.t / 3600) * 3600, r.usd]));
  const opened = new Float64Array(n).fill(NaN);
  let sumOpened = 0;
  let sumVol = 0;
  for (let i = 1; i < n; i++) {
    const a = oiAt.get(hourly[i].t);
    const b = oiAt.get(hourly[i].t + 3600);
    if (a != null && b != null) {
      opened[i] = Math.max(0, b - a);
      sumOpened += opened[i];
      sumVol += hourly[i].v * hourly[i].c;
    }
  }
  const ratio = sumVol > 0 ? sumOpened / sumVol : 0.05;
  for (let i = 0; i < n; i++) if (Number.isNaN(opened[i])) opened[i] = hourly[i].v * hourly[i].c * ratio;

  const sufMax = new Float64Array(n + 1).fill(-Infinity);
  const sufMin = new Float64Array(n + 1).fill(Infinity);
  for (let i = n - 1; i >= 0; i--) {
    sufMax[i] = Math.max(sufMax[i + 1], hourly[i].h);
    sufMin[i] = Math.min(sufMin[i + 1], hourly[i].l);
  }
  const idx = (p: number) => Math.floor(((p / price - 1) * 100 + LIQ_RANGE_PCT) / LIQ_BUCKET_PCT);
  const lastT = hourly[n - 1].t;
  for (let i = 0; i < n; i++) {
    const entry = (hourly[i].h + hourly[i].l + hourly[i].c) / 3;
    // Positions get closed over time: assume a 10-day half life.
    const alive = Math.pow(0.5, (lastT - hourly[i].t) / (10 * 86_400));
    const usd = opened[i] * alive * 0.5;
    for (const [lev, share] of LEVERAGE_MIX) {
      const longLiq = entry * (1 - 1 / lev + MAINT_MARGIN);
      const shortLiq = entry * (1 + 1 / lev - MAINT_MARGIN);
      // Skip levels price has already traded through since - those positions are gone.
      if (sufMin[i + 1] > longLiq) {
        const k = idx(longLiq);
        if (k >= 0 && k < nb) longUsd[k] += usd * share;
      }
      if (sufMax[i + 1] < shortLiq) {
        const k = idx(shortLiq);
        if (k >= 0 && k < nb) shortUsd[k] += usd * share;
      }
    }
  }

  const profile = Array.from({ length: nb }, (_, k) => {
    const distancePct = -LIQ_RANGE_PCT + (k + 0.5) * LIQ_BUCKET_PCT;
    return { price: price * (1 + distancePct / 100), distancePct, longUsd: longUsd[k], shortUsd: shortUsd[k] };
  });

  // Clusters = local maxima of the 3-bucket smoothed profile.
  const levels: LiquidityLevel[] = [];
  for (const side of ['short', 'long'] as const) {
    const arr = side === 'short' ? shortUsd : longUsd;
    const smooth = (k: number) => (arr[k - 1] ?? 0) + arr[k] + (arr[k + 1] ?? 0);
    const peaks: { k: number; usd: number }[] = [];
    for (let k = 1; k < nb - 1; k++) {
      const s = smooth(k);
      if (s > 0 && s >= smooth(k - 1) && s > smooth(k + 1)) peaks.push({ k, usd: s });
    }
    peaks.sort((a, b) => b.usd - a.usd);
    const top = peaks.slice(0, 5);
    const max = top[0]?.usd ?? 1;
    for (const p of top) {
      const b = profile[p.k];
      levels.push({
        price: b.price,
        distancePct: b.distancePct,
        side: side === 'short' ? 'buy-side' : 'sell-side',
        kind: 'liquidation',
        strength: p.usd / max,
        notionalUsd: p.usd,
        label: side === 'short' ? 'Short liquidations' : 'Long liquidations',
        detail: 'Estimated from Binance open-interest growth and an assumed leverage mix',
      });
    }
  }
  const above = profile.reduce((s, b) => (Math.abs(b.distancePct) <= 15 ? s + b.shortUsd : s), 0);
  const below = profile.reduce((s, b) => (Math.abs(b.distancePct) <= 15 ? s + b.longUsd : s), 0);
  return { profile, levels, skew: above + below > 0 ? above / (above + below) : null };
}

// ───────────────────────── report ─────────────────────────

const loadMarket = ttlCache(45_000, async () => {
  const [books, h4, h1, oi] = await Promise.all([
    fetchBooks(),
    fetchKlines('4h').catch(() => [] as Candle[]),
    fetchKlines('1h').catch(() => [] as Candle[]),
    fetchJson<{ sumOpenInterestValue: string; timestamp: number }[]>(
      `${BINANCE_FUTURES}/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=500`,
    )
      .then((rows) => rows.map((r) => ({ t: Math.floor(r.timestamp / 1000), usd: +r.sumOpenInterestValue })))
      .catch(() => [] as { t: number; usd: number }[]),
  ]);
  return { books, h4, h1, oi };
});

export async function liquidityReport(ds: Dataset): Promise<LiquidityReport> {
  const { books, h4, h1, oi } = await loadMarket();
  const notes: string[] = [];
  const lastClose = ds.c[ds.n - 1];

  // Mid price from the best bid/ask of the first venue that answered, else the last close.
  let price = h1.length ? h1[h1.length - 1].c : lastClose;
  const ref = books[0];
  if (ref?.bids.length && ref.asks.length) {
    const bestBid = Math.max(...ref.bids.slice(0, 50).map((b) => b[0]));
    const bestAsk = Math.min(...ref.asks.slice(0, 50).map((a) => a[0]));
    if (bestAsk > bestBid) price = (bestBid + bestAsk) / 2;
  }

  const book = analyseBooks(books, price);
  if (books.length === 0) notes.push('No order book venue answered; depth is unavailable right now.');
  else if (books.length < 4) notes.push(`Order book built from ${books.length} of 4 venues.`);
  notes.push(
    'Beyond roughly ±1.5% the combined book is mostly Coinbase and Bitstamp (the venues that publish their full book), so far-away walls understate global depth.',
  );

  const daily: Candle[] = [];
  for (let i = Math.max(0, ds.n - 400); i < ds.n; i++) {
    daily.push({ t: ds.t[i], o: ds.o[i], h: ds.h[i], l: ds.l[i], c: ds.c[i], v: ds.v[i] });
  }
  const pivots = [...unsweptPivots(daily, 5, '1D'), ...unsweptPivots(h4, 6, '4h')];
  const swings = swingPools(pivots, price, Math.floor(Date.now() / 1000));

  const liq = estimateLiquidations(h1, oi, price);
  if (h1.length === 0) notes.push('Hourly candles unavailable; liquidation estimate skipped.');
  else {
    notes.push(
      'Liquidation clusters are a model estimate (Binance open-interest growth × assumed leverage mix), not exchange-reported positions.',
    );
  }

  const all = [...swings, ...liq.levels, ...book.walls];
  const nearest = (side: LiquidityLevel['side']) =>
    all
      .filter((l) => l.side === side && l.strength >= 0.35 && Math.abs(l.distancePct) >= 0.5)
      .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))[0] ?? null;

  return {
    at: Date.now(),
    price,
    swings,
    liquidations: liq.levels,
    walls: book.walls,
    depth: book.depth,
    liqProfile: liq.profile,
    summary: {
      bidDepthUsd: book.bidDepthUsd,
      askDepthUsd: book.askDepthUsd,
      bookImbalance2Pct: book.bookImbalance2Pct,
      nearestAbove: nearest('buy-side'),
      nearestBelow: nearest('sell-side'),
      liqSkewAbove: liq.skew,
      venues: books.map((b) => b.venue),
      notes,
    },
  };
}
