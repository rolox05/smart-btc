import { fetchJson } from '../lib/http.js';
import type { Point } from '../store/store.js';
import { HOUR, type Provider } from './types.js';

/**
 * bitcoin-data.com (BGeometrics) free tier: 10 requests/hour, 15/day, values delayed by 7 days.
 * We therefore pull the two short-term-holder series at most once a day and carry the last value forward.
 */
const ENDPOINTS: { path: string; series: string }[] = [
  { path: 'sth-realized-price', series: 'bg.sthRealizedPrice' },
  { path: 'sth-sopr', series: 'bg.sthSopr' },
];

type Row = Record<string, string | number | boolean | null>;
const META_KEYS = new Set(['d', 'unixTs', 'delayed', 'message']);

export const bgeometrics: Provider = {
  id: 'bgeometrics',
  name: 'BGeometrics (bitcoin-data.com)',
  url: 'https://bitcoin-data.com',
  provides: 'Short-term holder realized price and STH-SOPR (free tier is delayed 7 days)',
  intervalMs: 24 * HOUR,
  async sync(store) {
    let written = 0;
    for (const { path, series } of ENDPOINTS) {
      const last = await store.lastPointT(series);
      const qs = last != null ? `?startday=${new Date((last - 3 * 86_400) * 1000).toISOString().slice(0, 10)}` : '';
      const res = await fetchJson<Row[] | Row>(`https://bitcoin-data.com/v1/${path}${qs}`, {
        timeoutMs: 60_000,
        retries: 0, // every attempt counts against a very small quota
      });
      const rows = Array.isArray(res) ? res : [res];
      const pts: Point[] = [];
      for (const row of rows) {
        const valueKey = Object.keys(row).find((k) => !META_KEYS.has(k));
        if (!valueKey || row[valueKey] == null) continue;
        const t = row.unixTs != null ? Number(row.unixTs) : Date.parse(`${row.d}T00:00:00Z`) / 1000;
        pts.push({ t: Math.floor(t / 86_400) * 86_400, v: Number(row[valueKey]) });
      }
      written += await store.upsertPoints(series, pts);
    }
    return written;
  },
};
