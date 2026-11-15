import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ForecastSettings, NotificationMessage, TodaySummary } from '@smart-btc/shared';
import { AlertEngine, liquidationTotals, priceCrossed } from '../src/alerts/engine.js';
import type { Store } from '../src/store/store.js';

function setup(today: () => TodaySummary | null = () => null) {
  const kv = new Map<string, string>();
  const store = { getSetting: async (k: string) => kv.get(k) ?? null, setSetting: async (k: string, v: string) => void kv.set(k, v) } as unknown as Store;
  const sent: NotificationMessage[] = [];
  const clock = { t: 1_800_000_000_000 };
  const make = () =>
    new AlertEngine({
      store,
      notify: async (m) => (sent.push(m), [{ at: clock.t, channel: 'telegram', kind: m.kind, title: m.title, ok: true, error: null }]),
      today: async () => today(),
      now: () => clock.t,
    });
  return { engine: make(), make, sent, clock };
}

const MIN = 60_000;
const SETTINGS = { timeframe: '1d', horizon: 30, features: [] } as unknown as ForecastSettings;

test('price: fires on the tick that crosses the level, from the right side only', () => {
  const above = { direction: 'above' as const, price: 70_000 };
  assert.equal(priceCrossed(above, 69_990, 70_000), true);
  assert.equal(priceCrossed(above, 70_010, 70_020), false);
  assert.equal(priceCrossed(above, 70_010, 69_990), false);
  assert.equal(priceCrossed({ direction: 'below', price: 60_000 }, 60_010, 59_990), true);
});

test('price alert: one message, then the rule switches itself off', async () => {
  const { engine, sent } = setup();
  const rule = await engine.create({ type: 'price', direction: 'above', price: 70_000, once: true }, 'en');
  await engine.onPrice(70_500); // first tick: nothing to cross from
  await engine.onPrice(69_900);
  assert.equal(sent.length, 0);
  await engine.onPrice(70_050);
  await engine.onPrice(69_900);
  await engine.onPrice(70_050);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'BTC crossed above $70,000');
  assert.equal((await engine.list()).find((r) => r.id === rule.id)!.enabled, false);
});

test('price alert: a repeating rule does not flood while price hovers on the level', async () => {
  const { engine, sent, clock } = setup();
  await engine.create({ type: 'price', direction: 'below', price: 60_000, once: false }, 'es');
  await engine.onPrice(60_100);
  await engine.onPrice(59_900);
  await engine.onPrice(60_100);
  await engine.onPrice(59_900);
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /BTC cruzó por debajo de \$60,000/);
  clock.t += 6 * MIN;
  await engine.onPrice(60_100);
  await engine.onPrice(59_900);
  assert.equal(sent.length, 2);
});

test('liquidation alert: sums the window by side and reports a burst once', async () => {
  const { engine, sent, clock } = setup();
  const print = (side: 'long' | 'short', usd: number, agoMin = 0) => ({ t: clock.t - agoMin * MIN, venue: 'Binance' as const, side, price: 60_000, usd });
  assert.deepEqual(liquidationTotals([print('long', 5), print('short', 3), print('long', 9, 20)], clock.t - 10 * MIN), { long: 5, short: 3, any: 8 });

  await engine.create({ type: 'liquidations', side: 'long', minUsd: 5_000_000, windowMin: 10, once: false }, 'en');
  await engine.onPrints([print('short', 9_000_000), print('long', 3_000_000)]);
  assert.equal(sent.length, 0);
  await engine.onPrints([print('long', 2_500_000)]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, '$5.5M of longs liquidated in 10 min');
  await engine.onPrints([print('long', 4_000_000)]);
  assert.equal(sent.length, 1);
  // Once the window has passed, a new burst is news again.
  clock.t += 11 * MIN;
  await engine.onPrints([print('long', 6_000_000)]);
  assert.equal(sent.length, 2);
});

test('reading alert: the first reading is the starting point, a change of lean or edge is reported', async () => {
  let reading = { direction: 'up', edge: 'weak' } as Pick<TodaySummary, 'direction' | 'edge'>;
  const { engine, sent } = setup(() => ({ ...reading, timeframe: '1d', horizon: 30, headline: 'Slight downward lean over 30d', pUp: 0.44, basePUp: 0.57 }) as TodaySummary);
  await engine.create({ type: 'reading', settings: SETTINGS, once: false }, 'en');
  await engine.checkReadings();
  await engine.checkReadings();
  assert.equal(sent.length, 0);
  reading = { direction: 'down', edge: 'weak' };
  await engine.checkReadings();
  await engine.checkReadings();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, 'Reading changed · next 30d');
  assert.match(sent[0].body, /Slight downward lean.*44% chance/);
});

test('rules survive a restart; disabled and removed rules stay quiet', async () => {
  const { engine, make, sent } = setup();
  const a = await engine.create({ type: 'price', direction: 'above', price: 70_000, once: true }, 'en');
  const b = await engine.create({ type: 'price', direction: 'above', price: 70_000, once: true }, 'en');
  const restarted = make();
  assert.equal((await restarted.list()).length, 2);
  await restarted.setEnabled(a.id, false);
  assert.equal(await restarted.remove(b.id), true);
  assert.equal(await restarted.remove(b.id), false);
  await restarted.onPrice(69_000);
  await restarted.onPrice(71_000);
  assert.equal(sent.length, 0);
});
