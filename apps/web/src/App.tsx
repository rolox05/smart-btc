import { TF_INFO, type AnnotationPayload, type ForecastSettings, type RelationWindow, type Timeframe } from '@smart-btc/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { type CSSProperties, Suspense, lazy, useMemo, useState } from 'react';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ForecastPanel, ForecastSettingsBar } from './components/ForecastPanel';
import type { GuideSection } from './components/GuidePanel';
import { Header } from './components/Header';
import { MetricSidebar } from './components/MetricSidebar';
import { PriceChart } from './components/PriceChart';
import { ResizeHandle } from './components/ResizeHandle';
import { TodayCard } from './components/TodayCard';
import { Async, Loading, Note, Segmented } from './components/ui';
import {
  useAnnotations,
  useBacktest,
  useCandles,
  useForecast,
  useLiquidationHeatmap,
  useEvents,
  useLiquidity,
  useLiveLiquidations,
  useModels,
  useOverview,
  useRelations,
  useSeries,
  useTicker,
  useToday,
  useTradeSetup,
} from './hooks/useData';
import { api } from './lib/api';
import { LangProvider, setLang, useT } from './lib/i18n';
import { chartPanes, movePane, placePane } from './lib/panes';
import { type TabId, useAppState, useDebounced, useSelections } from './lib/state';
import { useLiveStream } from './hooks/useLiveStream';

// Everything outside the first screen (chart + forecast) is loaded when its tab or view is first opened.
const BacktestPanel = lazy(() => import('./components/BacktestPanel').then((m) => ({ default: m.BacktestPanel })));
const EventsPanel = lazy(() => import('./components/EventsPanel').then((m) => ({ default: m.EventsPanel })));
const GuidePanel = lazy(() => import('./components/GuidePanel').then((m) => ({ default: m.GuidePanel })));
const LiquidationHeatmapView = lazy(() => import('./components/LiquidationHeatmap').then((m) => ({ default: m.LiquidationHeatmapView })));
const LiquidityPanel = lazy(() => import('./components/LiquidityPanel').then((m) => ({ default: m.LiquidityPanel })));
const LiveLiquidations = lazy(() => import('./components/LiveLiquidations').then((m) => ({ default: m.LiveLiquidations })));
const ModelsPanel = lazy(() => import('./components/ModelsPanel').then((m) => ({ default: m.ModelsPanel })));
const OddsPanel = lazy(() => import('./components/OddsPanel').then((m) => ({ default: m.OddsPanel })));
const RankingPanel = lazy(() => import('./components/RankingPanel').then((m) => ({ default: m.RankingPanel })));
const SettingsPanel = lazy(() => import('./components/SettingsPanel').then((m) => ({ default: m.SettingsPanel })));
const TradePanel = lazy(() => import('./components/TradePanel').then((m) => ({ default: m.TradePanel })));

/**
 * The single time selector. Each entry fixes both the bar size and how much history is on screen:
 * the first six are one bar size each, the rest are daily bars over a longer stretch.
 */
const VIEWS: { id: string; tf: Timeframe; bars: number; hint: string }[] = [
  { id: '15m', tf: '15m', bars: 288, hint: '15-minute bars, last 3 days' },
  { id: '1h', tf: '1h', bars: 336, hint: '1-hour bars, last 2 weeks' },
  { id: '4h', tf: '4h', bars: 540, hint: '4-hour bars, last 3 months' },
  { id: '24h', tf: '1d', bars: 120, hint: 'Daily bars, last 4 months' },
  { id: '1w', tf: '1w', bars: 209, hint: 'Weekly bars, last 4 years' },
  { id: '1m', tf: '1M', bars: 0, hint: 'Monthly bars, all history' },
  { id: '3m', tf: '1d', bars: 92, hint: 'Daily bars, last 3 months' },
  { id: '6m', tf: '1d', bars: 183, hint: 'Daily bars, last 6 months' },
  { id: '1y', tf: '1d', bars: 365, hint: 'Daily bars, last year' },
  { id: '2y', tf: '1d', bars: 730, hint: 'Daily bars, last 2 years' },
  { id: '4y', tf: '1d', bars: 1461, hint: 'Daily bars, last 4 years' },
  { id: 'All', tf: '1d', bars: 0, hint: 'Daily bars, all history' },
];

