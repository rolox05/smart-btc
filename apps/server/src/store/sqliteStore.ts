import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Candle } from '@smart-btc/shared';
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
  const cntPoints = db.prepare("SELECT COUNT(*) AS n FROM points WHERE series LIKE ? || '%'");
  const selSync = db.prepare('SELECT provider, last_ok, last_attempt, status, message, rows FROM sync_state');
  const upSync = db.prepare(
    `INSERT INTO sync_state (provider, last_ok, last_attempt, status, message, rows) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET last_ok = excluded.last_ok, last_attempt = excluded.last_attempt,
       status = excluded.status, message = excluded.message, rows = excluded.rows`,
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
    async countPoints(prefix) {
      return Number((cntPoints.get(prefix) as { n: number }).n);
    },
    async getSyncStates() {
      return (selSync.all() as unknown as Record<string, unknown>[]).map((r) => ({
        provider: String(r.provider),
        lastOk: (r.last_ok as number | null) ?? null,
        lastAttempt: (r.last_attempt as number | null) ?? null,
        status: r.status as SyncState['status'],
        message: String(r.message),
        rows: Number(r.rows),
      }));
    },
    async setSyncState(s) {
      upSync.run(s.provider, s.lastOk, s.lastAttempt, s.status, s.message, s.rows);
    },
    async close() {
      db.close();
    },
  };
}
