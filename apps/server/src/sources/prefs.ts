import { PROVIDER_BY_ID, providers } from '../providers/index.js';
import type { Store } from '../store/store.js';

const KEY = 'sources';

/** Sources whose daily candles can carry the price history; at least one has to stay on. */
export const PRICE_SOURCES = ['binance-spot', 'coinbase', 'bitstamp', 'kraken'];

export class SourceRuleError extends Error {
  statusCode = 409;
}

/**
 * Which data sources the user switched off. A source that is off is not downloaded, and what it
 * stored earlier is left out of every chart and model until it is switched back on.
 */
export class SourcePrefs {
  private disabled = new Set<string>();
  private loaded = false;
  private listeners: (() => void)[] = [];

  constructor(private store: Store) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const saved = JSON.parse((await this.store.getSetting(KEY)) ?? '{}') as { disabled?: unknown };
      if (Array.isArray(saved.disabled)) this.disabled = new Set(saved.disabled.filter((id): id is string => typeof id === 'string' && PROVIDER_BY_ID.has(id)));
    } catch {
      /* unreadable preferences mean every source is on */
    }
    this.loaded = true;
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  isEnabled(id: string): boolean {
    return !this.disabled.has(id);
  }

  /** Changes with every switch; part of the cache key of anything computed from the data. */
  get key(): string {
    return [...this.disabled].sort().join(',');
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.load();
    if (!PROVIDER_BY_ID.has(id)) throw Object.assign(new Error(`Unknown source "${id}"`), { statusCode: 404 });
    if (enabled === this.isEnabled(id)) return;
    if (!enabled && PRICE_SOURCES.includes(id) && !PRICE_SOURCES.some((p) => p !== id && this.isEnabled(p))) {
      throw new SourceRuleError('At least one price source has to stay on.');
    }
    if (enabled) this.disabled.delete(id);
    else this.disabled.add(id);
    await this.store.setSetting(KEY, JSON.stringify({ disabled: [...this.disabled] }));
    for (const fn of this.listeners) fn();
  }
}

/**
 * The store as the analytics should see it: series and candles written by a switched-off source read
 * as empty. Downloads keep using the real store, so switching a source back on resumes where it stopped.
 */
export function visibleStore(store: Store, prefs: SourcePrefs): Store {
  const seriesOwner = new Map<string, string>();
  const candleOwner = new Map<string, string>();
  for (const p of providers) {
    for (const s of p.series ?? []) seriesOwner.set(s.id, p.id);
    for (const c of p.candles ?? []) candleOwner.set(`${c.source}:${c.interval}`, p.id);
  }
  const hidden = (owner: string | undefined) => owner != null && !prefs.isEnabled(owner);
  return {
    ...store,
    getPoints: async (series, fromT) => (hidden(seriesOwner.get(series)) ? [] : store.getPoints(series, fromT)),
    getCandles: async (source, interval, fromT) => (hidden(candleOwner.get(`${source}:${interval}`)) ? [] : store.getCandles(source, interval, fromT)),
  };
}
