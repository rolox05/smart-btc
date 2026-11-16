import type { Candle, LiquidationPrint, NotificationDelivery } from '@smart-btc/shared';

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
  /** Failed syncs in a row; back to zero on the next success. */
  failures: number;
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

  /** Forced liquidations collected from the exchange websockets (times in milliseconds). */
  addLiquidations(rows: LiquidationPrint[]): Promise<number>;
  getLiquidations(fromT: number): Promise<LiquidationPrint[]>;
  firstLiquidationT(): Promise<number | null>;

  /** Small key/value store for preferences kept on the server. */
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  /** Log of notification deliveries, newest first. */
  addNotification(row: NotificationDelivery): Promise<void>;
  getNotifications(limit: number): Promise<NotificationDelivery[]>;

  /** One saved summary per bar and series (JSON), to compare later readings against. */
  saveReading(series: string, asOf: number, json: string): Promise<void>;
  /** The latest reading of the series saved for a bar before `asOf`. */
  previousReading(series: string, asOf: number): Promise<string | null>;

  /** Drops rows older than the given times (liquidations and notifications in ms, readings in seconds). Returns rows removed. */
  prune(before: { liquidationsMs: number; notificationsMs: number; readingsSec: number }): Promise<number>;

  getSyncStates(): Promise<SyncState[]>;
  setSyncState(state: SyncState): Promise<void>;
  close(): Promise<void>;
}
