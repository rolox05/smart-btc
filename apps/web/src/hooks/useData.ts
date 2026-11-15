import type { BacktestRequest, ForecastSettings, HeatmapWindow, RelationWindow, Timeframe, TradeSetupRequest } from '@smart-btc/shared';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { ApiError, api } from '../lib/api';

/** While the first sync is still running the API answers 503; keep polling until it is ready. */
const retry = (count: number, err: Error) => (err instanceof ApiError && err.status === 503 ? count < 80 : count < 1);
const retryDelay = 1500;

export const useOverview = (tf: Timeframe) =>
  useQuery({ queryKey: ['overview', tf], queryFn: () => api.overview(tf), refetchInterval: 60_000, placeholderData: keepPreviousData, retry, retryDelay });

/** `pushed`: the live stream is delivering prices, so polling is only a slow safety net. */
export const useTicker = (pushed: boolean) =>
  useQuery({ queryKey: ['ticker'], queryFn: api.ticker, refetchInterval: pushed ? false : 5_000, retry, retryDelay });

export const useCandles = (tf: Timeframe) =>
  useQuery({ queryKey: ['candles', tf], queryFn: () => api.candles(tf), refetchInterval: tf === '15m' || tf === '1h' ? 60_000 : 120_000, retry, retryDelay });

export const useSeries = (tf: Timeframe, ids: string[]) =>
  useQuery({
    queryKey: ['series', tf, [...ids].sort().join(',')],
    queryFn: () => api.series(tf, ids),
    enabled: ids.length > 0,
    refetchInterval: 120_000,
    // Keep the previous lines while the selection changes, but never across timeframes (different time axis).
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === tf ? prev : undefined),
    retry,
    retryDelay,
  });

export const useLiquidity = (enabled = true) =>
  useQuery({ queryKey: ['liquidity'], queryFn: api.liquidity, refetchInterval: 60_000, enabled, retry, retryDelay });

export const useLiquidationHeatmap = (window: HeatmapWindow, enabled: boolean) =>
  useQuery({
    queryKey: ['liquidation-heatmap', window],
    queryFn: () => api.liquidationHeatmap(window),
    refetchInterval: 120_000,
    enabled,
    placeholderData: keepPreviousData,
    retry,
    retryDelay,
  });

/** Payloads of the given chart annotations; entries are undefined while loading. */
export const useAnnotations = (tf: Timeframe, ids: string[], dataVersion: number | undefined) =>
  useQueries({
    queries: ids.map((id) => ({
      queryKey: ['annotation', tf, id, dataVersion],
      queryFn: () => api.annotation(tf, id),
      staleTime: 10 * 60_000,
      placeholderData: keepPreviousData,
    })),
  });

export const useRelations = (tf: Timeframe, window: RelationWindow, horizon: number, startYear: number, enabled: boolean, dataVersion: number | undefined) =>
  useQuery({
    queryKey: ['relations', tf, window, horizon, startYear, dataVersion],
    queryFn: () => api.relations(tf, window, horizon, startYear),
    enabled,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
    retry,
    retryDelay,
  });

export const useForecast = (settings: ForecastSettings, dataVersion: number | undefined) =>
  useQuery({
    queryKey: ['forecast', settings, dataVersion],
    queryFn: () => api.forecast(settings),
    enabled: settings.features.length > 0,
    placeholderData: keepPreviousData,
    retry,
    retryDelay,
  });

/** The model comparison only needs inputs for the analog model; the other two bring their own. */
export const useModels = (settings: ForecastSettings, enabled: boolean, dataVersion: number | undefined) =>
  useQuery({
    queryKey: ['models', settings, dataVersion],
    queryFn: () => api.models(settings),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
    retry,
    retryDelay,
  });

export const useEvents = (enabled: boolean) =>
  useQuery({ queryKey: ['events'], queryFn: api.events, enabled, staleTime: 15 * 60_000, refetchInterval: 15 * 60_000, retry, retryDelay });

/** `pushed`: the live stream refreshes this on every print; the slow poll only rolls the time windows forward. */
export const useLiveLiquidations = (enabled: boolean, pushed: boolean) =>
  useQuery({ queryKey: ['liquidations'], queryFn: api.liquidations, enabled, refetchInterval: pushed ? 60_000 : 15_000, retry, retryDelay });

export const useBacktest = (req: BacktestRequest, enabled: boolean, dataVersion: number | undefined) =>
  useQuery({
    queryKey: ['backtest', req, dataVersion],
    queryFn: () => api.backtest(req),
    enabled: enabled && req.settings.features.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 10 * 60_000,
    retry,
    retryDelay,
  });

export const useTradeSetup = (req: TradeSetupRequest, enabled: boolean, dataVersion: number | undefined) =>
  useQuery({
    queryKey: ['trade', req, dataVersion],
    queryFn: () => api.tradeSetup(req),
    enabled: enabled && req.settings.features.length > 0,
    placeholderData: keepPreviousData,
    retry,
    retryDelay,
  });
