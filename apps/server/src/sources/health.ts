import type { Candle, HealthCheck, HealthGrade, SourceHealth } from '@smart-btc/shared';
import { EN, type T } from '../i18n/index.js';
import { providers, type Provider } from '../providers/index.js';
import { DAY_SEC, type CandleSpec, type SeriesSpec } from '../providers/types.js';
import type { Point, Store, SyncState } from '../store/store.js';
import type { SourcePrefs } from './prefs.js';

/**
 * Data health: every source's stored data is tested for the ways a feed goes wrong in practice.
 *   sync       repeated failed downloads
 *   fresh      the newest value is older than the source's normal rhythm allows
 *   gaps       values missing inside the recent window
 *   values     impossible prices, values that must be positive and are not, a feed stuck on one
 *              value, and single ticks that jump far out of line and straight back
 *   agreement  the same quantity read from other sources says something different
 * Nothing here changes data: the checks only tell the user which source to switch off.
 */

const RANK: Record<HealthGrade, number> = { unknown: 0, good: 1, warn: 2, bad: 3 };
const POINTS: Record<HealthGrade, number> = { good: 100, warn: 55, bad: 0, unknown: 0 };
const worse = (a: HealthGrade, b: HealthGrade): HealthGrade => (RANK[b] > RANK[a] ? b : a);

export const HEALTH = {
  /** A newest value up to this many times older than allowed is a warning; beyond it, bad. */
  lateFactor: 2.5,
  coverageGood: 0.9,
  coverageWarn: 0.7,
  /** The same value this many times in a row at the end of a series. */
  stuckWarn: 5,
  stuckBad: 10,
  /** A tick counts as out of line when it moves this many typical moves away and comes straight back. */
  spikeScale: 12,
  spikesBad: 3,
  failuresBad: 3,
  /** Fewer stored values than this and there is nothing to judge yet. */
  minValues: 5,
} as const;

interface Finding {
  grade: HealthGrade;
  detail: string;
}

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const ageText = (sec: number, t: T) => (sec < 48 * 3600 ? t('{n} hours', { n: Math.max(0, Math.round(sec / 3600)) }) : t('{n} days', { n: Math.round(sec / DAY_SEC) }));

/** How many recent slots a series is judged on. */
const windowSec = (everySec: number) => Math.min(400 * DAY_SEC, 120 * everySec);

function freshness(name: string, lastT: number, maxAgeSec: number, now: number, t: T): Finding {
  const age = now - lastT;
  if (age <= maxAgeSec) return { grade: 'good', detail: t('Newest value is {age} old.', { age: ageText(age, t) }) };
  return {
    grade: age <= maxAgeSec * HEALTH.lateFactor ? 'warn' : 'bad',
    detail: t('{name}: newest value is {age} old, expected within {max}.', { name, age: ageText(age, t), max: ageText(maxAgeSec, t) }),
  };
}

function coverage(name: string, slots: number, expected: number, t: T): Finding {
  const share = expected > 0 ? Math.min(1, slots / expected) : 1;
  const pct = Math.round(share * 100);
  if (share >= HEALTH.coverageGood) return { grade: 'good', detail: t('{pct}% of the expected recent values are present.', { pct }) };
  return { grade: share >= HEALTH.coverageWarn ? 'warn' : 'bad', detail: t('{name}: only {pct}% of the expected recent values are present.', { name, pct }) };
}

/** Ticks that jump far out of line and come straight back: the signature of a bad print, not of a market move. */
export function countSpikes(values: number[], additive: boolean): number {
  const d: number[] = [];
  for (let i = 1; i < values.length; i++) {
    d.push(additive ? values[i] - values[i - 1] : values[i] > 0 && values[i - 1] > 0 ? Math.log(values[i] / values[i - 1]) : NaN);
  }
  const clean = d.filter((x) => !Number.isNaN(x));
  if (clean.length < 20) return 0;
  const mid = median(clean);
  const scale = 1.4826 * median(clean.map((x) => Math.abs(x - mid)));
  if (!(scale > 0)) return 0;
  const limit = HEALTH.spikeScale * scale;
  let spikes = 0;
  for (let i = 0; i + 1 < d.length; i++) {
    const a = d[i] - mid;
    const b = d[i + 1] - mid;
    if (Math.abs(a) > limit && Math.abs(b) > limit && a * b < 0) {
      spikes++;
      i++;
    }
  }
  return spikes;
}

