import { TF_INFO, TIMEFRAMES, type AnnotationPayload, type ForecastSettings, type RelationWindow, type Timeframe } from '@smart-btc/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { BacktestPanel } from './components/BacktestPanel';
import { DataPanel } from './components/DataPanel';
import { ForecastPanel, ForecastSettingsBar } from './components/ForecastPanel';
import { GuidePanel, type GuideSection } from './components/GuidePanel';
import { Header } from './components/Header';
import { LiquidityPanel } from './components/LiquidityPanel';
import { MetricSidebar } from './components/MetricSidebar';
import { OddsPanel } from './components/OddsPanel';
import { PriceChart } from './components/PriceChart';
import { RankingPanel } from './components/RankingPanel';
import { TradePanel } from './components/TradePanel';
import { Async, Loading, Note, Segmented } from './components/ui';
import {
  useAnnotations,
  useBacktest,
  useCandles,
  useForecast,
  useLiquidity,
  useOverview,
  useRelations,
  useSeries,
  useTicker,
  useTradeSetup,
} from './hooks/useData';
import { api } from './lib/api';
import { type TabId, useAppState, useDebounced, useSelections } from './lib/state';

// The Data tab stays reachable from the source-status button in the header.
const TABS: { id: TabId; label: string }[] = [
  { id: 'forecast', label: 'Forecast' },
  { id: 'odds', label: 'Odds' },
  { id: 'trade', label: 'Trade' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'ranking', label: 'Ranking' },
  { id: 'liquidity', label: 'Liquidity' },
  { id: 'guide', label: 'Guide' },
];

