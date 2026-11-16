import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Candle, LiquidationPrint, NotificationDelivery } from '@smart-btc/shared';
import type { Point, Store, SyncState } from './store.js';

// node:sqlite is loaded through require so that bundlers/transpilers never rewrite the specifier.
const require = createRequire(import.meta.url);
type SqliteModule = typeof import('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS candles (
  source TEXT NOT NULL, interval TEXT NOT NULL, t INTEGER NOT NULL,
  o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
  PRIMARY KEY (source, interval, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS points (
  series TEXT NOT NULL, t INTEGER NOT NULL, v REAL NOT NULL,
  PRIMARY KEY (series, t)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS liquidations (
  t INTEGER NOT NULL, venue TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS liquidations_t ON liquidations (t);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS notification_log (
  at INTEGER NOT NULL, channel TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, ok INTEGER NOT NULL, error TEXT
);
CREATE INDEX IF NOT EXISTS notification_log_at ON notification_log (at);
CREATE TABLE IF NOT EXISTS readings (
  series TEXT NOT NULL, as_of INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (series, as_of)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sync_state (
  provider TEXT PRIMARY KEY, last_ok INTEGER, last_attempt INTEGER,
  status TEXT NOT NULL, message TEXT NOT NULL, rows INTEGER NOT NULL
);
`;

export function openSqliteStore(dataDir: string): Store {
  mkdirSync(dataDir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite') as SqliteModule;
  const db = new DatabaseSync(join(dataDir, 'smart-btc.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // Columns added after the first release.
  const syncCols = (db.prepare('PRAGMA table_info(sync_state)').all() as { name: string }[]).map((c) => c.name);
  if (!syncCols.includes('failures')) db.exec('ALTER TABLE sync_state ADD COLUMN failures INTEGER NOT NULL DEFAULT 0');

  const insCandle = db.prepare(
    `INSERT INTO candles (source, interval, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, interval, t) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v`,
  );
  const selCandles = db.prepare(
    'SELECT t, o, h, l, c, v FROM candles WHERE source = ? AND interval = ? AND t >= ? ORDER BY t',
  );
  const selLastCandle = db.prepare('SELECT MAX(t) AS t FROM candles WHERE source = ? AND interval = ?');
  const insPoint = db.prepare(
    'INSERT INTO points (series, t, v) VALUES (?, ?, ?) ON CONFLICT (series, t) DO UPDATE SET v = excluded.v',
  );
  const selPoints = db.prepare('SELECT t, v FROM points WHERE series = ? AND t >= ? ORDER BY t');
  const selLastPoint = db.prepare('SELECT MAX(t) AS t FROM points WHERE series = ?');
  const insLiq = db.prepare('INSERT INTO liquidations (t, venue, side, price, usd) VALUES (?, ?, ?, ?, ?)');
  const selLiq = db.prepare('SELECT t, venue, side, price, usd FROM liquidations WHERE t >= ? ORDER BY t');
  const selFirstLiq = db.prepare('SELECT MIN(t) AS t FROM liquidations');
  const selSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const upSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const insNote = db.prepare('INSERT INTO notification_log (at, channel, kind, title, ok, error) VALUES (?, ?, ?, ?, ?, ?)');
  const selNotes = db.prepare('SELECT at, channel, kind, title, ok, error FROM notification_log ORDER BY at DESC LIMIT ?');
  const upReading = db.prepare('INSERT INTO readings (series, as_of, json) VALUES (?, ?, ?) ON CONFLICT (series, as_of) DO UPDATE SET json = excluded.json');
  const selPrevReading = db.prepare('SELECT json FROM readings WHERE series = ? AND as_of < ? ORDER BY as_of DESC LIMIT 1');
  const delLiq = db.prepare('DELETE FROM liquidations WHERE t < ?');
  const delNotes = db.prepare('DELETE FROM notification_log WHERE at < ?');
  const delReadings = db.prepare('DELETE FROM readings WHERE as_of < ?');
  const selSync = db.prepare('SELECT provider, last_ok, last_attempt, status, message, rows, failures FROM sync_state');
  const upSync = db.prepare(
    `INSERT INTO sync_state (provider, last_ok, last_attempt, status, message, rows, failures) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET last_ok = excluded.last_ok, last_attempt = excluded.last_attempt,
       status = excluded.status, message = excluded.message, rows = excluded.rows, failures = excluded.failures`,
  );

  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return {
    async upsertCandles(source, interval, candles) {
      const clean = candles.filter((c) => [c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite));
      tx(() => {
        for (const c of clean) insCandle.run(source, interval, c.t, c.o, c.h, c.l, c.c, c.v);
      });
      return clean.length;
    },
    async getCandles(source, interval, fromT = 0) {
      return selCandles.all(source, interval, fromT) as unknown as Candle[];
    },
    async lastCandleT(source, interval) {
      return ((selLastCandle.get(source, interval) as { t: number | null } | undefined)?.t ?? null) as number | null;
    },
    async upsertPoints(series, points) {
      const clean = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
      tx(() => {
        for (const p of clean) insPoint.run(series, p.t, p.v);
      });
      return clean.length;
    },
    async getPoints(series, fromT = 0) {
      return selPoints.all(series, fromT) as unknown as Point[];
    },
    async lastPointT(series) {
      return ((selLastPoint.get(series) as { t: number | null } | undefined)?.t ?? null) as number | null;
    },
    async addLiquidations(rows) {
      tx(() => {
        for (const r of rows) insLiq.run(r.t, r.venue, r.side, r.price, r.usd);
      });
      return rows.length;
    },
    async getLiquidations(fromT) {
      return selLiq.all(fromT) as unknown as LiquidationPrint[];
    },
    async firstLiquidationT() {
      return ((selFirstLiq.get() as { t: number | null } | undefined)?.t ?? null) as number | null;
    },
    async getSetting(key) {
      return ((selSetting.get(key) as { value: string } | undefined)?.value ?? null) as string | null;
    },
    async setSetting(key, value) {
      upSetting.run(key, value);
    },
    async addNotification(r) {
      insNote.run(r.at, r.channel, r.kind, r.title, r.ok ? 1 : 0, r.error);
    },
    async getNotifications(limit) {
      return (selNotes.all(limit) as unknown as Record<string, unknown>[]).map((r) => ({
        at: Number(r.at),
        channel: r.channel as NotificationDelivery['channel'],
        kind: r.kind as NotificationDelivery['kind'],
        title: String(r.title),
        ok: Number(r.ok) === 1,
        error: (r.error as string | null) ?? null,
      }));
    },
    async saveReading(series, asOf, json) {
      upReading.run(series, asOf, json);
    },
    async previousReading(series, asOf) {
      return ((selPrevReading.get(series, asOf) as { json: string } | undefined)?.json ?? null) as string | null;
    },
    async prune(before) {
      const removed = [delLiq.run(before.liquidationsMs), delNotes.run(before.notificationsMs), delReadings.run(before.readingsSec)];
      return removed.reduce((a, r) => a + Number(r.changes), 0);
    },
    async getSyncStates() {
      return (selSync.all() as unknown as Record<string, unknown>[]).map((r) => ({
        provider: String(r.provider),
        lastOk: (r.last_ok as number | null) ?? null,
        lastAttempt: (r.last_attempt as number | null) ?? null,
        status: r.status as SyncState['status'],
        message: String(r.message),
        rows: Number(r.rows),
        failures: Number(r.failures ?? 0),
      }));
    },
    async setSyncState(s) {
      upSync.run(s.provider, s.lastOk, s.lastAttempt, s.status, s.message, s.rows, s.failures);
    },
    async close() {
      db.close();
    },
  };
}