function tailRun(values: number[]): number {
  let run = 1;
  for (let i = values.length - 1; i > 0 && values[i] === values[i - 1]; i--) run++;
  return run;
}

function valueFindings(name: string, values: number[], spec: { positive?: boolean; mayRepeat?: boolean; maySpike?: boolean; additive?: boolean }, t: T): Finding[] {
  const out: Finding[] = [];
  if (spec.positive) {
    const n = values.filter((v) => !(v > 0)).length;
    if (n) out.push({ grade: n >= 3 ? 'bad' : 'warn', detail: t('{name}: {n} values at or below zero.', { name, n }) });
  }
  if (!spec.mayRepeat) {
    const run = tailRun(values);
    if (run >= HEALTH.stuckWarn) out.push({ grade: run >= HEALTH.stuckBad ? 'bad' : 'warn', detail: t('{name}: stuck on the same value for the last {n} readings.', { name, n: run }) });
  }
  const spikes = spec.maySpike ? 0 : countSpikes(values, spec.additive ?? false);
  if (spikes) out.push({ grade: spikes >= HEALTH.spikesBad ? 'bad' : 'warn', detail: t('{name}: {n} readings jump far out of line and straight back.', { name, n: spikes }) });
  return out;
}

type Findings = Partial<Record<HealthCheck['id'], Finding[]>>;
const add = (into: Findings, id: HealthCheck['id'], f: Finding) => (into[id] ??= []).push(f);

/** Checks of one stored series against what its source says a healthy one looks like. */
export function checkSeries(spec: SeriesSpec, points: Point[], now: number, t: T = EN): Findings {
  const out: Findings = {};
  if (points.length < HEALTH.minValues) {
    const building: Finding = { grade: 'unknown', detail: t('{name}: history is still building up.', { name: spec.id }) };
    return { fresh: [points.length ? freshness(spec.id, points[points.length - 1].t, spec.maxAgeSec ?? Math.max(2 * 3600, 3 * spec.everySec), now, t) : building], gaps: [building], values: [building] };
  }
  const last = points[points.length - 1].t;
  add(out, 'fresh', freshness(spec.id, last, spec.maxAgeSec ?? Math.max(2 * 3600, 3 * spec.everySec), now, t));
  const slots = new Set(points.map((p) => Math.floor(p.t / spec.everySec))).size;
  const expected = (Math.floor((last - points[0].t) / spec.everySec) + 1) * (spec.duty ?? 1);
  add(out, 'gaps', coverage(spec.id, slots, expected, t));
  const problems = valueFindings(spec.id, points.map((p) => p.v), spec, t);
  out.values = problems.length ? problems : [{ grade: 'good', detail: t('No impossible, stuck or out-of-line values in the recent data.') }];
  return out;
}

