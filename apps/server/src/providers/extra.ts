import { fetchJson } from '../lib/http.js';
import type { Point } from '../store/store.js';
import { BINANCE_FUTURES } from './binance.js';
import { HOUR, MINUTE, dayStart, type Provider } from './types.js';

const DAY_MS = 86_400_000;

// ───────────────────────── Bybit ─────────────────────────

interface BybitOi {
  result: { list: { openInterest: string; timestamp: string }[]; nextPageCursor?: string };
}
interface BybitRatio {
  result: { list: { buyRatio: string; sellRatio: string; timestamp: string }[] };
}

/**
 * Bybit keeps daily open-interest and long/short account-ratio history back to 2020,
 * where Binance only serves 30 days. Open interest is in BTC (contracts on the USDT perpetual).
 */
export const bybit: Provider = {
  id: 'bybit',
  name: 'Bybit',
  url: 'https://api.bybit.com',
  provides: 'BTCUSDT perpetual open interest and long/short account ratio, daily since 2020',
  intervalMs: 30 * MINUTE,
  async sync(store) {
    let written = 0;

    // Open interest: cursor pages run backwards from now; stop once we reach what is already stored.
    const lastOi = await store.lastPointT('bybit.oi');
    let cursor = '';
    for (let page = 0; page < 30; page++) {
      const res: BybitOi = await fetchJson<BybitOi>(
        `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=1d&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      const rows = res.result.list;
      if (!rows.length) break;
      const pts: Point[] = rows.map((r) => ({ t: dayStart(+r.timestamp / 1000), v: +r.openInterest }));
      written += await store.upsertPoints('bybit.oi', pts);
      const oldest = Math.min(...pts.map((p) => p.t));
      if (lastOi != null && oldest <= lastOi - 2 * 86_400) break;
      cursor = res.result.nextPageCursor ?? '';
      if (!cursor) break;
    }

    // Account ratio: windows of up to 500 days, from the last stored day (or Aug 2020) to now.
    const lastLs = await store.lastPointT('bybit.lsRatio');
    let start = lastLs != null ? (lastLs - 2 * 86_400) * 1000 : Date.UTC(2020, 6, 1);
    // Fixed end point: comparing with Date.now() on each pass would chase the clock forever.
    const stop = Date.now();
    while (start < stop) {
      const end = Math.min(stop, start + 499 * DAY_MS);
      const res = await fetchJson<BybitRatio>(
        `https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=BTCUSDT&period=1d&limit=500&startTime=${start}&endTime=${end}`,
      );
      const pts: Point[] = res.result.list
        .filter((r) => +r.sellRatio > 0)
        .map((r) => ({ t: dayStart(+r.timestamp / 1000), v: +r.buyRatio / +r.sellRatio }));
      written += await store.upsertPoints('bybit.lsRatio', pts);
      start = end + 1;
    }
    return written;
  },
};

// ───────────────────────── Binance premium index ─────────────────────────

type Kline = [number, string, string, string, string, ...unknown[]];

export const binancePremium: Provider = {
  id: 'binance-premium',
  name: 'Binance premium index',
  url: 'https://fapi.binance.com',
  provides: 'Perpetual premium over spot (daily since Dec 2019)',
  intervalMs: HOUR,
  async sync(store) {
    const last = await store.lastPointT('binance.premium');
    let start = last != null ? (last - 2 * 86_400) * 1000 : Date.UTC(2019, 11, 1);
    let written = 0;
    for (let page = 0; page < 10; page++) {
      const rows = await fetchJson<Kline[]>(`${BINANCE_FUTURES}/fapi/v1/premiumIndexKlines?symbol=BTCUSDT&interval=1d&startTime=${start}&limit=1000`);
      if (!rows.length) break;
      written += await store.upsertPoints(
        'binance.premium',
        rows.map((k) => ({ t: dayStart(k[0] / 1000), v: +k[4] })),
      );
      if (rows.length < 1000) break;
      start = rows[rows.length - 1][0] + DAY_MS;
    }
    return written;
  },
};

// ───────────────────────── Yahoo Finance (macro) ─────────────────────────

/** Local series id → Yahoo symbol. `vol` stores daily dollar volume instead of the close. */
const YAHOO: { series: string; symbol: string; vol?: boolean }[] = [
  { series: 'yahoo.dxy', symbol: 'DX-Y.NYB' },
  { series: 'yahoo.us10y', symbol: '^TNX' },
  { series: 'yahoo.nasdaq', symbol: '^IXIC' },
  { series: 'yahoo.gold', symbol: 'GC=F' },
  { series: 'yahoo.ibitVol', symbol: 'IBIT', vol: true },
];

interface YahooChart {
  chart: { result: { timestamp?: number[]; indicators: { quote: { close: (number | null)[]; volume: (number | null)[] }[] } }[] | null };
}

export const yahoo: Provider = {
  id: 'yahoo',
  name: 'Yahoo Finance',
  url: 'https://finance.yahoo.com',
  provides: 'US dollar index, 10-year Treasury yield, Nasdaq, gold and IBIT spot-ETF volume (daily since 2010)',
  intervalMs: 3 * HOUR,
  async sync(store) {
    let written = 0;
    for (const { series, symbol, vol } of YAHOO) {
      const last = await store.lastPointT(series);
      const from = last != null ? last - 10 * 86_400 : Date.UTC(2010, 0, 1) / 1000;
      const res = await fetchJson<YahooChart>(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${Math.floor(from)}&period2=${Math.floor(Date.now() / 1000)}&interval=1d`,
      );
      const r = res.chart.result?.[0];
      if (!r?.timestamp) continue;
      const q = r.indicators.quote[0];
      const pts: Point[] = [];
      r.timestamp.forEach((ts, i) => {
        const c = q.close[i];
        if (c == null) return;
        const v = vol ? (q.volume[i] ?? NaN) * c : c;
        if (Number.isFinite(v)) pts.push({ t: dayStart(ts), v });
      });
      written += await store.upsertPoints(series, pts);
    }
    return written;
  },
};

