import type { Store } from '../store/store.js';

/** A data source that copies upstream history into the local store, incrementally. */
export interface Provider {
  id: string;
  name: string;
  url: string;
  /** What the source supplies, in English; {placeholders} are filled from providesVars (each value translated too). */
  provides: string;
  providesVars?: Record<string, string>;
  /** Series this source writes to the store, with what a healthy one looks like. */
  series?: SeriesSpec[];
  /** Candle sets this source writes to the store. */
  candles?: CandleSpec[];
  /** Minimum time between two syncs. */
  intervalMs: number;
  /** Returns the number of rows written. Must be safe to call repeatedly. */
  sync(store: Store): Promise<number>;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const dayStart = (sec: number) => Math.floor(sec / 86_400) * 86_400;
export const DAY_SEC = 86_400;

/** What the health checks may expect of a stored series. */
export interface SeriesSpec {
  id: string;
  /** Normal spacing between two values, in seconds. */
  everySec: number;
  /** Age of the newest value beyond which the series counts as behind. Defaults to three spacings. */
  maxAgeSec?: number;
  /** Share of slots that normally carry a value (markets that close at weekends fill about 5 in 7). */
  duty?: number;
  /** Values must be above zero. */
  positive?: boolean;
  /** Repeating the same value for long is normal here (capped funding rates, weekly reports, a 0-100 index). */
  mayRepeat?: boolean;
  /** One-off jumps that reverse the next reading are normal here (quarter-end balances). */
  maySpike?: boolean;
  /** Value-to-value moves are judged on differences instead of ratios (rates and balances that cross zero). */
  additive?: boolean;
}

export interface CandleSpec {
  source: string;
  interval: string;
  barSec: number;
}

/** Shorthand for a daily series. */
export const daily = (id: string, extra: Partial<SeriesSpec> = {}): SeriesSpec => ({ id, everySec: DAY_SEC, ...extra });
