import type { EventOverlay, EventStudy, EventsReport, MarketEvent, MarketEventKind, OptionExpiry } from '@smart-btc/shared';
import { EN, type T } from '../i18n/index.js';
import { fetchJson, fetchText, ttlCache } from '../lib/http.js';
import { volArrays } from '../forecast/analog.js';
import type { Store } from '../store/store.js';
import type { Dataset } from './dataset.js';

/**
 * Scheduled events that move Bitcoin, and how much they have moved it:
 *
 *  - Fed decisions      dates read from federalreserve.gov (the FOMC calendar)
 *  - US inflation (CPI) values from the BLS public API; past release dates from the BLS schedule
 *  - Option expiries    open interest per expiry from Deribit's public API
 *  - Spot ETF activity  dollar volume of the largest spot ETF (no free source publishes net flows).
 *                       Context only: it never feeds a model or the event overlay, because ETF buyers
 *                       and sellers react to price (FOMO and FUD) rather than lead it.
 *
 * Each kind of event gets an event study on the daily history: how large the move was on those days
 * compared with ordinary days, after dividing by the volatility of the time. That ratio is what the
 * forecast uses to widen its range when an event falls inside the horizon.
 */

const DAY = 86_400;
const utc = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m, d) / 1000);

// ───────────────────────── Fed decisions ─────────────────────────

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.trim().toLowerCase().slice(0, 3)));

/** Decision day (the last day of the meeting) from the calendar's month and day-range labels. */
function decisionDay(year: number, month: string, days: string): number | null {
  if (/notation|unscheduled|cancel/i.test(days)) return null;
  const nums = days.match(/\d+/g)?.map(Number);
  if (!nums?.length) return null;
  const parts = month.split('/');
  const m = monthIndex(parts[parts.length - 1]);
  if (m < 0) return null;
  // "Jan/Feb 31-1": the meeting ends in the second month, which may also be the next year.
  const y = parts.length > 1 && m === 0 ? year + 1 : year;
  return utc(y, m, nums[nums.length - 1]);
}

/** Meeting schedule as published on 15 Nov 2026, used when the Fed's page cannot be read. */
const FOMC_FALLBACK: Record<number, [string, string][]> = {
  2021: [['January', '26-27'], ['March', '16-17'], ['April', '27-28'], ['June', '15-16'], ['July', '27-28'], ['September', '21-22'], ['November', '2-3'], ['December', '14-15']],
  2022: [['January', '25-26'], ['March', '15-16'], ['May', '3-4'], ['June', '14-15'], ['July', '26-27'], ['September', '20-21'], ['November', '1-2'], ['December', '13-14']],
  2023: [['Jan/Feb', '31-1'], ['March', '21-22'], ['May', '2-3'], ['June', '13-14'], ['July', '25-26'], ['September', '19-20'], ['Oct/Nov', '31-1'], ['December', '12-13']],
  2024: [['January', '30-31'], ['March', '19-20'], ['Apr/May', '30-1'], ['June', '11-12'], ['July', '30-31'], ['September', '17-18'], ['November', '6-7'], ['December', '17-18']],
  2025: [['January', '28-29'], ['March', '18-19'], ['May', '6-7'], ['June', '17-18'], ['July', '29-30'], ['September', '16-17'], ['October', '28-29'], ['December', '9-10']],
  2026: [['January', '27-28'], ['March', '17-18'], ['April', '28-29'], ['June', '16-17'], ['July', '28-29'], ['September', '15-16'], ['October', '27-28'], ['December', '8-9']],
  2027: [['January', '26-27'], ['March', '16-17'], ['April', '27-28'], ['June', '8-9'], ['July', '27-28'], ['September', '14-15'], ['October', '26-27'], ['November', '16-17']],
};