// ───────────────────────── CFTC Commitments of Traders ─────────────────────────

interface TffRow {
  report_date_as_yyyy_mm_dd: string;
  open_interest_all: string;
  lev_money_positions_long: string;
  lev_money_positions_short: string;
  asset_mgr_positions_long: string;
  asset_mgr_positions_short: string;
}

/**
 * Traders in Financial Futures report for CME Bitcoin futures. Positions are as of Tuesday but
 * published on Friday, so each value is stored on the publication day to keep backtests honest.
 */
export const cftc: Provider = {
  id: 'cftc',
  name: 'CFTC Commitments of Traders',
  url: 'https://publicreporting.cftc.gov',
  provides: 'Weekly CME Bitcoin futures positioning of leveraged funds and asset managers since 2018',
  intervalMs: 12 * HOUR,
  async sync(store) {
    const rows = await fetchJson<TffRow[]>(
      'https://publicreporting.cftc.gov/resource/gpe5-46if.json?cftc_contract_market_code=133741&$order=report_date_as_yyyy_mm_dd%20ASC&$limit=5000',
      { timeoutMs: 45_000 },
    );
    const lev: Point[] = [];
    const asset: Point[] = [];
    for (const r of rows) {
      const oi = +r.open_interest_all;
      if (!(oi > 0)) continue;
      const t = dayStart(Date.parse(`${r.report_date_as_yyyy_mm_dd.slice(0, 10)}T00:00:00Z`) / 1000) + 3 * 86_400;
      lev.push({ t, v: ((+r.lev_money_positions_long - +r.lev_money_positions_short) / oi) * 100 });
      asset.push({ t, v: ((+r.asset_mgr_positions_long - +r.asset_mgr_positions_short) / oi) * 100 });
    }
    return (await store.upsertPoints('cftc.levNet', lev)) + (await store.upsertPoints('cftc.assetNet', asset));
  },
};

// ───────────────────────── Deribit options ─────────────────────────

interface BookSummary {
  result: { instrument_name: string; open_interest: number }[];
}

/** Put/call open-interest ratio across all BTC options. There is no free history: it builds up locally, one value per day. */
export const deribitOptions: Provider = {
  id: 'deribit-options',
  name: 'Deribit options',
  url: 'https://www.deribit.com',
  provides: 'BTC options put/call open-interest ratio (live; history builds up locally)',
  intervalMs: HOUR,
  async sync(store) {
    const res = await fetchJson<BookSummary>('https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option');
    let puts = 0;
    let calls = 0;
    for (const o of res.result) {
      if (o.instrument_name.endsWith('-P')) puts += o.open_interest;
      else if (o.instrument_name.endsWith('-C')) calls += o.open_interest;
    }
    if (!(calls > 0)) return 0;
    return store.upsertPoints('deribit.putCall', [{ t: dayStart(Date.now() / 1000), v: puts / calls }]);
  },
};

// ───────────────────────── Hyperliquid ─────────────────────────

interface HlFunding {
  time: number;
  fundingRate: string;
}

/** Hourly funding on Hyperliquid, the largest on-chain perpetuals venue (history since May 2023). */
export const hyperliquid: Provider = {
  id: 'hyperliquid',
  name: 'Hyperliquid',
  url: 'https://hyperliquid.xyz',
  provides: 'Hourly BTC perpetual funding on Hyperliquid since May 2023',
  intervalMs: HOUR,
  async sync(store) {
    const last = await store.lastPointT('hl.funding');
    let start = last != null ? (last + 1) * 1000 : Date.UTC(2023, 4, 1);
    let written = 0;
    for (let page = 0; page < 200; page++) {
      const res = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'fundingHistory', coin: 'BTC', startTime: start }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from api.hyperliquid.xyz`);
      const rows = (await res.json()) as HlFunding[];
      if (!rows.length) break;
      written += await store.upsertPoints(
        'hl.funding',
        rows.map((r) => ({ t: Math.floor(r.time / 1000), v: +r.fundingRate })),
      );
      if (rows.length < 500) break;
      start = rows[rows.length - 1].time + 1;
      // Hyperliquid rate-limits by request weight; pace the backfill. Each page is saved, so a later sync resumes here.
      await new Promise((r) => setTimeout(r, 1500));
    }
    return written;
  },
};
