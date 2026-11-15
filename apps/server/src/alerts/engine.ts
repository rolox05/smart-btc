import type { AlertEvent, AlertInput, AlertRule, ForecastSettings, Lang, LiquidationAlert, LiquidationPrint, NotificationDelivery, NotificationMessage, PriceAlert, ReadingAlert, TodaySummary } from '@smart-btc/shared';
import { randomUUID } from 'node:crypto';
import { type T, makeT } from '../i18n/index.js';
import type { Store } from '../store/store.js';

const KEY = 'alerts';
export const MAX_RULES = 40;
/** A repeating price rule stays quiet this long after firing, so a price hovering on the level does not flood. */
const PRICE_REARM_MS = 5 * 60_000;
/** Longest liquidation window a rule may ask for; prints older than this are dropped. */
export const MAX_WINDOW_MIN = 240;

const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
const compact = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${Math.round(x / 1e3)}K`);

type Message = Pick<NotificationMessage, 'title' | 'body'>;

/** A price rule fires on the tick that carries price through the level, not while it merely sits beyond it. */
export function priceCrossed(rule: Pick<PriceAlert, 'direction' | 'price'>, prev: number, now: number): boolean {
  return rule.direction === 'above' ? prev < rule.price && now >= rule.price : prev > rule.price && now <= rule.price;
}

export function liquidationTotals(prints: LiquidationPrint[], sinceMs: number) {
  let long = 0;
  let short = 0;
  for (const p of prints) {
    if (p.t < sinceMs) continue;
    if (p.side === 'long') long += p.usd;
    else short += p.usd;
  }
  return { long, short, any: long + short };
}

export const readingChanged = (last: NonNullable<ReadingAlert['last']>, s: Pick<TodaySummary, 'direction' | 'edge'>) => last.direction !== s.direction || last.edge !== s.edge;

export interface AlertDeps {
  store: Store;
  notify(message: NotificationMessage): Promise<NotificationDelivery[]>;
  /** The Today summary for a set of forecast settings, in a language; null when it cannot be built. */
  today(settings: ForecastSettings, t: T): Promise<TodaySummary | null>;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Watches the live feeds against the user's rules and hands a message to the notifier when one is
 * met. It runs on the server, so alerts keep working with no browser open.
 *
 * Feeds push into it (`onPrice`, `onPrints`, `checkReadings`); it knows nothing about websockets or
 * about which channels exist.
 */
export class AlertEngine {
  private rules: AlertRule[] | null = null;
  private lastPrice: number | null = null;
  private prints: LiquidationPrint[] = [];
  private listeners = new Set<(e: AlertEvent) => void>();
  private checking = false;
  private now: () => number;

  constructor(private deps: AlertDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ── rules ──

  async list(): Promise<AlertRule[]> {
    if (!this.rules) {
      try {
        this.rules = JSON.parse((await this.deps.store.getSetting(KEY)) ?? '[]') as AlertRule[];
      } catch {
        this.rules = [];
      }
    }
    return this.rules;
  }

  private async save() {
    await this.deps.store.setSetting(KEY, JSON.stringify(this.rules ?? []));
  }

  async create(input: AlertInput, lang: Lang): Promise<AlertRule> {
    const rules = await this.list();
    if (rules.length >= MAX_RULES) throw Object.assign(new Error(`At most ${MAX_RULES} alerts.`), { statusCode: 422 });
    const base = { id: randomUUID(), enabled: true, createdAt: this.now(), lastFiredAt: null, lang };
    const rule: AlertRule = input.type === 'reading' ? { ...base, ...input, last: null } : { ...base, ...input };
    rules.push(rule);
    await this.save();
    return rule;
  }

  async setEnabled(id: string, enabled: boolean): Promise<AlertRule | null> {
    const rule = (await this.list()).find((r) => r.id === id);
    if (!rule) return null;
    rule.enabled = enabled;
    // A reading rule switched back on starts from the reading of that moment, not a stale one.
    if (rule.type === 'reading' && enabled) rule.last = null;
    await this.save();
    return rule;
  }

  async remove(id: string): Promise<boolean> {
    const rules = await this.list();
    const i = rules.findIndex((r) => r.id === id);
    if (i < 0) return false;
    rules.splice(i, 1);
    await this.save();
    return true;
  }

  /** Called with every alert that fires (the live stream uses it to tell open browsers). */
  onAlert(fn: (e: AlertEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── feeds ──

  async onPrice(price: number): Promise<void> {
    const prev = this.lastPrice;
    this.lastPrice = price;
    if (prev == null || !this.rules?.length) return;
    const now = this.now();
    for (const rule of this.rules) {
      if (rule.type !== 'price' || !rule.enabled || !priceCrossed(rule, prev, price)) continue;
      if (rule.lastFiredAt != null && now - rule.lastFiredAt < PRICE_REARM_MS) continue;
      const t = makeT(rule.lang);
      await this.fire(rule, {
        title: t(rule.direction === 'above' ? 'BTC crossed above {level}' : 'BTC crossed below {level}', { level: usd(rule.price) }),
        body: t('Price now {price}.', { price: usd(price) }),
      });
    }
  }

  async onPrints(prints: LiquidationPrint[]): Promise<void> {
    const now = this.now();
    this.prints.push(...prints);
    const oldest = now - MAX_WINDOW_MIN * 60_000;
    if (this.prints.length && this.prints[0].t < oldest) this.prints = this.prints.filter((p) => p.t >= oldest);
    if (!this.rules?.length) return;
    for (const rule of this.rules) {
      if (rule.type !== 'liquidations' || !rule.enabled) continue;
      const windowMs = rule.windowMin * 60_000;
      // One message per window: the same burst is not reported again while it is still inside it.
      if (rule.lastFiredAt != null && now - rule.lastFiredAt < windowMs) continue;
      const totals = liquidationTotals(this.prints, now - windowMs);
      if (totals[rule.side] < rule.minUsd) continue;
      await this.fire(rule, this.liquidationMessage(rule, totals));
    }
  }

  private liquidationMessage(rule: LiquidationAlert, totals: ReturnType<typeof liquidationTotals>): Message {
    const t = makeT(rule.lang);
    const vars = { usd: compact(totals[rule.side]), n: rule.windowMin };
    return {
      title: t(rule.side === 'long' ? '{usd} of longs liquidated in {n} min' : rule.side === 'short' ? '{usd} of shorts liquidated in {n} min' : '{usd} liquidated in {n} min', vars),
      body: [t('Longs {long} · shorts {short} (Binance + Bybit).', { long: compact(totals.long), short: compact(totals.short) }), this.lastPrice ? t('Price now {price}.', { price: usd(this.lastPrice) }) : '']
        .filter(Boolean)
        .join(' '),
    };
  }

  /** Recomputes the reading behind each reading rule and reports a change of lean or edge. */
  async checkReadings(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const rule of [...(await this.list())]) {
        if (rule.type !== 'reading' || !rule.enabled) continue;
        const t = makeT(rule.lang);
        let s: TodaySummary | null;
        try {
          s = await this.deps.today(rule.settings, t);
        } catch (err) {
          this.deps.log?.(`reading alert skipped: ${(err as Error).message}`);
          continue;
        }
        if (!s) continue;
        const last = rule.last;
        rule.last = { direction: s.direction, edge: s.edge };
        if (!last) {
          await this.save();
          continue;
        }
        if (!readingChanged(last, s)) continue;
        await this.fire(rule, {
          title: t('Reading changed · next {h}', { h: t.dur(s.timeframe, s.horizon) }),
          body: `${s.headline}. ${t('{p}% chance of a higher price ({base}% on any day in history).', { p: Math.round(s.pUp * 100), base: Math.round(s.basePUp * 100) })}`,
        });
      }
    } finally {
      this.checking = false;
    }
  }

  private async fire(rule: AlertRule, message: Message): Promise<void> {
    const at = this.now();
    rule.lastFiredAt = at;
    if (rule.once) rule.enabled = false;
    await this.save();
    const deliveries = await this.deps.notify({ kind: 'alert', ...message });
    const event: AlertEvent = { ruleId: rule.id, at, ...message, deliveredTo: deliveries.filter((d) => d.ok).map((d) => d.channel) };
    this.deps.log?.(`${message.title} → ${event.deliveredTo.join(', ') || 'no channel'}`);
    for (const fn of this.listeners) fn(event);
  }
}
