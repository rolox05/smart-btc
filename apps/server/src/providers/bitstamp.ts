import type { Candle } from '@smart-btc/shared';
import { fetchJson } from '../lib/http.js';
import { HOUR, type Provider } from './types.js';

interface OhlcResponse {
  data: { ohlc: { timestamp: string; open: string; high: string; low: string; close: string; volume: string }[] };
}

const FIRST_DAY = 1313625600; // 2011-08-18

export const bitstamp: Provider = {
  id: 'bitstamp',
  name: 'Bitstamp',
  url: 'https://www.bitstamp.net/api/',
  provides: 'BTC/USD daily candles since 2011 (long history, fallback price feed)',
  intervalMs: 6 * HOUR,
  async sync(store) {
    const last = await store.lastCandleT('bitstamp', '1d');
    let start = last != null ? last - 2 * 86_400 : FIRST_DAY;
    let written = 0;
    for (let page = 0; page < 12; page++) {
      const res = await fetchJson<OhlcResponse>(
        `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&start=${start}`,
      );
      const candles: Candle[] = res.data.ohlc.map((r) => ({
        t: +r.timestamp,
        o: +r.open,
        h: +r.high,
        l: +r.low,
        c: +r.close,
        v: +r.volume,
      }));
      if (candles.length === 0) break;
      written += await store.upsertCandles('bitstamp', '1d', candles);
      const next = candles[candles.length - 1].t + 86_400;
      if (candles.length < 2 || next <= start || next > Date.now() / 1000) break;
      start = next;
    }
    return written;
  },
};