export default function App() {
  const { state, patch } = useAppState();
  const qc = useQueryClient();
  const [rankingKey, setRankingKey] = useState<string | null>(null);
  const [guideSection, setGuideSection] = useState<GuideSection>('metrics');
  const [guideFocus, setGuideFocus] = useState<string | null>(null);
  const [relWindow, setRelWindow] = useState<RelationWindow>('all');

  // Everything below (chart, metrics, forecast, backtest) is computed on the selected timeframe.
  const tf = state.settings.timeframe;
  const tfInfo = TF_INFO[tf];
  const range = tfInfo.ranges.find((r) => r.id === state.range) ?? tfInfo.ranges.find((r) => r.id === tfInfo.defaultRange)!;
  const horizon = tfInfo.horizons.includes(state.settings.horizon) ? state.settings.horizon : tfInfo.defaultHorizon;

  const overview = useOverview(tf);
  const ticker = useTicker();
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
  const backtest = useBacktest(backtestReq, barVersion);
  const wantLiquidity = state.layers.swings || state.layers.liquidations || state.layers.walls || state.tab === 'liquidity';
  const liquidity = useLiquidity(wantLiquidity);
  const tradeReq = useDebounced(useMemo(() => ({ settings, ...state.trade, entry: 0 }), [settings, state.trade]), 350);
  const trade = useTradeSetup(tradeReq, state.tab === 'trade', priceVersion);

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
  // A new timeframe needs its own horizon, chart range and typical stop/target distances.
  const setTimeframe = (next: Timeframe) => {
    if (next === tf) return;
    const info = TF_INFO[next];
    patch({
      settings: { ...state.settings, timeframe: next, horizon: info.defaultHorizon },
      range: info.defaultRange,
      trade: { ...state.trade, ...info.bracket },
    });
  };

  const header = (
    <Header
      ticker={ticker.data}
      overview={overview.data}
      onRefresh={() => refresh.mutate()}
      refreshing={refresh.isPending}
      onOpenData={() => patch({ tab: 'data' })}
      explain={state.explain}
      onExplain={(explain) => patch({ explain })}
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
              <div className="mt-1 text-mute">Start both processes with <code className="text-ink2">npm run dev</code> in the project folder.</div>
            </Note>
          ) : (
            <Loading label={overview.error?.message ?? 'Downloading 15 years of price and on-chain history. This takes a few seconds on first start…'} />
          )}
          {tf !== '1d' && (
            <button onClick={() => setTimeframe('1d')} className="mt-2 text-xs text-[#7fb2f0] underline-offset-2 hover:underline">
              Switch to the daily timeframe meanwhile
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
  const collapsed = state.sidebarCollapsed;

  return (
    <div className="min-h-screen">
      {header}

      {/* From tablet width up the forecast always has the right-hand column. The metrics panel sits beside the chart
          on wide screens and under it on medium ones, and can be collapsed to hand its space to the chart. */}
      <main
        className={clsx(
          'mx-auto grid max-w-[1900px] grid-cols-1 items-start gap-3 p-3 md:grid-cols-[minmax(0,1fr)_340px] lg:grid-cols-[minmax(0,1fr)_380px]',
          collapsed ? 'wide:grid-cols-[minmax(0,1fr)_420px] xwide:grid-cols-[minmax(0,1fr)_450px]' : 'wide:grid-cols-[250px_minmax(0,1fr)_400px] xwide:grid-cols-[270px_minmax(0,1fr)_450px]',
        )}
      >
        {/* metrics: beside the chart on wide screens, under it on medium ones so the forecast keeps the right-hand column */}
        {!collapsed && (
        <div className="thin-scroll order-3 md:col-start-1 md:row-start-2 wide:sticky wide:top-[60px] wide:row-span-2 wide:row-start-1 wide:max-h-[calc(100vh-72px)] wide:overflow-y-auto">
          <MetricSidebar
            metrics={ov.metrics}
            annotations={ov.annotations}
            enabledAnnotations={state.annotations}
            snapshot={ov.snapshot}
            visible={visible}
            model={model}
            layers={state.layers}
            onToggleVisible={(id) => patch({ visible: toggle(visible, id) })}
            onToggleModel={(id) => patch({ model: toggle(model, id) })}
            onToggleAnnotation={toggleAnnotation}
            onOpenGuide={openGuide}
            onLayers={(layers) => patch({ layers })}
            onCollapse={() => patch({ sidebarCollapsed: true })}
            explain={state.explain}
            onResetSelections={() => patch({ visible: null, model: null })}
          />
        </div>
        )}

        {/* chart */}
        <div className={clsx('order-1 min-w-0 md:col-start-1 md:row-start-1', !collapsed && 'wide:col-start-2')}>
          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => patch({ sidebarCollapsed: !collapsed })}
                  aria-expanded={!collapsed}
                  title={collapsed ? 'Show the metrics panel' : 'Hide the metrics panel'}
                  className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink2 hover:bg-raised"
                >
                  {collapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />} {collapsed ? 'Show metrics' : 'Hide metrics'}
                </button>
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink2">Bitcoin</h2>
                <Segmented
                  label="Timeframe"
                  size="sm"
                  value={tf}
                  onChange={setTimeframe}
                  options={TIMEFRAMES.map((t) => ({ value: t, label: TF_INFO[t].label }))}
                />
              </div>
              <Segmented
                label="Chart range"
                size="sm"
                value={range.id}
                onChange={(id) => patch({ range: id })}
                options={tfInfo.ranges.map((r) => ({ value: r.id, label: r.id }))}
              />
            </header>
            {switching && (
              <div className="border-b border-line px-3">
                <Loading label={overview.error?.message ?? `Loading the ${tfInfo.label} timeframe…`} />
              </div>
            )}
            {candles.data ? (
              <PriceChart
                candles={candles.data}
                ticker={ticker.data}
                metrics={ov.metrics}
                visible={visible}
                series={series.data}
                forecast={forecastOk}
                liquidity={liquidity.data}
                annotationDefs={annotationDefs}
                annotationData={annotationData}
                layers={state.layers}
                tf={tf}
                rangeBars={range.bars}
                explain={state.explain}
              />
            ) : (
              <div className="px-3">
                {candles.error && !/download/i.test(candles.error.message) ? (
                  <div className="py-4"><Note tone="error">{candles.error.message}</Note></div>
                ) : (
                  <Loading label={candles.error?.message ?? `Loading ${tfInfo.label} candles…`} />
                )}
              </div>
            )}
          </section>
          <p className="mt-2 px-1 text-[11px] leading-relaxed text-mute">
            Drag to pan, pinch or Ctrl/⌘ + scroll to zoom, drag the divider between panes to resize them. The timeframe applies to the chart, the price indicators and the forecast alike; on-chain and derivatives metrics are daily figures on every timeframe.
            {state.explain ? ' Rest the cursor on a line, level or metric for an explanation; the "Hints" switch in the header turns this off.' : ''}
          </p>
        </div>

        {/* analysis */}
        <div
          className={clsx(
            'thin-scroll order-2 flex min-w-0 flex-col gap-3 [&>*]:shrink-0 md:sticky md:top-[60px] md:col-start-2 md:row-span-2 md:row-start-1 md:max-h-[calc(100vh-72px)] md:overflow-y-auto',
            !collapsed && 'wide:col-start-3 wide:row-span-1',
          )}
        >
          <ForecastSettingsBar settings={{ ...state.settings, horizon }} onChange={(s) => patch({ settings: s })} />

          <div role="tablist" className="thin-scroll flex gap-0.5 overflow-x-auto rounded-lg border border-line bg-panel p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={state.tab === t.id}
                onClick={() => patch({ tab: t.id })}
                className={clsx(
                  'flex-1 whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  state.tab === t.id ? 'bg-raised text-ink' : 'text-mute hover:text-ink2',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {noInputs && state.tab !== 'liquidity' && state.tab !== 'data' && state.tab !== 'guide' ? (
            <Note tone="warn">No model inputs selected. Turn on at least one metric with the chip icon in the metrics list.</Note>
          ) : (
            <>
              {state.tab === 'forecast' && (
                <Async query={forecast} loadingLabel="Searching history for similar setups…">
                  {(f) => <ForecastPanel forecast={f} backtest={backtest.error ? undefined : backtest.data} backtestPending={backtest.isFetching} onOpenBacktest={() => patch({ tab: 'backtest' })} />}
                </Async>
              )}
              {state.tab === 'odds' && (
                <Async query={forecast} loadingLabel="Searching history for similar setups…">
                  {(f) => <OddsPanel forecast={f} />}
                </Async>
              )}
              {state.tab === 'trade' && <TradePanel form={state.trade} onChange={(tradeForm) => patch({ trade: tradeForm })} query={trade} price={ticker.data?.price ?? ov.price} />}
              {state.tab === 'backtest' && <BacktestPanel query={backtest} params={state.backtest} onParams={(p) => patch({ backtest: p })} />}
              {state.tab === 'ranking' && (
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
          {state.tab === 'liquidity' && (
            <Async query={liquidity} loadingLabel="Reading order books and estimating liquidation levels…">
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
          {state.tab === 'data' && <DataPanel overview={ov} onRefresh={() => refresh.mutate()} refreshing={refresh.isPending} />}
        </div>
      </main>
    </div>
  );
}
