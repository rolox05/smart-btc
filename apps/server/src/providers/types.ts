import type { Store } from '../store/store.js';

/** A data source that copies upstream history into the local store, incrementally. */
export interface Provider {
  id: string;
  name: string;
  url: string;
  provides: string;
  /** Minimum time between two syncs. */
  intervalMs: number;
  /** Returns the number of rows written. Must be safe to call repeatedly. */
  sync(store: Store): Promise<number>;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const dayStart = (sec: number) => Math.floor(sec / 86_400) * 86_400;
