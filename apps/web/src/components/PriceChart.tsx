import {
  TF_INFO,
  addBars,
  durationLabel,
  type AnnotationDef,
  type AnnotationPayload,
  type AnnotationSegment,
  type Candle,
  type ForecastResult,
  type LiquidityLevel,
  type LiquidityReport,
  type MetricDef,
  type SeriesPayload,
  type Ticker,
  type Timeframe,
} from '@smart-btc/shared';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type LineData,
  type PriceFormat,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtBarTime, fmtCompactUsd, fmtMetric, fmtPct, fmtUsd } from '../lib/format';
import { SERIES, UI } from '../lib/palette';
import type { Layers } from '../lib/state';

/** Explanation shown when the cursor rests on a line, level or marker (if "explain on hover" is on). */
interface Tip {
  title: string;
  text: string;
}
const MAIN_HEIGHT = 440;
const PANE_HEIGHT = 132;

interface Props {
  candles: Candle[];
  ticker?: Ticker;
  metrics: MetricDef[];
  visible: string[];
  series?: SeriesPayload;
  forecast?: ForecastResult;
  liquidity?: LiquidityReport;
  /** Enabled annotations, and the payloads that have loaded so far. */
  annotationDefs: AnnotationDef[];
  annotationData: AnnotationPayload[];
  layers: Layers;
  tf: Timeframe;
  /** Bars shown initially, counted back from the latest one (0 = everything loaded). */
  rangeBars: number;
  /** Explain lines, levels and markers on hover. */
  explain: boolean;
}

interface PaneSpec {
  id: string;
  metrics: MetricDef[];
}

const priceFormatFor = (m: MetricDef): PriceFormat => {
  switch (m.unit) {
    case 'usd':
      return { type: 'custom', minMove: 1, formatter: (p: number) => fmtCompactUsd(p) };
    case 'price':
      return { type: 'price', precision: 0, minMove: 1 };
    case 'ratio':
      return { type: 'price', precision: 2, minMove: 0.01 };
    case 'pct':
      return { type: 'custom', minMove: 0.01, formatter: (p: number) => `${p.toFixed(1)}%` };
    default:
      return { type: 'price', precision: 0, minMove: 1 };
  }
};

type Refs = {
  chart: IChartApi;
  candle: ISeriesApi<'Candlestick'>;
  lines: Map<string, ISeriesApi<'Line'>>;
  cone: ISeriesApi<'Line'>[];
  priceLines: IPriceLine[];
  annots: Map<string, { bullish: ISeriesApi<'Line'>; bearish: ISeriesApi<'Line'>; markers: ISeriesMarkersPluginApi<Time> }>;
};

/**
 * Turn two-point segments into one line series. The library joins every point of a series, so the
 * stretch between two unrelated segments is drawn transparent: a point's colour applies to the line
 * leaving it, hence each segment end is transparent unless the next segment starts there.
 */
function segmentLine(segs: AnnotationSegment[], color: string): LineData[] {
  const out: LineData[] = [];
  let lastT = -Infinity;
  for (const s of [...segs].sort((a, b) => a.t1 - b.t1)) {
    if (s.t1 < lastT) continue;
    if (s.t1 > lastT) out.push({ time: s.t1 as UTCTimestamp, value: s.v1, color });
    else out[out.length - 1].color = color;
    out.push({ time: s.t2 as UTCTimestamp, value: s.v2, color: 'transparent' });
    lastT = s.t2;
  }
  return out;
}