export function parseFomcCalendar(html: string): number[] {
  const out: number[] = [];
  const heads = [...html.matchAll(/(\d{4}) FOMC Meetings/g)];
  heads.forEach((h, k) => {
    const year = Number(h[1]);
    const seg = html.slice(h.index! + h[0].length, heads[k + 1]?.index ?? html.length);
    for (const m of seg.matchAll(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g)) {
      const t = decisionDay(year, m[1], m[2]);
      if (t != null) out.push(t);
    }
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

const fallbackFomc = () =>
  Object.entries(FOMC_FALLBACK)
    .flatMap(([y, rows]) => rows.map(([m, d]) => decisionDay(Number(y), m, d)!))
    .sort((a, b) => a - b);

const loadFomc = ttlCache(12 * 3_600_000, async (): Promise<{ dates: number[]; live: boolean }> => {
  try {
    const page = await fetchText('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', { timeoutMs: 15_000, retries: 0, headers: { Accept: 'text/html' } });
    const dates = parseFomcCalendar(page);
    if (dates.length < 20) throw new Error('calendar layout changed');
    // The page only lists recent years: keep the older meetings from the built-in table.
    const merged = new Set([...fallbackFomc().filter((t) => t < dates[0]), ...dates]);
    return { dates: [...merged].sort((a, b) => a - b), live: true };
  } catch {
    return { dates: fallbackFomc(), live: false };
  }
});

// ───────────────────────── inflation (CPI) ─────────────────────────

/** Days of the month on which the CPI report came out (BLS schedule), January to December. 0 = no release. */
const CPI_RELEASE_DAYS: Record<number, number[]> = {
  2021: [13, 10, 10, 13, 12, 10, 13, 11, 14, 13, 10, 10],
  2022: [12, 10, 10, 12, 11, 10, 13, 10, 13, 13, 10, 13],
  2023: [12, 14, 14, 12, 10, 13, 12, 10, 13, 12, 14, 12],
  2024: [11, 13, 12, 10, 15, 12, 11, 14, 11, 10, 13, 11],
  2025: [15, 12, 12, 10, 13, 11, 15, 12, 11, 24, 0, 18],
};
const pastCpiReleases = () =>
  Object.entries(CPI_RELEASE_DAYS).flatMap(([y, days]) => days.flatMap((d, m) => (d ? [utc(Number(y), m, d)] : [])));

/**
 * The BLS does not serve its release schedule to programs, so the next dates are estimated: the report
 * comes out between the 10th and the 15th of the following month, on a weekday.
 */
function estimatedCpiReleases(nowSec: number, count: number): number[] {
  const out: number[] = [];
  const d = new Date(nowSec * 1000);
  for (let k = 0; out.length < count && k < count + 2; k++) {
    const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 12));
    if (date.getUTCDay() === 6) date.setUTCDate(11);
    if (date.getUTCDay() === 0) date.setUTCDate(13);
    const t = Math.floor(date.getTime() / 1000);
    if (t > nowSec - DAY) out.push(t);
  }
  return out;
}

const loadCpi = ttlCache(6 * 3_600_000, async () => {
  const r = await fetchJson<{ Results?: { series?: { data: { year: string; period: string; periodName: string; value: string }[] }[] } }>(
    'https://api.bls.gov/publicAPI/v1/timeseries/data/CUSR0000SA0',
  );
  const rows = (r.Results?.series?.[0]?.data ?? [])
    .filter((d) => /^M(0[1-9]|1[0-2])$/.test(d.period))
    .map((d) => ({ key: `${d.year}-${d.period.slice(1)}`, value: Number(d.value) }))
    .filter((d) => Number.isFinite(d.value))
    .sort((a, b) => a.key.localeCompare(b.key));
  const byKey = new Map(rows.map((x) => [x.key, x.value]));
  return rows
    .map((x, i) => {
      const [y, m] = x.key.split('-');
      const yearAgo = byKey.get(`${Number(y) - 1}-${m}`);
      const prev = rows[i - 1]?.value;
      return { month: x.key, yoyPct: yearAgo ? (x.value / yearAgo - 1) * 100 : NaN, momPct: prev ? (x.value / prev - 1) * 100 : NaN };
    })
    .filter((x) => Number.isFinite(x.yoyPct))
    .slice(-12);
});

// ───────────────────────── option expiries ─────────────────────────

const lastFriday = (y: number, m: number) => {
  const d = new Date(Date.UTC(y, m + 1, 0));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 2) % 7));
  return Math.floor(d.getTime() / 1000);
};
const isMonthlyExpiry = (t: number) => {
  const d = new Date(t * 1000);
  return lastFriday(d.getUTCFullYear(), d.getUTCMonth()) === t;
};
function monthlyExpiries(fromT: number, toT: number): number[] {
  const out: number[] = [];
  const d = new Date(fromT * 1000);
  for (let y = d.getUTCFullYear(), m = d.getUTCMonth(); ; m++) {
    const t = lastFriday(y + Math.floor(m / 12), m % 12);
    if (t > toT) break;
    if (t >= fromT) out.push(t);
  }
  return out;
}

