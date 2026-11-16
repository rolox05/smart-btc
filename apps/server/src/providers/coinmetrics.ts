import { fetchJson } from '../lib/http.js';
import type { Point } from '../store/store.js';
import { HOUR, daily, type Provider } from './types.js';

/** Metrics available on the free community tier, mapped to local series ids. */
const METRICS: Record<string, string> = {
  PriceUSD: 'cm.price',
  CapMVRVCur: 'cm.mvrv',
  CapMrktCurUSD: 'cm.mcap',
  SplyCur: 'cm.supply',
  AdrActCnt: 'cm.activeAddr',
  HashRate: 'cm.hashrate',
  FlowInExUSD: 'cm.flowIn',
  FlowOutExUSD: 'cm.flowOut',
  IssTotUSD: 'cm.issUsd',
  SplyExNtv: 'cm.exSupply',
  TxCnt: 'cm.txCnt',
  FeeTotNtv: 'cm.feesBtc',
};

interface CmResponse {
  data: Record<string, string>[];
  next_page_url?: string;
}

export const coinmetrics: Provider = {
  id: 'coinmetrics',
  name: 'Coin Metrics Community',
  url: 'https://community-api.coinmetrics.io',
  provides: 'MVRV / realized price, market cap, supply, exchange flows and balances, issuance, fees, transactions, hash rate since 2010',
  series: Object.values(METRICS).map((id) => daily(id, { positive: true })),
  intervalMs: 6 * HOUR,
  async sync(store) {
    // Start from the series that is furthest behind, so fields added later get their full history.
    const lasts = await Promise.all(Object.values(METRICS).map((s) => store.lastPointT(s)));
    const last = lasts.some((l) => l == null) ? null : Math.min(...(lasts as number[]));
    // Recent days are revised upstream ("flash" status), so overlap by a week.
    const startDay = last != null ? new Date((last - 7 * 86_400) * 1000).toISOString().slice(0, 10) : '2010-07-18';
    let url: string | undefined =
      'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc' +
      `&metrics=${Object.keys(METRICS).join(',')}&frequency=1d&page_size=10000&start_time=${startDay}`;
    const buckets: Record<string, Point[]> = {};
    for (let page = 0; page < 10 && url; page++) {
      const res: CmResponse = await fetchJson<CmResponse>(url, { timeoutMs: 45_000 });
      for (const row of res.data) {
        const t = Date.parse(`${row.time.slice(0, 10)}T00:00:00Z`) / 1000;
        for (const [metric, series] of Object.entries(METRICS)) {
          const raw = row[metric];
          if (raw == null) continue;
          (buckets[series] ??= []).push({ t, v: +raw });
        }
      }
      url = res.next_page_url;
    }
    let written = 0;
    for (const [series, pts] of Object.entries(buckets)) written += await store.upsertPoints(series, pts);
    return written;
  },
};