/** The same checks for a candle set, plus bars whose prices cannot be true. */
export function checkCandles(spec: CandleSpec, candles: Candle[], now: number, t: T = EN): Findings {
  const name = `${spec.source} ${spec.interval}`;
  const out: Findings = {};
  if (candles.length < HEALTH.minValues) {
    const building: Finding = { grade: 'unknown', detail: t('{name}: history is still building up.', { name }) };
    return { fresh: [building], gaps: [building], values: [building] };
  }
  const last = candles[candles.length - 1].t;
  // The newest bar is the one still forming, so its open time is at most one bar old on a healthy feed.
  add(out, 'fresh', freshness(name, last, Math.max(2 * 3600, 2 * spec.barSec), now, t));
  add(out, 'gaps', coverage(name, candles.length, Math.floor((last - candles[0].t) / spec.barSec) + 1, t));
  const eps = 1e-9;
  const broken = candles.filter((k) => !(k.c > 0) || !(k.l > 0) || k.h < k.l || k.o > k.h * (1 + eps) || k.o < k.l * (1 - eps) || k.c > k.h * (1 + eps) || k.c < k.l * (1 - eps)).length;
  const problems: Finding[] = [];
  if (broken) problems.push({ grade: broken >= 3 ? 'bad' : 'warn', detail: t('{name}: {n} candles with impossible prices (a high below the low, or a close outside the range).', { name, n: broken }) });
  // The forming bar legitimately repeats its close between two trades on a quiet feed; judge closed bars.
  problems.push(...valueFindings(name, candles.slice(0, -1).map((k) => k.c), {}, t));
  out.values = problems.length ? problems : [{ grade: 'good', detail: t('No impossible, stuck or out-of-line values in the recent data.') }];
  return out;
}

// ───────────────────────── agreement between sources ─────────────────────────

type DayValues = Map<number, number>;

interface CrossCheck {
  /** What is being compared, in English. */
  what: string;
  days: number;
  /** Differences are relative (0.015 = 1.5%) unless `additive`, where they are in the series' own unit. */
  warn: number;
  bad: number;
  additive?: boolean;
  /** How a difference is written: as a percentage, or as a plain number with this many decimals. */
  decimals?: number;
  members: { provider: string; load: (store: Store, fromT: number) => Promise<DayValues> }[];
}

const day = (t: number) => Math.floor(t / DAY_SEC);
const closes = (source: string) => async (store: Store, fromT: number): Promise<DayValues> =>
  new Map((await store.getCandles(source, '1d', fromT)).map((k) => [day(k.t), k.c]));
const lastOfDay = (series: string) => async (store: Store, fromT: number): Promise<DayValues> =>
  new Map((await store.getPoints(series, fromT)).map((p) => [day(p.t), p.v]));
/** Average of the day's readings: funding settles three times a day on these venues. */
const meanOfDay = (series: string) => async (store: Store, fromT: number): Promise<DayValues> => {
  const sum = new Map<number, { s: number; n: number }>();
  for (const p of await store.getPoints(series, fromT)) {
    const e = sum.get(day(p.t)) ?? { s: 0, n: 0 };
    e.s += p.v;
    e.n++;
    sum.set(day(p.t), e);
  }
  return new Map([...sum].map(([d, e]) => [d, (e.s / e.n) * 100]));
};
/** Trailing 7-day average: daily hash-rate estimates are noisy by construction. */
const weekAverage = (series: string) => async (store: Store, fromT: number): Promise<DayValues> => {
  const raw = await lastOfDay(series)(store, fromT - 7 * DAY_SEC);
  const out: DayValues = new Map();
  for (const d of raw.keys()) {
    const xs: number[] = [];
    for (let k = 0; k < 7; k++) if (raw.has(d - k)) xs.push(raw.get(d - k)!);
    if (xs.length >= 5 && d * DAY_SEC >= fromT) out.set(d, xs.reduce((a, b) => a + b, 0) / xs.length);
  }
  return out;
};