const loadExpiries = ttlCache(15 * 60_000, async (): Promise<OptionExpiry[]> => {
  const r = await fetchJson<{ result: { instrument_name: string; open_interest: number; underlying_price: number }[] }>(
    'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option',
  );
  const byExpiry = new Map<number, { label: string; calls: Map<number, number>; puts: Map<number, number>; px: number }>();
  for (const row of r.result) {
    const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/.exec(row.instrument_name);
    if (!m || !(row.open_interest > 0)) continue;
    const t = utc(2000 + Number(m[3]), monthIndex(m[2]), Number(m[1]));
    const e = byExpiry.get(t) ?? { label: `${m[1]} ${m[2]} ${m[3]}`, calls: new Map(), puts: new Map(), px: row.underlying_price };
    const side = m[5] === 'C' ? e.calls : e.puts;
    side.set(Number(m[4]), (side.get(Number(m[4])) ?? 0) + row.open_interest);
    byExpiry.set(t, e);
  }
  return [...byExpiry]
    .map(([t, e]) => {
      const callOi = [...e.calls.values()].reduce((a, b) => a + b, 0);
      const putOi = [...e.puts.values()].reduce((a, b) => a + b, 0);
      // Max pain: the settlement price at which option holders collect the least in aggregate.
      let maxPain = NaN;
      let best = Infinity;
      for (const k of new Set([...e.calls.keys(), ...e.puts.keys()])) {
        let pay = 0;
        for (const [strike, oi] of e.calls) pay += oi * Math.max(0, k - strike);
        for (const [strike, oi] of e.puts) pay += oi * Math.max(0, strike - k);
        if (pay < best) {
          best = pay;
          maxPain = k;
        }
      }
      return {
        t,
        label: e.label,
        openInterestBtc: callOi + putOi,
        notionalUsd: (callOi + putOi) * e.px,
        putCallRatio: callOi > 0 ? putOi / callOi : NaN,
        maxPain,
        monthly: isMonthlyExpiry(t),
      };
    })
    .sort((a, b) => a.t - b.t);
});

// ───────────────────────── event study ─────────────────────────

/** Daily moves on the given days against every other day since the first of them, volatility-adjusted. */
export function eventStudy(ds: Dataset, kind: MarketEventKind, name: string, dates: number[]): EventStudy {
  const { ewma } = volArrays(ds);
  const idx = new Set<number>();
  for (const t of dates) {
    const i = Math.round((t - ds.t[0]) / DAY);
    // Only closed bars count: today's bar is still forming.
    if (i >= 31 && i <= ds.lastClosed && ds.t[i] === t) idx.add(i);
  }
  let absE = 0;
  let absN = 0;
  let z2E = 0;
  let z2N = 0;
  let nN = 0;
  let up = 0;
  const first = idx.size ? Math.min(...idx) : ds.n;
  for (let i = first; i <= ds.lastClosed; i++) {
    const r = Math.log(ds.c[i] / ds.c[i - 1]);
    const v = ewma[i - 1];
    if (!Number.isFinite(r) || !(v > 0)) continue;
    const z2 = (r * r) / v;
    if (idx.has(i)) {
      absE += Math.abs(r);
      z2E += z2;
      if (r > 0) up++;
    } else {
      absN += Math.abs(r);
      z2N += z2;
      nN++;
    }
  }
  const n = idx.size;
  return {
    kind,
    name,
    n,
    avgAbsMovePct: n ? (absE / n) * 100 : NaN,
    normalAbsMovePct: nN ? (absN / nN) * 100 : NaN,
    varianceRatio: n && nN && z2N > 0 ? z2E / n / (z2N / nN) : NaN,
    upShare: n ? up / n : NaN,
  };
}

/**
 * How much scheduled events inside the next `horizonDays` widen the forecast range: each event day
 * carries `varianceRatio` days' worth of variance instead of one. Ratios measured on fewer than 12
 * events, or below 1, add nothing.
 */
export function eventOverlay(upcoming: MarketEvent[], studies: EventStudy[], nowSec: number, horizonDays: number): EventOverlay {
  const byKind = new Map(studies.map((s) => [s.kind, s]));
  const events: EventOverlay['events'] = [];
  let extra = 0;
  for (const e of upcoming) {
    if (e.t <= nowSec - DAY || e.t > nowSec + horizonDays * DAY) continue;
    const s = byKind.get(e.kind);
    const vr = s && s.n >= 12 && s.varianceRatio > 1 ? s.varianceRatio : 1;
    extra += vr - 1;
    events.push({ kind: e.kind, t: e.t, title: e.title, varianceRatio: vr });
  }
  return { spreadMultiplier: Math.min(1.5, Math.sqrt(1 + extra / Math.max(1, horizonDays))), events };
}

// ───────────────────────── report ─────────────────────────

