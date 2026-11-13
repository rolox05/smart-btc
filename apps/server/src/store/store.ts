import type { Candle } from '@smart-btc/shared';

export interface Point {
  t: number;
  v: number;
}

export interface SyncState {
  provider: string;
  lastOk: number | null;
  lastAttempt: number | null;
  status: 'ok' | 'error' | 'pending';
  message: string;
  rows: number;
}

/**
 * Persistence boundary. The local build uses SQLite (see sqliteStore.ts); the interface is
 * async on purpose so it can be re-implemented on Postgres/Timescale without touching callers.
 */
export interface Store {
  upsertCandles(source: string, interval: string, candles: Candle[]): Promise<number>;
  getCandles(source: string, interval: string, fromT?: number): Promise<Candle[]>;
  lastCandleT(source: string, interval: string): Promise<number | null>;

  upsertPoints(series: string, points: Point[]): Promise<number>;
  getPoints(series: string, fromT?: number): Promise<Point[]>;
  lastPointT(series: string): Promise<number | null>;
  countPoints(prefix: string): Promise<number>;

  getSyncStates(): Promise<SyncState[]>;
  setSyncState(state: SyncState): Promise<void>;
  close(): Promise<void>;
}
