import type { Candle } from '@smart-btc/shared';
import { fetchJson, fetchJsonAny } from '../lib/http.js';
import type { Point } from '../store/store.js';
import { DAY_SEC, MINUTE, daily, type Provider } from './types.js';

/** api.binance.com is geo-blocked in some countries; data-api.binance.vision is the public mirror. */
export const BINANCE_SPOT_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];
export const BINANCE_FUTURES = 'https://fapi.binance.com';

type Kline = [number, string, string, string, string, string, ...unknown[]];

export async function fetchKlines(interval: string, startMs?: number, limit = 1000): Promise<Candle[]> {
  const qs = `symbol=BTCUSDT&interval=${interval}&limit=${limit}${startMs != null ? `&startTime=${startMs}` : ''}`;
  const rows = await fetchJsonAny<Kline[]>(BINANCE_SPOT_HOSTS.map((h) => `${h}/api/v3/klines?${qs}`));
  return rows.map((k) => ({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

export const binanceSpot: Provider = {
  id: 'binance-spot',
  name: 'Binance spot',
  url: 'https://api.binance.com',
  provides: 'BTC/USDT daily candles since 2017, live price',
  candles: [{ source: 'binance', interval: '1d', barSec: DAY_SEC }],
  intervalMs: 3 * MINUTE,
  async sync(store) {
    const last = await store.lastCandleT('binance', '1d');
    // Re-fetch the last two days so the still-open daily candle keeps updating.
    let start = last != null ? (last - 2 * 86_400) * 1000 : Date.UTC(2017, 7, 17);
    let written = 0;
    for (let page = 0; page < 12; page++) {
      const candles = await fetchKlines('1d', start);
      if (candles.length === 0) break;
      written += await store.upsertCandles('binance', '1d', candles);
      if (candles.length < 1000) break;
      start = (candles[candles.length - 1].t + 86_400) * 1000;
    }
    return written;
  },
};

/**
 * Intraday candles. One provider per interval so they download in parallel and report separately.
 * The first sync pages forward from `historyStart`; later syncs only fetch the newest bars.
 */
function intradayProvider(interval: '15m' | '1h' | '4h', barSec: number, historyStartMs: () => number, span: string): Provider {
  return {
    id: `binance-${interval}`,
    name: `Binance ${interval} candles`,
    url: 'https://api.binance.com',
    provides: 'BTC/USDT {interval} candles ({span}) for the {interval} timeframe',
    providesVars: { interval, span },
    candles: [{ source: 'binance', interval, barSec }],
    intervalMs: 2 * MINUTE,
    async sync(store) {
      const last = await store.lastCandleT('binance', interval);
      let start = last != null ? (last - 2 * barSec) * 1000 : historyStartMs();
      let written = 0;
      for (let page = 0; page < 400; page++) {
        const candles = await fetchKlines(interval, start);
        if (candles.length === 0) break;
        written += await store.upsertCandles('binance', interval, candles);
        if (candles.length < 1000) break;
        start = (candles[candles.length - 1].t + barSec) * 1000;
      }
      return written;
    },
  };
}

const LISTING = () => Date.UTC(2017, 7, 17);
export const binance4h = intradayProvider('4h', 14_400, LISTING, 'since 2017');
export const binance1h = intradayProvider('1h', 3600, LISTING, 'since 2017');
// Three years of 15-minute bars is ~105,000 candles: plenty of analogs without a long first download.
export const binance15m = intradayProvider('15m', 900, () => Date.now() - 3 * 365 * 86_400_000, 'last 3 years');

interface FundingRow {
  fundingTime: number;
  fundingRate: string;
}
interface OiRow {
  sumOpenInterestValue: string;
  timestamp: number;
}
interface LsRow {
  longShortRatio: string;
  timestamp: number;
}

export const binanceFutures: Provider = {
  id: 'binance-futures',
  name: 'Binance USD-M futures',
  url: 'https://fapi.binance.com',
  provides: 'Perp funding rate since 2019, open interest and long/short ratio (30-day window, accumulated locally)',
  series: [
    { id: 'binance.funding', everySec: 8 * 3600, mayRepeat: true, additive: true },
    daily('binance.oi', { positive: true }),
    daily('binance.lsRatio', { positive: true }),
  ],
  intervalMs: 30 * MINUTE,
  async sync(store) {
    let written = 0;

    // Funding: one row per 8h settlement, paged forward from the last stored one.
    const lastFunding = await store.lastPointT('binance.funding');
    let start = lastFunding != null ? (lastFunding + 1) * 1000 : Date.UTC(2019, 8, 8);
    for (let page = 0; page < 20; page++) {
      const rows = await fetchJson<FundingRow[]>(
        `${BINANCE_FUTURES}/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=${start}&limit=1000`,
      );
      if (rows.length === 0) break;
      const pts: Point[] = rows.map((r) => ({ t: Math.floor(r.fundingTime / 1000), v: +r.fundingRate }));
      written += await store.upsertPoints('binance.funding', pts);
      if (rows.length < 1000) break;
      start = rows[rows.length - 1].fundingTime + 1;
    }

    // Binance only serves the last 30 days of these; keeping them in the store builds history over time.
    const oi = await fetchJson<OiRow[]>(
      `${BINANCE_FUTURES}/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=500`,
    );
    written += await store.upsertPoints(
      'binance.oi',
      oi.map((r) => ({ t: Math.floor(r.timestamp / 1000), v: +r.sumOpenInterestValue })),
    );
    const ls = await fetchJson<LsRow[]>(
      `${BINANCE_FUTURES}/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1d&limit=500`,
    );
    written += await store.upsertPoints(
      'binance.lsRatio',
      ls.map((r) => ({ t: Math.floor(r.timestamp / 1000), v: +r.longShortRatio })),
    );
    return written;
  },
};

