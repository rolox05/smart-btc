import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FEEDS } from '../src/providers/liquidationStream.js';
import { PriceStream, parseTicker } from '../src/providers/priceStream.js';

test('Binance 24h ticker frames become a Ticker; anything else is ignored', () => {
  const t = parseTicker({ e: '24hrTicker', c: '64910.72', P: '-1.387', h: '66189.88', l: '62006.00', q: '2527845573.95' }, 1000);
  assert.deepEqual(t, { price: 64910.72, change24hPct: -1.387, high24h: 66189.88, low24h: 62006, volume24hUsd: 2527845573.95, source: 'Binance', at: 1000 });
  assert.equal(parseTicker({ result: null, id: 1 }, 1000), null);
  assert.equal(parseTicker({ e: '24hrTicker', c: '0' }, 1000), null);
});

test('a price stream that has not delivered anything reports no price', () => {
  assert.equal(new PriceStream().latest(), null);
});

test('liquidation frames: the side is the position that was force-closed', () => {
  const [binance, bybit] = FEEDS;
  assert.deepEqual(binance.parse({ o: { S: 'SELL', ap: '60000', z: '0.5', T: 5 } }), [{ t: 5, venue: 'Binance', side: 'long', price: 60000, usd: 30000 }]);
  assert.deepEqual(bybit.parse({ topic: 'allLiquidation.BTCUSDT', data: [{ S: 'Sell', p: '60000', v: '0.1', T: 7 }] }), [
    { t: 7, venue: 'Bybit', side: 'short', price: 60000, usd: 6000 },
  ]);
  assert.deepEqual(bybit.parse({ op: 'pong' }), []);
});

test('deadline: a promise that never settles is abandoned, a prompt one passes through', async () => {
  const { withDeadline, DeadlineError, ttlCache } = await import('../src/lib/http.js');
  await assert.rejects(withDeadline(new Promise(() => {}), 20, 'upstream'), DeadlineError);
  assert.equal(await withDeadline(Promise.resolve(7), 20, 'upstream'), 7);

  // A load that hangs (a socket left open across sleep) must not block every later caller.
  let calls = 0;
  const cached = ttlCache(60_000, () => (++calls === 1 ? new Promise<number>(() => {}) : Promise.resolve(42)), 20);
  await assert.rejects(cached(), DeadlineError);
  assert.equal(await cached(), 42);
});