/** Evidence groups everything that answers "how far can this be trusted": the models, their backtest and the input ranking. */
const TABS: { id: TabId; label: string }[] = [
  { id: 'forecast', label: 'Forecast' },
  { id: 'trade', label: 'Trade' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'events', label: 'Events' },
  { id: 'liquidity', label: 'Liquidity' },
  { id: 'guide', label: 'Guide' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const { state, patch } = useAppState();
  // The language must be in place before any child (formatters, query keys) reads it during this render.
  setLang(state.lang);
  return (
    <LangProvider value={state.lang}>
      <Workspace state={state} patch={patch} />
    </LangProvider>
  );
}

function Workspace({ state, patch }: Pick<ReturnType<typeof useAppState>, 'state' | 'patch'>) {
  const { t, dur } = useT();
  const qc = useQueryClient();
  const [rankingKey, setRankingKey] = useState<string | null>(null);
  const [guideSection, setGuideSection] = useState<GuideSection>('metrics');
  const [guideFocus, setGuideFocus] = useState<string | null>(null);
  const [relWindow, setRelWindow] = useState<RelationWindow>('all');

  // Everything below (chart, metrics, forecast, backtest) is computed on the selected timeframe.
  const tf = state.settings.timeframe;
  const tfInfo = TF_INFO[tf];
  // The saved view must agree with the saved timeframe; if it does not (older saved state), fall back to that timeframe's view.
  const saved = VIEWS.find((v) => v.id === state.range);
  const view = saved && saved.tf === tf ? saved : VIEWS.find((v) => v.tf === tf)!;
  const horizon = tfInfo.horizons.includes(state.settings.horizon) ? state.settings.horizon : tfInfo.defaultHorizon;

  const overview = useOverview(tf);
  const live = useLiveStream();
  const ticker = useTicker(live.pushed);
  const candles = useCandles(tf);
  const metrics = overview.data?.metrics;
  const { visible, model } = useSelections(state, metrics);

  // Series needed by the chart: visible metrics plus companions (e.g. the lower Bollinger band).
  const seriesIds = useMemo(() => {
    const ids = new Set<string>();
    for (const m of metrics ?? []) {
      if (!visible.includes(m.id)) continue;
      ids.add(m.id);
      for (const c of m.companions ?? []) ids.add(c);
    }
    return [...ids];
  }, [metrics, visible]);
  const series = useSeries(tf, seriesIds);

  const settings: ForecastSettings = useDebounced(
    useMemo(() => ({ ...state.settings, horizon, features: model }), [state.settings, horizon, model]),
    350,
  );
  const fresh = overview.data?.timeframe === tf ? overview.data : undefined;
  const priceVersion = fresh?.price;
  const barVersion = fresh?.asOf;
  const forecast = useForecast(settings, priceVersion);
  const backtestReq = useDebounced(useMemo(() => ({ settings, ...state.backtest }), [settings, state.backtest]), 350);
  const backtest = useBacktest(backtestReq, state.tab === 'forecast' || (state.tab === 'evidence' && state.evidenceView === 'backtest'), barVersion);
  const wantLiquidity = state.layers.swings || state.layers.liquidations || state.layers.walls || state.tab === 'liquidity';
  const liquidity = useLiquidity(wantLiquidity);
  const heatmap = useLiquidationHeatmap(state.heatmapWindow, state.center === 'heatmap');
  const tradeReq = useDebounced(useMemo(() => ({ settings, ...state.trade, entry: 0 }), [settings, state.trade]), 350);
  const trade = useTradeSetup(tradeReq, state.tab === 'trade', priceVersion);
  const models = useModels(settings, state.tab === 'evidence' && state.evidenceView === 'models', barVersion);
  const today = useToday(settings, barVersion);
  const events = useEvents(state.tab === 'events');
  const liveLiquidations = useLiveLiquidations(state.tab === 'liquidity', live.pushed);

  // Chart annotations (e.g. RSI divergences) that are switched on and known to the server.
  const annotationDefs = useMemo(
    () => (overview.data?.annotations ?? []).filter((a) => state.annotations.includes(a.id)),
    [overview.data?.annotations, state.annotations],
  );
  const annotationQueries = useAnnotations(
    tf,
    annotationDefs.map((a) => a.id),
    barVersion,
  );
  const annotationStamp = annotationQueries.map((q) => q.dataUpdatedAt).join(',');
  const annotationData = useMemo(
    () => annotationQueries.map((q) => q.data).filter((d): d is AnnotationPayload => d !== undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [annotationStamp],
  );
  const relations = useRelations(tf, relWindow, settings.horizon, settings.startYear, state.tab === 'guide', barVersion);

  const refresh = useMutation({
    mutationFn: api.refresh,
    onSettled: () => qc.invalidateQueries(),
  });

  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  // Indicator charts under the price chart, in the user's order; the ones switched off stay in the list.
  const panes = chartPanes(metrics ?? [], visible, state.paneOrder, state.hiddenPanes);
  // Charts that are not on right now keep the place they were given, after the ones on screen.
  const setPaneOrder = (ids: string[]) => patch({ paneOrder: [...ids, ...state.paneOrder.filter((x) => !ids.includes(x))] });
  const reorderPane = (id: string, dir: -1 | 1, amongShown: boolean) => setPaneOrder(movePane(panes, id, dir, amongShown));
  const dropPane = (id: string, targetId: string, after: boolean) => setPaneOrder(placePane(panes, id, targetId, after));
  const togglePane = (id: string) => patch({ hiddenPanes: toggle(state.hiddenPanes, id) });
  const toggleVisible = (id: string) => {
    // Switching a metric on also brings back its chart if that was turned off as a whole.
    const paneId = metrics?.find((m) => m.id === id)?.pane ?? id;
    patch({ visible: toggle(visible, id), ...(!visible.includes(id) ? { hiddenPanes: state.hiddenPanes.filter((x) => x !== paneId) } : {}) });
  };
  const toggleAnnotation = (id: string) => {
    const turningOn = !state.annotations.includes(id);
    const metricId = overview.data?.annotations.find((a) => a.id === id)?.metricId;
    // An annotation lives on its metric's pane, so switching it on also shows that metric.
    patch({
      annotations: toggle(state.annotations, id),
      ...(turningOn && metricId && !visible.includes(metricId) ? { visible: [...visible, metricId] } : {}),
    });
  };
  const openGuide = (metricId?: string) => {
    setGuideSection('metrics');
    if (metricId) setGuideFocus(metricId);
    patch({ tab: 'guide' });
  };
  // Choosing a view with another bar size also resets the horizon and the typical stop/target distances.
  const setView = (id: string) => {
    const next = VIEWS.find((v) => v.id === id);
    if (!next) return;
    if (next.tf === tf) return patch({ range: id });
    const info = TF_INFO[next.tf];
    patch({
      range: id,
      settings: { ...state.settings, timeframe: next.tf, horizon: info.defaultHorizon },
      trade: { ...state.trade, ...info.bracket },
    });
  };
  const setTimeframe = (next: Timeframe) => setView(VIEWS.find((v) => v.tf === next)!.id);

  const header = (
    <Header
      ticker={ticker.data}
      overview={overview.data}
      onRefresh={() => refresh.mutate()}
      refreshing={refresh.isPending}
      onOpenData={() => patch({ tab: 'settings' })}
      explain={state.explain}
      onExplain={(explain) => patch({ explain })}
      lang={state.lang}
      onLang={(lang) => patch({ lang })}
    />
  );

  // First start: the server is still downloading history.
  if (!overview.data) {
    const downloading = !overview.error || /download/i.test(overview.error.message);
    return (
      <div className="min-h-screen">
        {header}
        <div className="mx-auto max-w-md px-4 py-24">
          {!downloading && overview.failureCount > 3 ? (
            <Note tone="error">
              {overview.error?.message}
              <div className="mt-1 text-mute">{t('Start both processes with npm run dev in the project folder.')}</div>
            </Note>
          ) : (
            <Loading label={overview.error?.message ?? t('Downloading 15 years of price and on-chain history. This takes a few seconds on first start…')} />
          )}
          {tf !== '1d' && (
            <button onClick={() => setTimeframe('1d')} className="mt-2 text-xs text-[#7fb2f0] underline-offset-2 hover:underline">
              {t('Switch to the daily timeframe meanwhile')}
            </button>
          )}
        </div>
      </div>
    );
  }

  const ov = overview.data;
  // While another timeframe loads, the previous one stays on screen; say so instead of mislabelling it.
  const switching = ov.timeframe !== tf;
  const forecastOk = forecast.data && !forecast.error && forecast.data.settings.timeframe === tf ? forecast.data : undefined;
  const noInputs = model.length === 0;
  // Levels belong to the timeframe and horizon they were computed for; while those change, none are drawn.
  const todayOk = today.data && today.data.timeframe === tf && today.data.horizon === settings.horizon ? today.data : undefined;
  const tradeOk = trade.data && !trade.error && !noInputs ? { side: trade.data.side, stopPrice: trade.data.stopPrice, takePrice: trade.data.takePrice } : undefined;
  const needsInputs = state.tab === 'forecast' || state.tab === 'trade' || (state.tab === 'evidence' && state.evidenceView !== 'models');
  const collapsed = state.sidebarCollapsed;
  const boundary = { title: t('This panel could not be displayed'), retryLabel: t('Try again') };
  const widths = state.panelWidths;
  const setWidth = (side: 'left' | 'right', w: number | null) => patch({ panelWidths: { ...widths, [side]: w } });
  // Dragged widths override the per-breakpoint defaults that the grid classes fall back to.
  const gridVars = {
    ...(widths.left != null ? { '--panel-left': `${widths.left}px` } : {}),
    ...(widths.right != null ? { '--panel-right': `${widths.right}px` } : {}),
  } as CSSProperties;

  return (
    <div className="min-h-screen">
      {header}
      {live.alert && (
        <div role="alert" className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-accent bg-raised p-3 shadow-xl">
          <div className="flex items-start justify-between gap-2">
            <div className="text-xs font-semibold text-ink">{live.alert.title}</div>
            <button onClick={live.dismissAlert} aria-label={t('Dismiss')} className="-mt-0.5 text-mute hover:text-ink">×</button>
          </div>
          <div className="mt-1 text-[11.5px] leading-relaxed text-ink2">{live.alert.body}</div>
          <div className="mt-1 text-[10.5px] text-mute">
            {live.alert.deliveredTo.length ? t('Sent to {channels}.', { channels: live.alert.deliveredTo.join(', ') }) : t('Shown here only: no channel is switched on.')}
          </div>
        </div>
      )}

      {/* From tablet width up the forecast always has the right-hand column. The metrics panel sits beside the chart
          on wide screens and under it on medium ones, and can be collapsed to hand its space to the chart. */}
      <main
        data-resizable-grid
        style={gridVars}
        className={clsx(
          'mx-auto grid max-w-[1900px] grid-cols-1 items-start gap-3 p-3 md:grid-cols-[minmax(0,1fr)_var(--panel-right,340px)] lg:grid-cols-[minmax(0,1fr)_var(--panel-right,380px)]',
          collapsed
            ? 'wide:grid-cols-[minmax(0,1fr)_var(--panel-right,420px)] xwide:grid-cols-[minmax(0,1fr)_var(--panel-right,450px)]'
            : 'wide:grid-cols-[var(--panel-left,250px)_minmax(0,1fr)_var(--panel-right,400px)] xwide:grid-cols-[var(--panel-left,270px)_minmax(0,1fr)_var(--panel-right,450px)]',
        )}
      >
        {/* metrics: beside the chart on wide screens, under it on medium ones so the forecast keeps the right-hand column */}
        {!collapsed && (
        <div className="relative order-3 min-w-0 md:col-start-1 md:row-start-2 wide:sticky wide:top-[60px] wide:row-span-2 wide:row-start-1">
          <div className="thin-scroll wide:max-h-[calc(100vh-72px)] wide:overflow-y-auto">
          <ErrorBoundary {...boundary} resetKey={tf}>
          <MetricSidebar
            metrics={ov.metrics}
            annotations={ov.annotations}
            enabledAnnotations={state.annotations}
            snapshot={ov.snapshot}
            visible={visible}
            model={model}
            layers={state.layers}
            panes={panes}
            collapsedPanels={state.collapsedPanels}
            onCollapsedPanels={(collapsedPanels) => patch({ collapsedPanels })}
            onMovePane={(id, dir) => reorderPane(id, dir, false)}
            onPlacePane={dropPane}
            onTogglePane={togglePane}
            onToggleVisible={toggleVisible}
            onToggleModel={(id) => patch({ model: toggle(model, id) })}
            onToggleAnnotation={toggleAnnotation}
            onOpenGuide={openGuide}
            onLayers={(layers) => patch({ layers })}
            onCollapse={() => patch({ sidebarCollapsed: true })}
            explain={state.explain}
            onResetSelections={() => patch({ visible: null, model: null, paneOrder: [], hiddenPanes: [] })}
          />
          </ErrorBoundary>
          </div>
          <ResizeHandle
            edge="right"
            cssVar="--panel-left"
            min={200}
            max={520}
            label={t('Drag to resize the panel (double-click to reset)')}
            onCommit={(w) => setWidth('left', w)}
            className="hidden wide:block"
          />
        </div>
        )}

        {/* chart */}
        <div data-center-panel className={clsx('order-1 min-w-0 md:col-start-1 md:row-start-1', !collapsed && 'wide:col-start-2')}>
          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => patch({ sidebarCollapsed: !collapsed })}
                  aria-expanded={!collapsed}
                  title={collapsed ? t('Show the metrics panel') : t('Hide the metrics panel')}
                  className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink2 hover:bg-raised"
                >
                  {collapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />} {collapsed ? t('Show metrics') : t('Hide metrics')}
                </button>
                <Segmented
                  label={t('Central panel')}
                  size="sm"
                  value={state.center}
                  onChange={(center) => patch({ center })}
                  options={[
                    { value: 'chart', label: t('Price chart') },
                    { value: 'heatmap', label: t('Liquidation heatmap') },
                  ]}
                />
              </div>
              {state.center === 'chart' && (
                <div className="thin-scroll max-w-full overflow-x-auto" title={t('{hint}. The first six set the bar size; 3m to All show daily bars over a longer stretch.', { hint: t(view.hint) })}>
                  <Segmented label={t('Time')} size="sm" value={view.id} onChange={setView} options={VIEWS.map((v) => ({ value: v.id, label: v.id === 'All' ? t('All') : v.id }))} />
                </div>
              )}
            </header>
            <ErrorBoundary {...boundary} resetKey={`${state.center}:${tf}:${state.heatmapWindow}`}>
            <Suspense fallback={<div className="px-3"><Loading /></div>}>
            {state.center === 'heatmap' ? (
              heatmap.data ? (
                <LiquidationHeatmapView heatmap={heatmap.data} window={state.heatmapWindow} onWindow={(heatmapWindow) => patch({ heatmapWindow })} loading={heatmap.isFetching && heatmap.data.window !== state.heatmapWindow} />
              ) : (
                <div className="px-3">{heatmap.error ? <div className="py-4"><Note tone="error">{heatmap.error.message}</Note></div> : <Loading label={t('Estimating liquidation levels…')} />}</div>
              )
            ) : (
            <>
            {switching && (
              <div className="border-b border-line px-3">
                <Loading label={overview.error?.message ?? t('Loading the {tf} timeframe…', { tf: tfInfo.label })} />
              </div>
            )}
            {candles.data ? (
              <PriceChart
                candles={candles.data}
                ticker={ticker.data}
                keyLevels={todayOk?.levels}
                trade={tradeOk}
                horizonLabel={dur(tf, settings.horizon)}
                paneOrder={state.paneOrder}
                hiddenPanes={state.hiddenPanes}
                onMovePane={(id, dir) => reorderPane(id, dir, true)}
                onPlacePane={dropPane}
                onHidePane={togglePane}
                metrics={ov.metrics}
                visible={visible}
                series={series.data}
                forecast={forecastOk}
                liquidity={liquidity.data}
                annotationDefs={annotationDefs}
                annotationData={annotationData}
                layers={state.layers}
                tf={tf}
                rangeBars={view.bars}
                explain={state.explain}
              />
            ) : (
              <div className="px-3">
                {candles.error && !/download/i.test(candles.error.message) ? (
                  <div className="py-4"><Note tone="error">{candles.error.message}</Note></div>
                ) : (
                  <Loading label={candles.error?.message ?? t('Loading {tf} candles…', { tf: tfInfo.label })} />
                )}
              </div>
            )}
            </>
            )}
            </Suspense>
            </ErrorBoundary>
          </section>
          <p className="mt-2 px-1 text-[11px] leading-relaxed text-mute">
            {t('Drag to pan, scroll or pinch on the chart to zoom, drag the divider between panes to resize them. The time setting fixes the bar size ({tf} now) and applies to the chart, the price indicators and the forecast alike; on-chain and derivatives metrics are daily figures on every timeframe.', { tf: tfInfo.label })}
            {state.explain ? ` ${t('Rest the cursor on a line, level or metric for an explanation; the "Hints" switch in the header turns this off.')}` : ''}
          </p>
        </div>

        {/* analysis */}
        <div
          className={clsx(
            'relative order-2 min-w-0 md:sticky md:top-[60px] md:col-start-2 md:row-span-2 md:row-start-1',
            !collapsed && 'wide:col-start-3 wide:row-span-1',
          )}
        >
        <ResizeHandle
          edge="left"
          cssVar="--panel-right"
          min={300}
          max={900}
          label={t('Drag to resize the panel (double-click to reset)')}
          onCommit={(w) => setWidth('right', w)}
          className="hidden md:block"
        />
        <div className="thin-scroll flex min-w-0 flex-col gap-3 [&>*]:shrink-0 md:max-h-[calc(100vh-72px)] md:overflow-y-auto">
          <ForecastSettingsBar settings={{ ...state.settings, horizon }} onChange={(s) => patch({ settings: s })} />
          <ErrorBoundary {...boundary} resetKey={`today:${tf}`}>
            <TodayCard query={today} collapsed={state.todayCollapsed} onCollapsed={(todayCollapsed) => patch({ todayCollapsed })} />
          </ErrorBoundary>

          <div role="tablist" className="flex flex-wrap gap-0.5 rounded-lg border border-line bg-panel p-1">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={state.tab === tab.id}
                onClick={() => patch({ tab: tab.id })}
                className={clsx(
                  'flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  state.tab === tab.id ? 'bg-raised text-ink' : 'text-mute hover:text-ink2',
                )}
              >
                {t(tab.label)}
              </button>
            ))}
          </div>

          <ErrorBoundary {...boundary} resetKey={`${state.tab}:${tf}`}>
          <Suspense fallback={<Loading />}>
          {state.tab === 'forecast' && (
            <Segmented
              label={t('Forecast section')}
              size="sm"
              value={state.forecastView}
              onChange={(forecastView) => patch({ forecastView })}
              options={[
                { value: 'outlook', label: t('Outlook') },
                { value: 'odds', label: t('Odds') },
              ]}
            />
          )}
          {state.tab === 'evidence' && (
            <Segmented
              label={t('Evidence section')}
              size="sm"
              value={state.evidenceView}
              onChange={(evidenceView) => patch({ evidenceView })}
              options={[
                { value: 'models', label: t('Models') },
                { value: 'backtest', label: t('Backtest') },
                { value: 'ranking', label: t('Ranking') },
              ]}
            />
          )}
          {noInputs && needsInputs ? (
            <Note tone="warn">{t('No model inputs selected. Turn on at least one metric with the chip icon in the metrics list.')}</Note>
          ) : (
            <>
              {state.tab === 'forecast' && (
                <Async query={forecast} loadingLabel={t('Searching history for similar setups…')}>
                  {(f) =>
                    state.forecastView === 'odds' ? (
                      <OddsPanel forecast={f} />
                    ) : (
                      <ForecastPanel forecast={f} backtest={backtest.error ? undefined : backtest.data} backtestPending={backtest.isFetching} onOpenBacktest={() => patch({ tab: 'evidence', evidenceView: 'backtest' })} />
                    )
                  }
                </Async>
              )}
              {state.tab === 'trade' && <TradePanel form={state.trade} onChange={(tradeForm) => patch({ trade: tradeForm })} query={trade} price={ticker.data?.price ?? ov.price} />}
              {state.tab === 'evidence' && state.evidenceView === 'backtest' && <BacktestPanel query={backtest} params={state.backtest} onParams={(p) => patch({ backtest: p })} />}
              {state.tab === 'evidence' && state.evidenceView === 'ranking' && (
                <RankingPanel
                  metrics={ov.metrics}
                  model={model}
                  settings={settings}
                  params={state.backtest}
                  dataVersion={barVersion}
                  armedKey={rankingKey}
                  onArm={setRankingKey}
                  onToggleModel={(id) => patch({ model: toggle(model, id) })}
                />
              )}
            </>
          )}
          {state.tab === 'evidence' && state.evidenceView === 'models' && (
            <Async query={models} loadingLabel={t('Fitting and back-testing the three models…')}>
              {(m) => <ModelsPanel report={m} />}
            </Async>
          )}
          {state.tab === 'events' && (
            <Async query={events} loadingLabel={t('Loading the event calendar…')}>
              {(e) => <EventsPanel report={e} />}
            </Async>
          )}
          {state.tab === 'liquidity' && liveLiquidations.data && <LiveLiquidations feed={liveLiquidations.data} />}
          {state.tab === 'liquidity' && (
            <Async query={liquidity} loadingLabel={t('Reading order books and estimating liquidation levels…')}>
              {(l) => <LiquidityPanel report={l} />}
            </Async>
          )}
          {state.tab === 'guide' && (
            <GuidePanel
              section={guideSection}
              onSection={setGuideSection}
              focusId={guideFocus}
              onFocus={setGuideFocus}
              metrics={ov.metrics}
              snapshot={ov.snapshot}
              annotations={ov.annotations}
              enabledAnnotations={state.annotations}
              annotationData={annotationData}
              onToggleAnnotation={toggleAnnotation}
              relations={relations}
              window={relWindow}
              onWindow={setRelWindow}
              tf={tf}
            />
          )}
          {state.tab === 'settings' && (
            <SettingsPanel
              overview={ov}
              onRefresh={() => refresh.mutate()}
              refreshing={refresh.isPending}
              lang={state.lang}
              onLang={(lang) => patch({ lang })}
              explain={state.explain}
              onExplain={(explain) => patch({ explain })}
              layers={state.layers}
              onLayers={(layers) => patch({ layers })}
              forecastSettings={settings}
              price={ticker.data?.price ?? ov.price}
            />
          )}
          </Suspense>
          </ErrorBoundary>
        </div>
        </div>
      </main>
    </div>
  );
}