export function PriceChart({ candles, ticker, metrics, visible, series, forecast, liquidity, annotationDefs, annotationData, layers, tf, rangeBars, explain }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const refs = useRef<Refs | null>(null);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const [paneTops, setPaneTops] = useState<number[]>([0]);
  const [tip, setTip] = useState<(Tip & { x: number; y: number }) | null>(null);
  // What each drawn object means, looked up when the chart reports the object under the cursor.
  const tips = useRef({ series: new Map<unknown, Tip>(), objects: new Map<string, Tip>() });
  const explainRef = useRef(explain);
  explainRef.current = explain;
  const intraday = tf === '15m' || tf === '1h' || tf === '4h';

  const { overlays, panes } = useMemo(() => {
    const vis = metrics.filter((m) => visible.includes(m.id));
    const overlays = vis.filter((m) => m.display === 'overlay');
    const panes: PaneSpec[] = [];
    for (const m of vis.filter((x) => x.display === 'pane')) {
      const id = m.pane ?? m.id;
      const p = panes.find((x) => x.id === id);
      if (p) p.metrics.push(m);
      else panes.push({ id, metrics: [m] });
    }
    return { overlays, panes };
  }, [metrics, visible]);

  // Annotations only exist on the chart while their metric's pane is shown.
  const activeAnnots = annotationDefs.filter((a) => panes.some((p) => p.metrics.some((m) => m.id === a.metricId)));
  const annotKey = activeAnnots.map((a) => a.id).join(',');
  const structureKey = `${overlays.map((m) => m.id).join(',')}|${panes.map((p) => `${p.id}:${p.metrics.map((m) => m.id).join('+')}`).join(',')}|${layers.cone}|${annotKey}|${tf}`;
  const height = MAIN_HEIGHT + panes.length * PANE_HEIGHT;

  // ── build the chart skeleton whenever the set of visible series changes ──
  useEffect(() => {
    if (!el.current) return;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: UI.panel },
        textColor: UI.mute,
        fontSize: 11,
        fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        panes: { separatorColor: UI.line, separatorHoverColor: 'rgba(57,135,229,0.25)', enableResize: true },
      },
      grid: { vertLines: { color: UI.grid }, horzLines: { color: UI.grid } },
      rightPriceScale: { borderColor: UI.line, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderColor: UI.line, rightOffset: 4, minBarSpacing: 0.3, timeVisible: intraday, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: UI.mute, width: 1, style: LineStyle.Dashed, labelBackgroundColor: UI.raised },
        horzLine: { color: UI.mute, width: 1, style: LineStyle.Dashed, labelBackgroundColor: UI.raised },
      },
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UI.up,
      downColor: UI.down,
      wickUpColor: UI.up,
      wickDownColor: UI.down,
      borderVisible: false,
      priceLineColor: UI.mute,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });

    const seriesTips = new Map<unknown, Tip>();
    const objectTips = new Map<string, Tip>();
    const metricTip = (m: MetricDef): Tip => ({ title: m.name, text: [m.description, m.guide?.read[0]].filter(Boolean).join(' ') });

    const lines = new Map<string, ISeriesApi<'Line'>>();
    for (const m of overlays) {
      for (const id of [m.id, ...(m.companions ?? [])]) {
        const s = chart.addSeries(LineSeries, {
          color: SERIES[m.colorSlot],
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerRadius: 3,
          priceFormat: priceFormatFor(m),
        });
        lines.set(id, s);
        seriesTips.set(s, metricTip(m));
      }
    }
    panes.forEach((p, i) => {
      for (const m of p.metrics) {
        const s = chart.addSeries(
          LineSeries,
          {
            color: SERIES[m.colorSlot],
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerRadius: 3,
            priceFormat: priceFormatFor(m),
          },
          i + 1,
        );
        lines.set(m.id, s);
        seriesTips.set(s, metricTip(m));
        // Companion lines of a pane metric (e.g. its ±1σ bands): thinner, in their own colour.
        for (const cid of m.companions ?? []) {
          const info = m.companionInfo?.[cid];
          const cs = chart.addSeries(
            LineSeries,
            { color: SERIES[info?.colorSlot ?? m.colorSlot], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: priceFormatFor(m) },
            i + 1,
          );
          lines.set(cid, cs);
          seriesTips.set(cs, { title: `${m.short} · ${info?.label ?? cid}`, text: m.guide?.read[cid.endsWith('Lower') ? 1 : 0] ?? m.description });
        }
      }
      // Reference levels (e.g. RSI 30/70) belong to the pane, so draw them once on its first series.
      const first = lines.get(p.metrics[0].id)!;
      const seen = new Set<number>();
      for (const m of p.metrics) {
        for (const b of m.bands ?? []) {
          if (seen.has(b.value)) continue;
          seen.add(b.value);
          const id = `band:${m.id}:${b.value}`;
          first.createPriceLine({
            id,
            price: b.value,
            color: UI.mute,
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: false,
            title: b.label,
          });
          objectTips.set(id, { title: `${m.short} ${b.value}${b.label ? ` · ${b.label}` : ''}`, text: `Reference level for ${m.name}. ${m.guide?.read[0] ?? m.description}` });
        }
      }
    });

    const annots: Refs['annots'] = new Map();
    for (const a of activeAnnots) {
      const paneIndex = panes.findIndex((p) => p.metrics.some((m) => m.id === a.metricId)) + 1;
      const host = lines.get(a.metricId);
      if (!host) continue;
      const mk = (color: string) =>
        chart.addSeries(
          LineSeries,
          { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
          paneIndex,
        );
      const entry = { bullish: mk(UI.up), bearish: mk(UI.down), markers: createSeriesMarkers(host, [], { autoScale: false }) };
      annots.set(a.id, entry);
      for (const kind of ['bullish', 'bearish'] as const) {
        const t: Tip = { title: `${kind === 'bullish' ? 'Bullish' : 'Bearish'} · ${a.name}`, text: `${a.description} The line joins the two turning points being compared; the arrow marks the second one.` };
        seriesTips.set(entry[kind], t);
        objectTips.set(`ann:${a.id}:${kind}`, t);
      }
    }

    const cone: ISeriesApi<'Line'>[] = [];
    if (layers.cone) {
      const styles: [LineStyle, 1 | 2][] = [
        [LineStyle.Dotted, 1],
        [LineStyle.Dashed, 1],
        [LineStyle.Solid, 2],
        [LineStyle.Dashed, 1],
        [LineStyle.Dotted, 1],
      ];
      const coneTips: Tip[] = [
        { title: '80% band · lower edge', text: 'Eight in ten modelled outcomes stay between the two dotted lines. Only about one in ten ends below this one.' },
        { title: '50% band · lower edge', text: 'Half of the modelled outcomes fall between the two dashed lines.' },
        { title: 'Forecast median', text: 'The middle of the modelled paths: half of them are above this line and half below. It is not a prediction of the path price will take.' },
        { title: '50% band · upper edge', text: 'Half of the modelled outcomes fall between the two dashed lines.' },
        { title: '80% band · upper edge', text: 'Eight in ten modelled outcomes stay between the two dotted lines. Only about one in ten ends above this one.' },
      ];
      styles.forEach(([lineStyle, lineWidth], i) => {
        const s = chart.addSeries(LineSeries, {
          color: UI.ink2,
          lineStyle,
          lineWidth,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceFormat: { type: 'price', precision: 0, minMove: 1 },
        });
        cone.push(s);
        seriesTips.set(s, coneTips[i]);
      });
    }
    tips.current.series = seriesTips;
    // Band tips are rebuilt with the skeleton; level tips (targets, liquidity) are added by their own effect.
    for (const key of [...tips.current.objects.keys()]) if (key.startsWith('band:') || key.startsWith('ann:')) tips.current.objects.delete(key);
    for (const [key, value] of objectTips) tips.current.objects.set(key, value);

    const chartPanes = chart.panes();
    chartPanes.forEach((p, i) => p.setStretchFactor(i === 0 ? MAIN_HEIGHT : PANE_HEIGHT));

    const measure = () => {
      const tops: number[] = [];
      let y = 0;
      for (const p of chart.panes()) {
        tops.push(y);
        y += p.getHeight() + 1;
      }
      setPaneTops((prev) => (prev.length === tops.length && prev.every((v, i) => Math.abs(v - tops[i]) < 1) ? prev : tops));
    };
    // Cursor position relative to the chart box, tracked separately because the chart reports it per pane.
    const cursor = { x: 0, y: 0 };
    chart.subscribeCrosshairMove((param) => {
      setHoverT(typeof param.time === 'number' ? param.time : null);
      measure();
      const found = explainRef.current && param.point
        ? ((param.hoveredObjectId != null && tips.current.objects.get(String(param.hoveredObjectId))) || (param.hoveredSeries && tips.current.series.get(param.hoveredSeries)) || null)
        : null;
      setTip((prev) => (found ? { ...found, x: cursor.x, y: cursor.y } : prev ? null : prev));
    });
    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    ro.observe(el.current);

    // A plain wheel scrolls the page (the chart is tall); zooming needs Ctrl/Cmd or a trackpad pinch,
    // and a sideways swipe pans. Intercept in the capture phase so the chart never sees plain wheels.
    const host = el.current;
    const onWheel = (e: WheelEvent) => {
      const zoomIntent = e.ctrlKey || e.metaKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!zoomIntent) e.stopPropagation();
    };
    host.addEventListener('wheel', onWheel, { capture: true, passive: true });
    const onMove = (e: MouseEvent) => {
      const box = host.getBoundingClientRect();
      cursor.x = e.clientX - box.left;
      cursor.y = e.clientY - box.top;
    };
    const onLeave = () => setTip(null);
    host.addEventListener('mousemove', onMove, { capture: true, passive: true });
    host.addEventListener('mouseleave', onLeave);
    requestAnimationFrame(measure);

    refs.current = { chart, candle, lines, cone, priceLines: [], annots };
    return () => {
      ro.disconnect();
      host.removeEventListener('wheel', onWheel, { capture: true });
      host.removeEventListener('mousemove', onMove, { capture: true });
      host.removeEventListener('mouseleave', onLeave);
      refs.current = null;
      chart.remove();
    };
    // The skeleton only depends on which series exist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey]);

  // ── data ──
  useEffect(() => {
    const r = refs.current;
    if (!r || candles.length === 0) return;
    r.candle.setData(candles.map((c) => ({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
  }, [candles, structureKey]);

  useEffect(() => {
    const r = refs.current;
    if (!r || !series) return;
    // Lines such as Supertrend take their colour from which side of price they are on.
    const colorById = new Map(metrics.filter((m) => m.colorByPrice).map((m) => [m.id, true]));
    const closeByT = new Map(candles.map((k) => [k.t, k.c]));
    for (const [id, line] of r.lines) {
      const values = series.series[id];
      if (!values) {
        line.setData([]);
        continue;
      }
      let first = values.findIndex((v) => v != null);
      if (first < 0) {
        line.setData([]);
        continue;
      }
      let last = values.length - 1;
      while (last > first && values[last] == null) last--;
      const data: (LineData | WhitespaceData)[] = [];
      const byPrice = colorById.get(id);
      for (let i = first; i <= last; i++) {
        const v = values[i];
        const time = series.t[i] as UTCTimestamp;
        if (v == null) data.push({ time });
        else if (byPrice) data.push({ time, value: v, color: v <= (closeByT.get(series.t[i]) ?? v) ? UI.up : UI.down });
        else data.push({ time, value: v });
      }
      line.setData(data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, structureKey, candles]);

  useEffect(() => {
    const r = refs.current;
    if (!r || r.cone.length === 0) return;
    const keys = ['p10', 'p25', 'p50', 'p75', 'p90'] as const;
    r.cone.forEach((s, i) => {
      s.setData(forecast ? forecast.cone.map((c) => ({ time: c.t as UTCTimestamp, value: c[keys[i]] })) : []);
    });
  }, [forecast, structureKey]);

  // ── annotations (e.g. RSI divergences): segments joining the two pivots, plus an arrow at the second ──
  useEffect(() => {
    const r = refs.current;
    if (!r) return;
    for (const [id, a] of r.annots) {
      const payload = annotationData.find((p) => p.id === id);
      const segs = payload?.segments ?? [];
      a.bullish.setData(segmentLine(segs.filter((s) => s.kind === 'bullish'), UI.up));
      a.bearish.setData(segmentLine(segs.filter((s) => s.kind === 'bearish'), UI.down));
      const markers: SeriesMarker<Time>[] = segs.map((s) => ({
        id: `ann:${id}:${s.kind}`,
        time: s.t2 as UTCTimestamp,
        position: s.kind === 'bullish' ? 'belowBar' : 'aboveBar',
        shape: s.kind === 'bullish' ? 'arrowUp' : 'arrowDown',
        color: s.kind === 'bullish' ? UI.up : UI.down,
      }));
      a.markers.setMarkers(markers);
      // Once the history is loaded, the hover explanation also says how past signals played out.
      const def = annotationDefs.find((d) => d.id === id);
      for (const st of payload?.stats ?? []) {
        if (!def) continue;
        const dir = st.kind === 'bullish' ? 'up' : 'down';
        const past = st.move
          ? ` After the ${st.move.n} earlier ${st.kind} signals on this timeframe, the move ${dir} lasted ${durationLabel(tf, st.move.avgBars)} on average (median ${durationLabel(tf, st.move.medianBars)}) from confirmation to its best point, for a typical ${st.move.medianPct.toFixed(1)}%, measured within ${durationLabel(tf, st.move.lookahead)}.`
          : ' There are no earlier signals of this kind on this timeframe to measure.';
        const info: Tip = { title: `${st.label} · ${def.name}`, text: `${st.kind === 'bullish' ? 'Price made a lower low while RSI made a higher low: selling is losing force.' : 'Price made a higher high while RSI made a lower high: buying is losing force.'}${past}` };
        tips.current.series.set(a[st.kind], info);
        tips.current.objects.set(`ann:${id}:${st.kind}`, info);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationData, structureKey]);

  // ── live price on the open candle ──
  useEffect(() => {
    const r = refs.current;
    const last = candles[candles.length - 1];
    if (!r || !last || !ticker) return;
    if (ticker.at / 1000 > addBars(tf, last.t, 1) + 600) return; // a new bar started; wait for the next sync
    r.candle.update({
      time: last.t as UTCTimestamp,
      open: last.o,
      high: Math.max(last.h, ticker.price),
      low: Math.min(last.l, ticker.price),
      close: ticker.price,
    });
  }, [ticker, candles, structureKey, tf]);

  // ── visible range ──
  const lastT = candles.length ? candles[candles.length - 1].t : 0;
  const firstT = candles.length ? candles[0].t : 0;
  const horizon = layers.cone && forecast ? forecast.settings.horizon : 0;
  const seriesReady = !!series;
  const nBars = candles.length;
  useEffect(() => {
    const r = refs.current;
    if (!r || !lastT) return;
    const from = rangeBars > 0 ? candles[Math.max(0, nBars - rangeBars)].t : firstT;
    // Leave room on the right for the forecast cone, or a few empty bars without it.
    const to = addBars(tf, lastT, Math.max(horizon, Math.ceil((rangeBars || nBars) * 0.03)) + 2);
    // Wait a frame so every series has its data before the range is applied.
    const id = requestAnimationFrame(() => {
      try {
        refs.current?.chart.timeScale().setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp });
      } catch {
        /* chart not ready yet */
      }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeBars, lastT, firstT, nBars, horizon, structureKey, seriesReady, tf]);

  useEffect(() => {
    refs.current?.candle.priceScale().applyOptions({
      mode: layers.logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [layers.logScale, structureKey]);

  // ── horizontal levels: scenario targets and liquidity ──
  useEffect(() => {
    const r = refs.current;
    if (!r) return;
    for (const pl of r.priceLines) r.candle.removePriceLine(pl);
    r.priceLines = [];
    const objects = tips.current.objects;
    for (const key of [...objects.keys()]) if (key.startsWith('level:')) objects.delete(key);
    const add = (price: number, color: string, title: string, lineStyle: LineStyle, info: Tip) => {
      const id = `level:${r.priceLines.length}`;
      r.priceLines.push(r.candle.createPriceLine({ id, price, color, title, lineStyle, lineWidth: 1, axisLabelVisible: true }));
      objects.set(id, info);
    };
    if (layers.targets && forecast) {
      for (const s of forecast.scenarios) {
        if (s.id === 'range' || s.probability < 0.03) continue;
        add(s.targetPrice, s.id === 'rally' ? UI.up : UI.down, `${s.label} target · ${Math.round(s.probability * 100)}%`, LineStyle.LargeDashed, {
          title: `${s.label} scenario target · ${fmtUsd(s.targetPrice)}`,
          text: `Median outcome of the ${s.label.toLowerCase()} scenario, which the model gives ${Math.round(s.probability * 100)}% (base rate ${Math.round(s.baseProbability * 100)}%). ${s.description}`,
        });
      }
    }
    if (liquidity) {
      const pick = (levels: LiquidityLevel[], n: number, by: 'near' | 'strong') =>
        (['buy-side', 'sell-side'] as const).flatMap((side) =>
          levels
            .filter((l) => l.side === side)
            .sort((a, b) => (by === 'near' ? Math.abs(a.distancePct) - Math.abs(b.distancePct) : b.strength - a.strength))
            .slice(0, n),
        );
      const where = (l: LiquidityLevel) => `${fmtUsd(l.price)} (${fmtPct(l.distancePct)})`;
      if (layers.swings) {
        for (const l of pick(liquidity.swings, 3, 'near')) {
          add(l.price, UI.ink2, l.side === 'buy-side' ? 'Stops above' : 'Stops below', LineStyle.Dashed, {
            title: `Liquidity pool · ${l.label} at ${where(l)}`,
            text: `${l.detail}. Stop orders tend to cluster just beyond a swing ${l.side === 'buy-side' ? 'high' : 'low'} that price has not revisited, so price is often drawn there and can reverse once they are triggered.`,
          });
        }
      }
      if (layers.liquidations) {
        for (const l of pick(liquidity.liquidations, 3, 'strong')) {
          add(l.price, SERIES[3], `Est. ${l.side === 'buy-side' ? 'short' : 'long'} liqs ${fmtCompactUsd(l.notionalUsd)}`, LineStyle.Dotted, {
            title: `${l.label} near ${where(l)}`,
            text: `About ${fmtCompactUsd(l.notionalUsd)} of leveraged ${l.side === 'buy-side' ? 'shorts' : 'longs'} would be force-closed around here, which adds fuel to a move that reaches it. ${l.detail}.`,
          });
        }
      }
      if (layers.walls) {
        for (const l of pick(liquidity.walls, 2, 'strong')) {
          add(l.price, SERIES[6], `${l.label} ${fmtCompactUsd(l.notionalUsd)}`, LineStyle.SparseDotted, {
            title: `${l.label} at ${where(l)}`,
            text: `${fmtCompactUsd(l.notionalUsd)} of resting ${l.side === 'buy-side' ? 'sell' : 'buy'} orders (${l.detail}). Large walls can slow or stall price, but they can also be pulled before it arrives.`,
          });
        }
      }
    }
  }, [forecast, liquidity, layers.targets, layers.swings, layers.liquidations, layers.walls, structureKey]);

  // ── legend values at the crosshair (or latest) ──
  const idxByT = useMemo(() => new Map(candles.map((c, i) => [c.t, i])), [candles]);
  const hoverIdx = hoverT != null ? idxByT.get(hoverT) : undefined;
  const bar = candles[hoverIdx ?? candles.length - 1];
  const prev = candles[(hoverIdx ?? candles.length - 1) - 1];
  const liveClose = hoverIdx == null && ticker ? ticker.price : bar?.c;
  const valueOf = (id: string): number | null => {
    const values = series?.series[id];
    if (!values) return null;
    if (hoverIdx != null) return values[hoverIdx] ?? null;
    for (let i = values.length - 1; i >= Math.max(0, values.length - 45); i--) if (values[i] != null) return values[i];
    return null;
  };
  const coneAtHover = hoverT != null && forecast ? forecast.cone.find((c) => c.t === hoverT) : undefined;

  return (
    <div className="relative" style={{ height }}>
      <div ref={el} className="absolute inset-0" />

      {/* explanation of the line, level or marker under the cursor */}
      {tip && explain && (
        <div
          className="pointer-events-none absolute z-20 w-64 rounded-md border border-line bg-raised px-2.5 py-2 text-[11px] leading-relaxed shadow-lg"
          style={{ left: Math.max(4, Math.min(tip.x + 14, (el.current?.clientWidth ?? 600) - 340)), top: Math.max(4, Math.min(tip.y + 14, height - 150)) }}
        >
          <div className="font-medium text-ink">{tip.title}</div>
          <div className="mt-0.5 text-ink2">{tip.text}</div>
        </div>
      )}

      {/* main pane legend */}
      <div className="pointer-events-none absolute left-2 top-1.5 z-10 flex max-w-[calc(100%-90px)] flex-col gap-0.5 text-[11px]">
        {bar && (
          <div className="num flex flex-wrap items-center gap-x-2 text-ink2">
            <span className="font-semibold text-ink">BTC/USD · {TF_INFO[tf].label}</span>
            <span className="text-mute">{fmtBarTime(hoverT ?? bar.t, tf)}</span>
            {!coneAtHover && (
              <>
                <span>O {fmtUsd(bar.o)}</span>
                <span>H {fmtUsd(Math.max(bar.h, liveClose ?? bar.h))}</span>
                <span>L {fmtUsd(Math.min(bar.l, liveClose ?? bar.l))}</span>
                <span>C {fmtUsd(liveClose)}</span>
                {prev && liveClose != null && (
                  <span className={liveClose >= prev.c ? 'text-up' : 'text-down'}>{fmtPct((liveClose / prev.c - 1) * 100, 2)}</span>
                )}
              </>
            )}
            {coneAtHover && (
              <span>
                Forecast +{durationLabel(tf, coneAtHover.day)}: median {fmtUsd(coneAtHover.p50)} · 50% band {fmtUsd(coneAtHover.p25)}–{fmtUsd(coneAtHover.p75)} · 80% band{' '}
                {fmtUsd(coneAtHover.p10)}–{fmtUsd(coneAtHover.p90)}
              </span>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-ink2">
          {overlays.map((m) => (
            <span key={m.id} className="num flex items-center gap-1">
              <span className="h-0.5 w-3 rounded" style={{ background: SERIES[m.colorSlot], height: 3 }} />
              {m.short} <span className="text-ink">{fmtMetric(valueOf(m.id), m.unit)}</span>
            </span>
          ))}
          {layers.cone && forecast && (
            <span className="flex items-center gap-1">
              <span className="w-3 rounded" style={{ background: UI.ink2, height: 3 }} />
              {durationLabel(tf, forecast.settings.horizon)} forecast: median (solid), 50% band (dashed), 80% band (dotted)
            </span>
          )}
        </div>
      </div>

      {/* one legend per indicator pane */}
      {panes.map((p, i) => (
        <div
          key={p.id}
          className="pointer-events-none absolute left-2 z-10 flex flex-wrap items-center gap-x-3 text-[11px] text-ink2"
          style={{ top: (paneTops[i + 1] ?? MAIN_HEIGHT + i * PANE_HEIGHT) + 5 }}
        >
          {p.metrics.map((m) => (
            <span key={m.id} className="num flex items-center gap-1">
              <span className="w-3 rounded" style={{ background: SERIES[m.colorSlot], height: 3 }} />
              {m.name} <span className="text-ink">{fmtMetric(valueOf(m.id), m.unit)}</span>
              {m.delayedDays ? <span className="text-mute">(source lags {m.delayedDays}d)</span> : null}
              {Object.entries(m.companionInfo ?? {}).map(([cid, info]) => (
                <span key={cid} className="ml-1 flex items-center gap-1">
                  <span className="w-3 rounded" style={{ background: SERIES[info.colorSlot], height: 2 }} />
                  {info.label} <span className="text-ink">{fmtMetric(valueOf(cid), m.unit)}</span>
                </span>
              ))}
            </span>
          ))}
          {activeAnnots
            .filter((a) => p.metrics.some((m) => m.id === a.metricId))
            .map((a) => (
              <span key={a.id} className="flex items-center gap-1">
                <span className="w-3 rounded" style={{ background: UI.up, height: 3 }} />
                bullish
                <span className="ml-1 w-3 rounded" style={{ background: UI.down, height: 3 }} />
                bearish divergence
              </span>
            ))}
        </div>
      ))}
    </div>
  );
}
