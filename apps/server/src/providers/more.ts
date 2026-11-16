import type { Candle } from '@smart-btc/shared';
import { fetchJson, fetchText } from '../lib/http.js';
import type { Point } from '../store/store.js';
import { DAY_SEC, HOUR, daily, dayStart, type Provider } from './types.js';

const DAY_MS = DAY_SEC * 1000;

// ───────────────────────── Coinbase ─────────────────────────

/** [time, low, high, open, close, volume], newest first, at most 300 rows a request. */
type CoinbaseCandle = [number, number, number, number, number, number];

/**
 * BTC/USD on the largest US exchange. A second full price history to check the others against, and the
 * dollar side of the Coinbase premium.
 */
export const coinbase: Provider = {
  id: 'coinbase',
  name: 'Coinbase',
  url: 'https://www.coinbase.com',
  provides: 'BTC/USD daily candles since 2015 (price cross-check and Coinbase premium)',
  candles: [{ source: 'coinbase', interval: '1d', barSec: DAY_SEC }],
  intervalMs: HOUR,
  async sync(store) {
    const last = await store.lastCandleT('coinbase', '1d');
    let start = last != null ? (last - 2 * DAY_SEC) * 1000 : Date.UTC(2015, 6, 20);
    const stop = Date.now();
    let written = 0;
    for (let page = 0; page < 40 && start < stop; page++) {
      const end = Math.min(stop, start + 299 * DAY_MS);
      const rows = await fetchJson<CoinbaseCandle[]>(
        `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`,
      );
      const candles: Candle[] = rows.map((r) => ({ t: r[0], l: r[1], h: r[2], o: r[3], c: r[4], v: r[5] }));
      written += await store.upsertCandles('coinbase', '1d', candles);
      start = end + DAY_MS;
    }
    return written;
  },
};

// ───────────────────────── Kraken ─────────────────────────

/** [time, open, high, low, close, vwap, volume, count] */
type KrakenCandle = [number, string, string, string, string, string, string, number];

/** Kraken serves the last 720 daily candles only: enough to cross-check the other exchanges and to fill in if they fall behind. */
export const kraken: Provider = {
  id: 'kraken',
  name: 'Kraken',
  url: 'https://www.kraken.com',
  provides: 'BTC/USD daily candles for the last two years (price cross-check)',
  candles: [{ source: 'kraken', interval: '1d', barSec: DAY_SEC }],
  intervalMs: HOUR,
  async sync(store) {
    const last = await store.lastCandleT('kraken', '1d');
    const since = last != null ? `&since=${last - 3 * DAY_SEC}` : '';
    const res = await fetchJson<{ error: string[]; result?: Record<string, KrakenCandle[] | number> }>(
      `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440${since}`,
    );
    if (res.error?.length) throw new Error(`Kraken: ${res.error.join(', ')}`);
    const rows = Object.entries(res.result ?? {}).find(([k, v]) => k !== 'last' && Array.isArray(v))?.[1] as KrakenCandle[] | undefined;
    if (!rows) return 0;
    return store.upsertCandles('kraken', '1d', rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] })));
  },
};

// ───────────────────────── OKX ─────────────────────────

interface OkxFunding {
  code: string;
  msg?: string;
  data: { fundingRate: string; realizedRate?: string; fundingTime: string }[];
}

/** A third venue's funding rate, so a broken funding feed can be told apart from a real move. OKX keeps about three months. */
export const okx: Provider = {
  id: 'okx',
  name: 'OKX',
  url: 'https://www.okx.com',
  provides: 'BTC-USDT perpetual funding rate (last three months, then accumulated locally)',
  series: [{ id: 'okx.funding', everySec: 8 * 3600, mayRepeat: true, additive: true }],
  intervalMs: 2 * HOUR,
  async sync(store) {
    const last = await store.lastPointT('okx.funding');
    let after = '';
    let written = 0;
    // Newest first, 100 a page; `after` asks for settlements older than a timestamp.
    for (let page = 0; page < 12; page++) {
      const res = await fetchJson<OkxFunding>(`https://www.okx.com/api/v5/public/funding-rate-history?instId=BTC-USDT-SWAP&limit=100${after}`);
      if (res.code !== '0') throw new Error(`OKX: ${res.msg || res.code}`);
      if (!res.data.length) break;
      written += await store.upsertPoints('okx.funding', res.data.map((r) => ({ t: Math.floor(+r.fundingTime / 1000), v: +(r.realizedRate || r.fundingRate) })));
      const oldest = Math.min(...res.data.map((r) => +r.fundingTime));
      if (res.data.length < 100 || (last != null && oldest <= last * 1000)) break;
      after = `&after=${oldest}`;
    }
    return written;
  },
};

// ───────────────────────── Blockchain.com ─────────────────────────

