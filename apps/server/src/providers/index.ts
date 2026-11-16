import { bgeometrics } from './bgeometrics.js';
import { binance15m, binance1h, binance4h, binanceFutures, binanceSpot } from './binance.js';
import { bitstamp } from './bitstamp.js';
import { coinmetrics } from './coinmetrics.js';
import { binancePremium, bybit, cftc, deribitOptions, hyperliquid, yahoo } from './extra.js';
import { defillama, deribit, fearGreed } from './misc.js';
import { blockchainCom, coinbase, fred, kraken, mempool, okx } from './more.js';
import type { Provider } from './types.js';

/** Register new data sources here; everything downstream discovers them through the store. */
export const providers: Provider[] = [
  binanceSpot,
  bitstamp,
  coinbase,
  kraken,
  binance4h,
  binance1h,
  binance15m,
  binanceFutures,
  coinmetrics,
  bgeometrics,
  fearGreed,
  deribit,
  defillama,
  bybit,
  binancePremium,
  yahoo,
  cftc,
  deribitOptions,
  hyperliquid,
  okx,
  blockchainCom,
  mempool,
  fred,
];

export const PROVIDER_BY_ID = new Map(providers.map((p) => [p.id, p]));

export type { Provider } from './types.js';