export const CROSS_CHECKS: CrossCheck[] = [
  {
    what: 'daily close',
    days: 30,
    warn: 0.015,
    bad: 0.04,
    members: [
      { provider: 'binance-spot', load: closes('binance') },
      { provider: 'coinbase', load: closes('coinbase') },
      { provider: 'bitstamp', load: closes('bitstamp') },
      { provider: 'kraken', load: closes('kraken') },
      { provider: 'coinmetrics', load: lastOfDay('cm.price') },
    ],
  },
  {
    what: 'funding rate (% per settlement)',
    days: 30,
    warn: 0.01,
    bad: 0.04,
    additive: true,
    decimals: 4,
    members: [
      { provider: 'binance-futures', load: meanOfDay('binance.funding') },
      { provider: 'bybit', load: meanOfDay('bybit.funding') },
      { provider: 'okx', load: meanOfDay('okx.funding') },
    ],
  },
  {
    what: 'hash rate (7-day average)',
    days: 60,
    warn: 0.08,
    bad: 0.25,
    members: [
      { provider: 'coinmetrics', load: weekAverage('cm.hashrate') },
      { provider: 'blockchain-com', load: weekAverage('bc.hashrate') },
      { provider: 'mempool', load: weekAverage('mp.hashrate') },
    ],
  },
  {
    what: 'transactions per day',
    days: 30,
    warn: 0.05,
    bad: 0.15,
    members: [
      { provider: 'coinmetrics', load: lastOfDay('cm.txCnt') },
      { provider: 'blockchain-com', load: lastOfDay('bc.txCnt') },
    ],
  },
  {
    what: '10-year Treasury yield',
    days: 45,
    warn: 0.06,
    bad: 0.25,
    additive: true,
    decimals: 2,
    members: [
      { provider: 'yahoo', load: lastOfDay('yahoo.us10y') },
      { provider: 'fred', load: lastOfDay('fred.us10y') },
    ],
  },
];

/**
 * Each member against the median of all members, day by day. A member is judged on its typical (median)
 * difference, so one odd day does not condemn a source. With only two members a disagreement cannot be
 * pinned on either, so it stays a warning for both.
 */
export function compareMembers(check: Pick<CrossCheck, 'what' | 'warn' | 'bad' | 'additive' | 'decimals'>, members: { provider: string; name: string; values: DayValues }[], t: T = EN): Map<string, Finding> {
  const out = new Map<string, Finding>();
  const live = members.filter((m) => m.values.size >= HEALTH.minValues);
  if (live.length < 2) return out;
  const fmt = (x: number) => (check.additive ? x.toFixed(check.decimals ?? 2) : `${(x * 100).toFixed(x < 0.01 ? 2 : 1)}%`);
  for (const m of live) {
    const others = live.filter((o) => o !== m);
    const diffs: number[] = [];
    for (const [d, v] of m.values) {
      // Against the median of everyone when three or more report (one bad source cannot move it);
      // with two, against the other one.
      const ref = median((live.length >= 3 ? live : others).flatMap((o) => (o.values.has(d) ? [o.values.get(d)!] : [])));
      if (Number.isNaN(ref)) continue;
      diffs.push(check.additive ? Math.abs(v - ref) : ref !== 0 ? Math.abs(v / ref - 1) : NaN);
    }
    const clean = diffs.filter((x) => !Number.isNaN(x));
    if (clean.length < HEALTH.minValues) continue;
    const typical = median(clean);
    const names = others.map((o) => o.name).join(', ');
    const what = t(check.what);
    if (typical <= check.warn) {
      out.set(m.provider, { grade: 'good', detail: t('{what}: within {x} of {names} on a typical day.', { what, x: fmt(typical), names }) });
    } else {
      const pinned = live.length >= 3;
      out.set(m.provider, {
        grade: typical > check.bad && pinned ? 'bad' : 'warn',
        detail:
          t('{what}: differs from {names} by {x} on a typical day ({max} at worst).', { what, x: fmt(typical), max: fmt(Math.max(...clean)), names }) +
          (pinned ? '' : ` ${t('With only two sources it is not possible to say which one is off.')}`),
      });
    }
  }
  return out;
}

// ───────────────────────── per-source verdict ─────────────────────────

const LABEL: Record<HealthCheck['id'], string> = { sync: 'Downloads', fresh: 'Freshness', gaps: 'Completeness', values: 'Values', agreement: 'Agreement' };
const ORDER: HealthCheck['id'][] = ['sync', 'fresh', 'gaps', 'values', 'agreement'];