interface BcChart {
  values: { x: number; y: number }[];
}
const BC_CHARTS = [
  { chart: 'hash-rate', series: 'bc.hashrate' },
  { chart: 'n-transactions', series: 'bc.txCnt' },
];

/** An independent reading of the chain itself: checks Coin Metrics and stands in for it when it is off. */
export const blockchainCom: Provider = {
  id: 'blockchain-com',
  name: 'Blockchain.com',
  url: 'https://www.blockchain.com/explorer/charts',
  provides: 'Network hash rate and daily transaction count since 2009 (on-chain cross-check)',
  series: BC_CHARTS.map((c) => daily(c.series, { positive: true })),
  intervalMs: 6 * HOUR,
  async sync(store) {
    let written = 0;
    for (const { chart, series } of BC_CHARTS) {
      const span = (await store.lastPointT(series)) != null ? '60days' : 'all';
      const res = await fetchJson<BcChart>(`https://api.blockchain.info/charts/${chart}?timespan=${span}&format=json&sampled=false`, { timeoutMs: 45_000 });
      written += await store.upsertPoints(series, res.values.filter((v) => v.y > 0).map((v) => ({ t: dayStart(v.x), v: v.y })));
    }
    return written;
  },
};

// ───────────────────────── mempool.space ─────────────────────────

/** Hash rate estimated from block times by the open-source mempool project, in TH/s like the other two. */
export const mempool: Provider = {
  id: 'mempool',
  name: 'mempool.space',
  url: 'https://mempool.space/mining',
  provides: 'Network hash rate since 2009 (third estimate for the hash-rate cross-check)',
  series: [daily('mp.hashrate', { positive: true })],
  intervalMs: 6 * HOUR,
  async sync(store) {
    const span = (await store.lastPointT('mp.hashrate')) != null ? '3m' : 'all';
    const res = await fetchJson<{ hashrates: { timestamp: number; avgHashrate: number }[] }>(`https://mempool.space/api/v1/mining/hashrate/${span}`, { timeoutMs: 45_000 });
    const pts: Point[] = res.hashrates.filter((h) => h.avgHashrate > 0).map((h) => ({ t: dayStart(h.timestamp), v: h.avgHashrate / 1e12 }));
    return store.upsertPoints('mp.hashrate', pts);
  },
};

// ───────────────────────── FRED (Federal Reserve Bank of St. Louis) ─────────────────────────

/**
 * `usd` converts the feed's unit to US dollars. Weekly figures describe a Wednesday and come out the
 * next day, so they are stored on the day they were published: a backtest never sees them early.
 */
const FRED = [
  { id: 'WALCL', series: 'fred.walcl', usd: 1e6, publishedAfterDays: 1, weekly: true },
  { id: 'WDTGAL', series: 'fred.tga', usd: 1e6, publishedAfterDays: 1, weekly: true },
  { id: 'RRPONTSYD', series: 'fred.rrp', usd: 1e9, publishedAfterDays: 0, weekly: false },
  { id: 'DGS10', series: 'fred.us10y', usd: 1, publishedAfterDays: 0, weekly: false },
];

export function parseFredCsv(csv: string): Point[] {
  const out: Point[] = [];
  for (const line of csv.trim().split('\n').slice(1)) {
    const [date, raw] = line.split(',');
    const t = Date.parse(`${date}T00:00:00Z`) / 1000;
    const v = Number(raw);
    // Days without a figure (holidays) are an empty cell or a dot.
    if (Number.isFinite(t) && raw != null && raw.trim() !== '' && raw.trim() !== '.' && Number.isFinite(v)) out.push({ t, v });
  }
  return out;
}

export const fred: Provider = {
  id: 'fred',
  name: 'FRED (St. Louis Fed)',
  url: 'https://fred.stlouisfed.org',
  provides: 'Fed balance sheet, Treasury account and reverse repo (net dollar liquidity), 10-year yield cross-check',
  series: FRED.map((f) =>
    f.weekly
      ? { id: f.series, everySec: 7 * DAY_SEC, maxAgeSec: 12 * DAY_SEC, positive: true }
      : daily(f.series, { duty: 0.66, maxAgeSec: 6 * DAY_SEC, mayRepeat: f.id === 'RRPONTSYD', maySpike: f.id === 'RRPONTSYD', additive: true }),
  ),
  intervalMs: 6 * HOUR,
  async sync(store) {
    let written = 0;
    for (const f of FRED) {
      const last = await store.lastPointT(f.series);
      const from = last != null ? new Date((last - 30 * DAY_SEC) * 1000).toISOString().slice(0, 10) : '2010-01-01';
      const csv = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${f.id}&cosd=${from}`, { timeoutMs: 45_000 });
      const pts = parseFredCsv(csv).map((p) => ({ t: p.t + f.publishedAfterDays * DAY_SEC, v: p.v * f.usd }));
      written += await store.upsertPoints(f.series, pts);
    }
    return written;
  },
};