export interface EventData {
  upcoming: MarketEvent[];
  studies: EventStudy[];
}

/** Calendar and event studies only: what the forecast overlay needs. */
export async function eventData(daily: Dataset, t: T = EN): Promise<EventData & { fomcLive: boolean; expiries: OptionExpiry[] }> {
  const now = Math.floor(Date.now() / 1000);
  const today = Math.floor(now / DAY) * DAY;
  const [fomc, expiries] = await Promise.all([loadFomc(), loadExpiries().catch(() => [] as OptionExpiry[])]);
  const horizonEnd = today + 120 * DAY;
  const upcoming: MarketEvent[] = [];
  for (const d of fomc.dates) {
    if (d >= today && d <= horizonEnd) upcoming.push({ kind: 'fomc', t: d, title: t('Fed rate decision'), detail: t('FOMC statement at 18:00 UTC, press conference 30 minutes later.'), estimated: false });
  }
  for (const d of estimatedCpiReleases(now, 3)) {
    if (d >= today) upcoming.push({ kind: 'cpi', t: d, title: t('US inflation report (CPI)'), detail: t('Published at 13:30 UTC. Estimated date: the report comes out between the 10th and the 15th.'), estimated: true });
  }
  const listed = expiries.filter((e) => e.t >= today && e.t <= horizonEnd && e.monthly);
  const monthly = listed.length ? listed.map((e) => e.t) : monthlyExpiries(today, horizonEnd);
  for (const d of monthly) {
    const e = expiries.find((x) => x.t === d);
    upcoming.push({
      kind: 'expiry',
      t: d,
      title: t('Monthly options expiry'),
      detail: e
        ? t('{btc} BTC of open interest (about ${usd}B) settles on Deribit at 08:00 UTC; max pain {pain}.', { btc: Math.round(e.openInterestBtc).toLocaleString('en-US'), usd: (e.notionalUsd / 1e9).toFixed(1), pain: `$${Math.round(e.maxPain).toLocaleString('en-US')}` })
        : t('Deribit settles the monthly contracts at 08:00 UTC.'),
      estimated: false,
    });
  }
  upcoming.sort((a, b) => a.t - b.t);

  const studies = [
    eventStudy(daily, 'fomc', t('Fed decision days'), fomc.dates),
    eventStudy(daily, 'cpi', t('CPI release days'), pastCpiReleases()),
    eventStudy(daily, 'expiry', t('Monthly expiry days'), monthlyExpiries(utc(2020, 0, 1), today)),
  ];
  return { upcoming, studies, fomcLive: fomc.live, expiries };
}

export async function eventsReport(daily: Dataset, store: Store, t: T = EN): Promise<EventsReport> {
  const now = Math.floor(Date.now() / 1000);
  const [data, inflation, etfPoints] = await Promise.all([
    eventData(daily, t),
    loadCpi().catch(() => [] as Awaited<ReturnType<typeof loadCpi>>),
    store.getPoints('yahoo.ibitVol', now - 45 * DAY),
  ]);
  let etf: EventsReport['etf'] = null;
  if (etfPoints.length >= 5) {
    const series = etfPoints.slice(-30).map((p) => ({ t: p.t, usd: p.v }));
    const avg30Usd = series.reduce((a, p) => a + p.usd, 0) / series.length;
    const lastUsd = series[series.length - 1].usd;
    etf = { series, avg30Usd, lastUsd, ratio: avg30Usd > 0 ? lastUsd / avg30Usd : NaN };
  }
  const notes = [
    t('Event studies compare the daily move on past event days with all other days since 2021, after dividing each move by the volatility of the time. A variance ratio of 2 means an event day carried two ordinary days of risk.'),
    t('No free source publishes daily net flows of the spot ETFs, so the panel shows the dollar volume of the largest one (IBIT) as an activity gauge: heavy volume means institutions are active, not which way they are trading.'),
    t('ETF activity is context only. No model in this app reads it: ETF buyers tend to pile in after rallies and sell after drops (FOMO and FUD), so inflows are not treated as a buy signal nor outflows as a sell signal.'),
  ];
  if (!data.fomcLive) notes.push(t('The Fed calendar could not be read just now; meeting dates come from the built-in schedule.'));
  if (!inflation.length) notes.push(t('Inflation figures could not be loaded from the BLS just now.'));
  return {
    at: Date.now(),
    upcoming: data.upcoming,
    studies: data.studies,
    expiries: data.expiries.filter((e) => e.t >= Math.floor(now / DAY) * DAY).slice(0, 8),
    inflation,
    etf,
    notes,
  };
}