/** The worst finding of each check decides its grade; its text leads, followed by any other problems. */
export function verdict(findings: Findings, checkedAt: number, t: T = EN): SourceHealth {
  const checks: HealthCheck[] = [];
  for (const id of ORDER) {
    const list = findings[id];
    if (!list?.length) continue;
    const grade = list.reduce<HealthGrade>((g, f) => worse(g, f.grade), 'unknown');
    const shown = grade === 'good' || grade === 'unknown' ? [list.find((f) => f.grade === grade)!] : list.filter((f) => RANK[f.grade] >= RANK.warn).sort((a, b) => RANK[b.grade] - RANK[a.grade]).slice(0, 3);
    checks.push({ id, label: t(LABEL[id]), grade, detail: shown.map((f) => f.detail).join(' ') });
  }
  const judged = checks.filter((c) => c.grade !== 'unknown');
  if (!judged.length) return { score: null, grade: 'unknown', checks, checkedAt };
  const pts = judged.map((c) => POINTS[c.grade]);
  // Half average, half weakest link: one failed check must not hide behind four passes.
  const score = Math.round(0.5 * (pts.reduce((a, b) => a + b, 0) / pts.length) + 0.5 * Math.min(...pts));
  return { score, grade: judged.reduce<HealthGrade>((g, c) => worse(g, c.grade), 'good'), checks, checkedAt };
}

function syncFinding(state: SyncState | undefined, t: T): Finding {
  if (!state) return { grade: 'unknown', detail: t('Not downloaded yet.') };
  if (state.failures === 0 && state.status === 'ok') return { grade: 'good', detail: t('The last download succeeded.') };
  const n = Math.max(1, state.failures);
  return { grade: n >= HEALTH.failuresBad ? 'bad' : 'warn', detail: t('{n} failed downloads in a row: {message}', { n, message: state.message || '?' }) };
}

const CACHE_MS = 5 * 60_000;

/** Runs the checks on the stored data. Results are kept for a few minutes or until new data lands. */
export class HealthService {
  private cache = new Map<string, { at: number; value: Map<string, SourceHealth> }>();

  constructor(
    private store: Store,
    private prefs: SourcePrefs,
  ) {}

  invalidate() {
    this.cache.clear();
  }

  async evaluate(states: Map<string, SyncState>, t: T = EN): Promise<Map<string, SourceHealth>> {
    const hit = this.cache.get(t.lang);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const now = Math.floor(Date.now() / 1000);
    const active = providers.filter((p) => this.prefs.isEnabled(p.id) && states.get(p.id)?.lastOk != null);
    const findings = new Map<string, Findings>(active.map((p) => [p.id, { sync: [syncFinding(states.get(p.id), t)] }]));
    await Promise.all(active.map((p) => this.own(p, findings.get(p.id)!, now, t)));

    const names = new Map(providers.map((p) => [p.id, p.name]));
    for (const check of CROSS_CHECKS) {
      const fromT = now - check.days * DAY_SEC;
      const today = day(now);
      const members = await Promise.all(
        check.members
          .filter((m) => findings.has(m.provider))
          .map(async (m) => {
            const values = await m.load(this.store, fromT);
            // The day still in progress is read at different moments by each source.
            values.delete(today);
            return { provider: m.provider, name: names.get(m.provider) ?? m.provider, values };
          }),
      );
      for (const [provider, finding] of compareMembers(check, members, t)) add(findings.get(provider)!, 'agreement', finding);
    }

    const value = new Map([...findings].map(([id, f]) => [id, verdict(f, Date.now(), t)]));
    this.cache.set(t.lang, { at: Date.now(), value });
    return value;
  }

  private async own(p: Provider, into: Findings, now: number, t: T) {
    for (const spec of p.series ?? []) {
      const found = checkSeries(spec, await this.store.getPoints(spec.id, now - windowSec(spec.everySec)), now, t);
      for (const id of ORDER) for (const f of found[id] ?? []) add(into, id, f);
    }
    for (const spec of p.candles ?? []) {
      const found = checkCandles(spec, await this.store.getCandles(spec.source, spec.interval, now - Math.min(400 * DAY_SEC, 2000 * spec.barSec)), now, t);
      for (const id of ORDER) for (const f of found[id] ?? []) add(into, id, f);
    }
  }
}
