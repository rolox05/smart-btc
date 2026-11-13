import type {
  HeatmapWindow,
  LiquidationHeatmap,
  AnnotationPayload,
  RelationWindow,
  Relations,
  BacktestRequest,
  BacktestResult,
  BacktestSummary,
  Candle,
  ForecastResult,
  ForecastSettings,
  LiquidityReport,
  Overview,
  SeriesPayload,
  SourceStatus,
  Ticker,
  Timeframe,
  TradeSetupRequest,
  TradeSetupResult,
} from '@smart-btc/shared';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach the local API server. Is it running?', 0);
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(payload?.error ?? `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  overview: (tf: Timeframe) => call<Overview>(`/api/overview?tf=${tf}`),
  ticker: () => call<Ticker>('/api/ticker'),
  candles: (tf: Timeframe) => call<Candle[]>(`/api/candles?tf=${tf}`),
  series: (tf: Timeframe, ids: string[]) => call<SeriesPayload>(`/api/series?tf=${tf}&ids=${ids.join(',')}`),
  liquidity: () => call<LiquidityReport>('/api/liquidity'),
  liquidationHeatmap: (window: HeatmapWindow) => call<LiquidationHeatmap>(`/api/liquidation-heatmap?window=${window}`),
  annotation: (tf: Timeframe, id: string) => call<AnnotationPayload>(`/api/annotations/${encodeURIComponent(id)}?tf=${tf}`),
  relations: (tf: Timeframe, window: RelationWindow, horizon: number, startYear: number) =>
    call<Relations>(`/api/relations?tf=${tf}&window=${window}&horizon=${horizon}&startYear=${startYear}`),
  forecast: (s: ForecastSettings) => call<ForecastResult>('/api/forecast', s),
  backtest: (r: BacktestRequest) => call<BacktestResult>('/api/backtest', r),
  backtestSummary: (r: BacktestRequest) => call<BacktestSummary>('/api/backtest/summary', r),
  tradeSetup: (r: TradeSetupRequest) => call<TradeSetupResult>('/api/trade-setup', r),
  refresh: () => call<SourceStatus[]>('/api/refresh', {}),
};
