import { fetchJson } from '../lib/http.js';
import type { Point } from '../store/store.js';
import { HOUR, daily, dayStart, type Provider } from './types.js';

export const fearGreed: Provider = {
  id: 'alternative-me',
  name: 'alternative.me',
  url: 'https://alternative.me/crypto/fear-and-greed-index/',
  provides: 'Crypto Fear & Greed index since 2018',
  series: [daily('fng', { positive: true, mayRepeat: true })],
  intervalMs: 6 * HOUR,
  async sync(store) {
    const res = await fetchJson<{ data: { value: string; timestamp: string }[] }>(
      'https://api.alternative.me/fng/?limit=0',
    );
    const pts: Point[] = res.data.map((r) => ({ t: dayStart(+r.timestamp), v: +r.value }));
    return store.upsertPoints('fng', pts);
  },
};

interface DvolResponse {
  result: { data: [number, number, number, number, number][]; continuation: number | null };
}

export const deribit: Provider = {
  id: 'deribit',
  name: 'Deribit',
  url: 'https://www.deribit.com',
  provides: 'DVOL 30-day implied volatility index since 2021',
  series: [daily('deribit.dvol', { positive: true })],
  intervalMs: 2 * HOUR,
  async sync(store) {
    const last = await store.lastPointT('deribit.dvol');
    const startMs = last != null ? (last - 2 * 86_400) * 1000 : Date.UTC(2021, 0, 1);
    let endMs = Date.now();
    let written = 0;
    // The API returns the newest 1000 rows first and a continuation cursor for older ones.
    for (let page = 0; page < 10; page++) {
      const res = await fetchJson<DvolResponse>(
        'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC' +
          `&start_timestamp=${startMs}&end_timestamp=${endMs}&resolution=1D`,
      );
      const pts: Point[] = res.result.data.map((r) => ({ t: dayStart(r[0] / 1000), v: r[4] }));
      written += await store.upsertPoints('deribit.dvol', pts);
      const cont = res.result.continuation;
      if (!cont || cont <= startMs || pts.length === 0) break;
      endMs = cont;
    }
    return written;
  },
};

export const defillama: Provider = {
  id: 'defillama',
  name: 'DefiLlama stablecoins',
  url: 'https://stablecoins.llama.fi',
  provides: 'Total USD stablecoin supply since 2017 (dry-powder proxy)',
  series: [daily('llama.stables', { positive: true })],
  intervalMs: 12 * HOUR,
  async sync(store) {
    const res = await fetchJson<{ date: string; totalCirculatingUSD?: { peggedUSD?: number } }[]>(
      'https://stablecoins.llama.fi/stablecoincharts/all',
      { timeoutMs: 45_000 },
    );
    const pts: Point[] = [];
    for (const r of res) {
      const v = r.totalCirculatingUSD?.peggedUSD;
      if (v != null && v > 0) pts.push({ t: dayStart(+r.date), v });
    }
    return store.upsertPoints('llama.stables', pts);
  },
};
