import { DEFAULT_FORECAST_SETTINGS, pickLang, type ForecastSettings, type HeatmapWindow, type Lang, type MetricDef } from '@smart-btc/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

export type TabId = 'forecast' | 'models' | 'events' | 'odds' | 'trade' | 'backtest' | 'ranking' | 'liquidity' | 'guide' | 'data';

export interface Layers {
  cone: boolean;
  targets: boolean;
  swings: boolean;
  liquidations: boolean;
  walls: boolean;
  logScale: boolean;
  /** Traded volume as bars along the bottom of the price pane. */
  volume: boolean;
}

export interface TradeForm {
  side: 'long' | 'short';
  stopPct: number;
  takePct: number;
  leverage: number;
  accountUsd: number;
  riskPct: number;
  feeBps: number;
  /** Stop as a % of price, or as a multiple of the average true range. */
  stopMode: 'pct' | 'atr';
  stopAtr: number;
  /** Target as a % of price, or as a multiple of the stop distance (R). */
  takeMode: 'pct' | 'r';
  takeR: number;
  /** Share of full Kelly used for the suggested risk per trade. */
  kellyFraction: number;
  /** Confidence level of Value at Risk / Expected Shortfall. */
  confidence: number;
}

export interface AppState {
  /** Interface language. */
  lang: Lang;
  /** Metric ids drawn on the chart. null = catalogue defaults. */
  visible: string[] | null;
  /** Metric ids used as model inputs. null = catalogue defaults. */
  model: string[] | null;
  /** Enabled chart annotations (e.g. RSI divergences). */
  annotations: string[];
  settings: Omit<ForecastSettings, 'features'>;
  layers: Layers;
  /** Selected time view (one of VIEWS in App): it sets both the bar size and the stretch of history shown. */
  range: string;
  /** What the central panel shows. */
  center: 'chart' | 'heatmap';
  /** Stretch of history shown on the liquidation heatmap. */
  heatmapWindow: HeatmapWindow;
  /** Show explanations when hovering metrics and chart lines. */
  explain: boolean;
  /** Hide the metrics panel to give the chart and the forecast the full width. */
  sidebarCollapsed: boolean;
  /** Widths (px) the side panels were dragged to; null = the default for the screen size. */
  panelWidths: { left: number | null; right: number | null };
  tab: TabId;
  trade: TradeForm;
  backtest: { stepBars: number; touchPct: number };
}

const { features: _unused, ...baseSettings } = DEFAULT_FORECAST_SETTINGS;

export const DEFAULT_STATE: AppState = {
  lang: pickLang(typeof navigator !== 'undefined' ? navigator.languages?.join(',') || navigator.language : 'en'),
  visible: null,
  model: null,
  annotations: [],
  settings: baseSettings,
  layers: { cone: true, targets: true, swings: true, liquidations: false, walls: false, logScale: false, volume: true },
  range: '1y',
  center: 'chart',
  heatmapWindow: '2w',
  explain: true,
  sidebarCollapsed: false,
  panelWidths: { left: null, right: null },
  tab: 'forecast',
  trade: { side: 'long', stopPct: 5, takePct: 10, leverage: 3, accountUsd: 10_000, riskPct: 1, feeBps: 5, stopMode: 'pct', stopAtr: 2, takeMode: 'pct', takeR: 2, kellyFraction: 0.25, confidence: 0.95 },
  backtest: { stepBars: 3, touchPct: 0 },
};

const KEY = 'smart-btc:state:v1';

function load(): AppState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_STATE;
    const saved = JSON.parse(raw) as Partial<AppState>;
    // Merge field by field so new settings added in later versions get their defaults,
    // and keep only known keys so fields renamed since an older version do not linger.
    const pick = <T extends object>(defaults: T, from: Partial<T> | undefined): T => {
      const out = { ...defaults };
      for (const key of Object.keys(defaults) as (keyof T)[]) {
        if (from && from[key] !== undefined) out[key] = from[key] as T[keyof T];
      }
      return out;
    };
    return {
      ...DEFAULT_STATE,
      ...saved,
      settings: pick(DEFAULT_STATE.settings, saved.settings),
      layers: pick(DEFAULT_STATE.layers, saved.layers),
      trade: pick(DEFAULT_STATE.trade, saved.trade),
      panelWidths: pick(DEFAULT_STATE.panelWidths, saved.panelWidths),
      // States saved before timeframes existed scored a fixed 10% touch level; start those on "automatic".
      backtest: saved.backtest && 'stepBars' in saved.backtest ? pick(DEFAULT_STATE.backtest, saved.backtest) : DEFAULT_STATE.backtest,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

/** UI state, persisted in localStorage so the workspace survives reloads. */
export function useAppState() {
  const [state, setState] = useState<AppState>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* private mode: keep working without persistence */
    }
  }, [state]);
  const patch = useCallback((p: Partial<AppState>) => setState((s) => ({ ...s, ...p })), []);
  const reset = useCallback(() => setState(DEFAULT_STATE), []);
  return { state, patch, reset };
}

/** Resolve the null "use defaults" selections against the metric catalogue. */
export function useSelections(state: AppState, metrics: MetricDef[] | undefined) {
  return useMemo(() => {
    const all = metrics ?? [];
    const known = new Set(all.map((m) => m.id));
    const visible = (state.visible ?? all.filter((m) => m.defaultVisible).map((m) => m.id)).filter((id) => known.has(id));
    const model = (state.model ?? all.filter((m) => m.defaultInModel).map((m) => m.id)).filter((id) => known.has(id));
    return { visible, model };
  }, [state.visible, state.model, metrics]);
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const key = JSON.stringify(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms]);
  return v;
}
