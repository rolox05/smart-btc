import { durationLabel, type MetricUnit, type Timeframe } from '@smart-btc/shared';
import { LOCALE, getLang, tr } from './i18n';

const locale = () => LOCALE[getLang()];
/** Short duration of `bars` on a timeframe in the active language. */
export const dl = (tf: Timeframe, bars: number) => durationLabel(tf, bars, getLang());

const usd0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtUsd = (x: number | null | undefined, digits = 0) =>
  x == null || !Number.isFinite(x) ? '–' : `$${(digits ? usd2 : usd0).format(x)}`;

export function fmtCompactUsd(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  if (a >= 1e9) return `$${(x / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(x / 1e3).toFixed(0)}K`;
  return `$${x.toFixed(0)}`;
}

export const fmtPct = (x: number | null | undefined, digits = 1, sign = true) =>
  x == null || !Number.isFinite(x) ? '–' : `${sign && x > 0 ? '+' : ''}${x.toFixed(digits)}%`;

/** Probability 0-1 as a whole percentage. */
export const fmtProb = (p: number | null | undefined) =>
  p == null || !Number.isFinite(p) ? '–' : `${Math.round(p * 100)}%`;

export function fmtMetric(x: number | null | undefined, unit: MetricUnit): string {
  if (x == null || !Number.isFinite(x)) return '–';
  switch (unit) {
    case 'price':
      return fmtUsd(x);
    case 'usd':
      return fmtCompactUsd(x);
    case 'pct':
      return `${x.toFixed(Math.abs(x) < 1 ? 2 : 1)}%`;
    case 'ratio':
      return x.toFixed(Math.abs(x) < 10 ? 2 : 1);
    case 'days':
      return `${Math.round(x)}d`;
    case 'index':
      return x.toFixed(0);
  }
}

export const fmtDate = (sec: number | null | undefined, withYear = true) =>
  sec == null
    ? '–'
    : new Date(sec * 1000).toLocaleDateString(locale(), {
        day: 'numeric',
        month: 'short',
        year: withYear ? 'numeric' : undefined,
        timeZone: 'UTC',
      });

export function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return tr('never');
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return tr('just now');
  if (s < 3600) return tr('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86_400) return tr('{n} h ago', { n: Math.round(s / 3600) });
  return tr('{n} d ago', { n: Math.round(s / 86_400) });
}

/** A number of bars on a timeframe as an approximate duration, e.g. "~6h" or "~12d". */
export const fmtBars = (tf: Timeframe, bars: number | null | undefined) => (bars == null ? '–' : `~${durationLabel(tf, Math.max(1, Math.round(bars)), getLang())}`);

/** Bar timestamp: date only on daily and longer bars, date and UTC time on intraday ones. */
export function fmtBarTime(sec: number | null | undefined, tf: Timeframe): string {
  if (sec == null) return '–';
  if (tf === '1d' || tf === '1w') return fmtDate(sec);
  const d = new Date(sec * 1000);
  if (tf === '1M') return d.toLocaleDateString(locale(), { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${fmtDate(sec, false)} ${d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

/** Percentage with as many decimals as its size needs: 0.25%, 2.5%, 12%. */
export function fmtPctAuto(x: number | null | undefined, sign = false): string {
  if (x == null || !Number.isFinite(x)) return '–';
  const a = Math.abs(x);
  const digits = a < 1 ? 2 : a < 10 && !Number.isInteger(x) ? 1 : Number.isInteger(x) ? 0 : 1;
  return `${sign && x > 0 ? '+' : ''}${x.toFixed(digits)}%`;
}
