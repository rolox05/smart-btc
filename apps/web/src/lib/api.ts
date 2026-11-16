import { getLang, tr } from './i18n';
import type {
  AlertInput,
  AlertRule,
  AppSettingsPatch,
  AppSettingsView,
  ChannelId,
  NotificationDelivery,
  TodaySummary,
  EventsReport,
  HeatmapWindow,
  LiquidationFeed,
  ModelsReport,
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

async function call<T>(path: string, body?: unknown, method?: 'PUT' | 'DELETE'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: body === undefined ? { 'x-lang': getLang() } : { 'content-type': 'application/json', 'x-lang': getLang() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(tr('Cannot reach the local API server. Is it running?'), 0);
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(payload?.error ?? tr('Request failed ({status})', { status: res.status }), res.status);
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
  models: (s: ForecastSettings) => call<ModelsReport>('/api/models', s),
  events: () => call<EventsReport>('/api/events'),
  today: (s: ForecastSettings) => call<TodaySummary>('/api/today', s),
  settings: () => call<AppSettingsView>('/api/settings'),
  saveSettings: (p: AppSettingsPatch) => call<AppSettingsView>('/api/settings', p, 'PUT'),
  alerts: () => call<AlertRule[]>('/api/alerts'),
  createAlert: (input: AlertInput) => call<AlertRule>('/api/alerts', input),
  setAlertEnabled: (id: string, enabled: boolean) => call<AlertRule>(`/api/alerts/${id}`, { enabled }, 'PUT'),
  deleteAlert: (id: string) => call<{ ok: true }>(`/api/alerts/${id}`, undefined, 'DELETE'),
  notifications: () => call<NotificationDelivery[]>('/api/notifications'),
  testNotification: (channel: ChannelId) => call<NotificationDelivery>('/api/notifications/test', { channel }),
  liquidations: () => call<LiquidationFeed>('/api/liquidations'),
  setSourceEnabled: (id: string, enabled: boolean) => call<SourceStatus[]>(`/api/sources/${encodeURIComponent(id)}`, { enabled }, 'PUT'),
  refresh: () => call<SourceStatus[]>('/api/refresh', {}),
};
