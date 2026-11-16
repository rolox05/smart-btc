import type { SourceStatus } from '@smart-btc/shared';
import { feedsOf } from './analytics/metrics.js';
import { PROVIDER_BY_ID, providers, type Provider } from './providers/index.js';
import type { HealthService } from './sources/health.js';
import type { SourcePrefs } from './sources/prefs.js';
import type { Store, SyncState } from './store/store.js';
import { EN, type T } from './i18n/index.js';

type Listener = () => void;

/** Runs providers when they are due and tells listeners when new data landed. */
export class SyncService {
  private running = new Set<string>();
  private listeners: Listener[] = [];
  private timer: NodeJS.Timeout | null = null;
  private tidyTimer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private log: (msg: string) => void,
    private prefs: SourcePrefs,
    private health: HealthService,
  ) {}

  onData(fn: Listener) {
    this.listeners.push(fn);
  }

  start() {
    void this.runDue();
    this.timer = setInterval(() => void this.runDue(), 60_000);
    void this.tidy();
    this.tidyTimer = setInterval(() => void this.tidy(), 24 * 3_600_000);
  }

  /** The live feeds append without end; nothing in the app reads further back than this. */
  private async tidy() {
    const now = Date.now();
    try {
      const removed = await this.store.prune({ liquidationsMs: now - 180 * 86_400_000, notificationsMs: now - 90 * 86_400_000, readingsSec: Math.floor(now / 1000) - 400 * 86_400 });
      if (removed) this.log(`tidy: removed ${removed} old rows`);
    } catch (err) {
      this.log(`tidy failed: ${(err as Error).message}`);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.tidyTimer) clearInterval(this.tidyTimer);
  }

  /** Run every provider whose interval elapsed. `force` ignores intervals (except hard daily quotas). */
  async runDue(force = false): Promise<void> {
    await this.prefs.load();
    const states = new Map((await this.store.getSyncStates()).map((s) => [s.provider, s]));
    const now = Date.now();
    const due = providers.filter((p) => {
      if (this.running.has(p.id) || !this.prefs.isEnabled(p.id)) return false;
      const s = states.get(p.id);
      if (!s) return true;
      // Quota-limited sources are never forced; a failed attempt is retried after 10 minutes.
      const quotaLimited = p.intervalMs >= 24 * 3_600_000;
      if (force && !quotaLimited) return true;
      if (s.status === 'error') return now - (s.lastAttempt ?? 0) > (quotaLimited ? 3_600_000 : 600_000);
      return now - (s.lastOk ?? 0) > p.intervalMs;
    });
    await Promise.all(due.map((p) => this.runOne(p, states.get(p.id))));
  }

  /** Download one source now (after it was switched back on, or on request). */
  async runNow(id: string): Promise<void> {
    const p = PROVIDER_BY_ID.get(id);
    if (!p || this.running.has(id) || !this.prefs.isEnabled(id)) return;
    await this.runOne(p, (await this.store.getSyncStates()).find((s) => s.provider === id));
  }

  private async runOne(p: Provider, prev?: SyncState) {
    this.running.add(p.id);
    const started = Date.now();
    try {
      const rows = await p.sync(this.store);
      await this.store.setSyncState({
        provider: p.id,
        lastOk: Date.now(),
        lastAttempt: started,
        status: 'ok',
        message: '',
        rows,
        failures: 0,
      });
      this.health.invalidate();
      this.log(`sync ${p.id}: ${rows} rows in ${Date.now() - started}ms`);
      if (rows > 0) for (const fn of this.listeners) fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.setSyncState({
        provider: p.id,
        lastOk: prev?.lastOk ?? null,
        lastAttempt: started,
        status: 'error',
        message,
        rows: prev?.rows ?? 0,
        failures: (prev?.failures ?? 0) + 1,
      });
      this.health.invalidate();
      this.log(`sync ${p.id} failed: ${message}`);
    } finally {
      this.running.delete(p.id);
    }
  }

  /** Whether a provider has completed at least one full sync (its history is usable). */
  async everSynced(providerId: string): Promise<boolean> {
    return (await this.store.getSyncStates()).some((s) => s.provider === providerId && s.lastOk != null);
  }

  async status(t: T = EN): Promise<SourceStatus[]> {
    await this.prefs.load();
    const states = new Map((await this.store.getSyncStates()).map((s) => [s.provider, s]));
    const health = await this.health.evaluate(states, t);
    const now = Date.now();
    return providers.map((p) => {
      const s = states.get(p.id);
      const enabled = this.prefs.isEnabled(p.id);
      let status: SourceStatus['status'] = 'pending';
      if (!enabled) status = 'off';
      else if (s?.status === 'error') status = s.lastOk ? 'stale' : 'error';
      else if (s?.status === 'ok') status = now - (s.lastOk ?? 0) > p.intervalMs * 3 ? 'stale' : 'ok';
      return {
        id: p.id,
        name: p.name,
        url: p.url,
        provides: t(p.provides, Object.fromEntries(Object.entries(p.providesVars ?? {}).map(([k, v]) => [k, t(v)]))),
        status,
        lastOk: s?.lastOk ?? null,
        lastAttempt: s?.lastAttempt ?? null,
        message: s?.message ?? '',
        rows: s?.rows ?? 0,
        enabled,
        failures: s?.failures ?? 0,
        health: enabled ? (health.get(p.id) ?? null) : null,
        feeds: feedsOf(p.id, t),
      };
    });
  }
}
