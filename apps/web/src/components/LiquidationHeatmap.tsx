import { HEATMAP_WINDOWS, TF_INFO, type HeatmapWindow, type LiquidationHeatmap as Heatmap } from '@smart-btc/shared';
import clsx from 'clsx';
import { RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { fmtCompactUsd, fmtUsd } from '../lib/format';
import { LOCALE, useT } from '../lib/i18n';
import { UI } from '../lib/palette';
import { Note, Segmented } from './ui';

const HEIGHT = 560;
const AXIS_LEFT = 44;
const AXIS_RIGHT = 60;
const AXIS_BOTTOM = 22;
const MAP_W = 170;
/** Colours of the long and short sides: curves, key levels and the side lists. */
const LONG_COLOR = '#e25c5c';
const SHORT_COLOR = '#3fcf8e';
/** Cells at least this large on screen print their estimate inside them. */
const CELL_TEXT_W = 34;
const CELL_TEXT_H = 13;
/** Rows above and below, and columns either side, shown in the tooltip grid. */
const GRID_ROWS = 3;
const GRID_COLS = 2;
/** Colour scale defaults: nothing hidden, full brightness at 85% of the largest clusters. */
const DEFAULT_LO = 0;
const DEFAULT_HI = 0.85;
const FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';
/** Colour-scale curve: above 1 keeps the many small cells dark. */
const GAMMA = 1.6;

/**
 * Coinglass-style ramp: empty price levels stay deep purple, and growing liquidation size moves
 * through blue and teal to green and bright yellow for the largest clusters (a viridis-like scale,
 * which also stays readable for colour-blind viewers).
 */
const STOPS: [number, number, number][] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
];
function ramp(v: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, v)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((k) => Math.round(STOPS[i][k] + (STOPS[i + 1][k] - STOPS[i][k]) * f)) as [number, number, number];
}
const rgb = (c: [number, number, number]) => `rgb(${c.join(',')})`;
/** Dark text on bright cells, light text on dark ones. */
const inkOn = (c: [number, number, number]) => (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 140 ? '#111110' : '#f0efec');
const GRADIENT = `linear-gradient(to right, ${STOPS.map((s, i) => `${rgb(s)} ${(i / (STOPS.length - 1)) * 100}%`).join(', ')})`;

/**
 * Lookup table for an intensity range, as shares of the largest clusters. Cells below `lo` are hidden
 * (drawn as empty) and everything from `hi` up is drawn at full brightness, as on Coinglass. Most cells hold
 * a modest estimate (the median is about a third of the top), so a gamma above 1 keeps them dark blue and
 * lets the real clusters stand out in green and yellow instead of washing the whole map in teal.
 */
function makeLut(lo: number, hi: number): [number, number, number][] {
  const top = Math.max(lo + 0.05, hi);
  return Array.from({ length: 256 }, (_, v) => {
    const x = v / 255;
    if (v === 0 || x < lo) return STOPS[0];
    return ramp(Math.pow(Math.min(1, (x - lo) / (top - lo)), GAMMA));
  });
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compact amount without the currency sign, for cell labels: 56M, 9.4M, 820K. */
function shortUsd(x: number): string {
  if (x >= 1e9) return `${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(x >= 1e7 ? 0 : 1)}M`;
  if (x >= 1e3) return `${Math.round(x / 1e3)}K`;
  return `${Math.round(x)}`;
}

const signedPct = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}%`;

type PriceStyle = 'candles' | 'line' | 'off';
type Prefs = { lo: number; hi: number; showMap: boolean; keyLevels: boolean; keyRange: number; price: PriceStyle };
const DEFAULT_PREFS: Prefs = { lo: DEFAULT_LO, hi: DEFAULT_HI, showMap: true, keyLevels: true, keyRange: 3, price: 'candles' };
const PREFS_KEY = 'smart-btc:heatmap:v1';

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    const num = (x: unknown, d: number, a: number, b: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(a, Math.min(b, x)) : d);
    return {
      lo: p.v === 3 ? num(p.lo, DEFAULT_LO, 0, 0.9) : DEFAULT_LO,
      // Version 2 kept a single threshold: where the colour scale tops out.
      hi: p.v === 3 ? num(p.hi, DEFAULT_HI, 0.05, 1) : p.v === 2 ? num(p.threshold, DEFAULT_HI, 0.05, 1) : DEFAULT_HI,
      showMap: p.showMap !== false,
      keyLevels: p.keyLevels !== false,
      keyRange: [0, 1, 3, 5].includes(p.keyRange) ? p.keyRange : 3,
      price: ['candles', 'line', 'off'].includes(p.price) ? p.price : 'candles',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

type Level = { row: number; price: number; usd: number; side: 'long' | 'short' };

/**
 * Local peaks of the outstanding liquidation profile between two rows, biggest first, at least `gap` rows
 * apart, so one thick band counts once instead of filling the list with its neighbouring rows.
 */
function peaks(values: ArrayLike<number>, from: number, to: number, gap: number, side: Level['side'], priceOf: (r: number) => number): Level[] {
  const found: Level[] = [];
  for (let r = from; r <= to; r++) {
    const v = values[r];
    if (!(v > 0)) continue;
    let top = true;
    for (let k = 1; k <= gap && top; k++) if ((r - k >= from && values[r - k] > v) || (r + k <= to && values[r + k] > v)) top = false;
    if (top) found.push({ row: r, price: priceOf(r), usd: v, side });
  }
  found.sort((a, b) => b.usd - a.usd);
  const out: Level[] = [];
  for (const f of found) if (!out.some((o) => Math.abs(o.row - f.row) <= gap)) out.push(f);
  return out;
}

/** Visible part of the map: a column range (fractional) and a price range. */
type View = { c0: number; c1: number; p0: number; p1: number };

/**
 * Estimated liquidation levels through time, drawn as a heatmap with the price on top, and beside it the
 * liquidation map: what is still outstanding at each price now, with cumulative totals from the current
 * price outwards. Below: the key levels on each side and a summary of what is outstanding.
 */
export function LiquidationHeatmapView({ heatmap, window: windowId, onWindow, loading }: { heatmap: Heatmap; window: HeatmapWindow; onWindow: (w: HeatmapWindow) => void; loading: boolean }) {
  const { t, lang, dur: durOf } = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState<{ window: HeatmapWindow; view: View } | null>(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const updatePrefs = (p: Partial<Prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ ...next, v: 3 }));
      } catch {
        /* private mode */
      }
      return next;
    });

  const cells = useMemo(() => decode(heatmap.data), [heatmap.data]);
  const lut = useMemo(() => makeLut(prefs.lo, prefs.hi), [prefs.lo, prefs.hi]);
  const tf = heatmap.timeframe;
  const cols = heatmap.t.length;
  const R = heatmap.rows;
  const step = heatmap.priceStep;
  const yMin = heatmap.priceMin;
  const yMax = heatmap.priceMin + R * step;
  const last = heatmap.candles[cols - 1];
  const usdOf = (b: number) => (b / 255) * heatmap.maxUsd;

  // Liquidation map: outstanding notional per row and the running totals from the current price outwards.
  const map = useMemo(() => {
    const long = heatmap.profile?.long ?? new Array(R).fill(0);
    const short = heatmap.profile?.short ?? new Array(R).fill(0);
    const priceRow = Math.max(0, Math.min(R - 1, Math.floor((last.c - heatmap.priceMin) / heatmap.priceStep)));
    const cumLong = new Float64Array(R);
    const cumShort = new Float64Array(R);
    let acc = 0;
    for (let r = priceRow; r >= 0; r--) cumLong[r] = acc += long[r];
    acc = 0;
    for (let r = priceRow; r < R; r++) cumShort[r] = acc += short[r];
    let maxRow = 1;
    let maxAt = 0;
    for (let r = 0; r < R; r++) {
      if (long[r] + short[r] > maxRow) {
        maxRow = long[r] + short[r];
        maxAt = r;
      }
    }
    const totalLong = long.reduce((s, x) => s + x, 0);
    const totalShort = short.reduce((s, x) => s + x, 0);
    return { long, short, cumLong, cumShort, priceRow, maxRow, maxAt, totalLong, totalShort, maxCum: Math.max(1, cumLong[0] ?? 0, cumShort[R - 1] ?? 0) };
  }, [heatmap, R, last.c]);

  // Key levels: the biggest clusters still outstanding on each side, a band counted once.
  const levels = useMemo(() => {
    const gap = Math.max(1, Math.round((last.c * 0.0015) / step));
    const priceOf = (r: number) => yMin + (r + 0.5) * step;
    return {
      shorts: peaks(map.short, map.priceRow, R - 1, gap, 'short', priceOf),
      longs: peaks(map.long, 0, map.priceRow, gap, 'long', priceOf),
    };
  }, [map, last.c, step, yMin, R]);
  // The two drawn on the chart: the biggest within the chosen distance of the price.
  const marks = useMemo(() => {
    if (!prefs.keyLevels) return [];
    const near = (l: Level) => prefs.keyRange === 0 || Math.abs(l.price / last.c - 1) * 100 <= prefs.keyRange;
    return [levels.shorts.find(near), levels.longs.find(near)].filter((l): l is Level => !!l);
  }, [levels, prefs.keyLevels, prefs.keyRange, last.c]);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(360, Math.floor(e.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const showMap = prefs.showMap && width >= 560;
  const mapW = showMap ? MAP_W : 0;
  const plotX = AXIS_LEFT;
  const plotW = width - AXIS_LEFT - AXIS_RIGHT - mapW;
  const plotH = HEIGHT - AXIS_BOTTOM;
  const mapX = plotX + plotW + AXIS_RIGHT;

  // Zoom and pan stay inside the data, keep a few columns and rows in view, and reset with a new window.
  const clampView = (v: View): View => {
    const w = Math.max(Math.min(cols, 6), Math.min(cols, v.c1 - v.c0));
    const c0 = Math.max(0, Math.min(cols - w, v.c0));
    const s = Math.max(Math.min(yMax - yMin, step * 8), Math.min(yMax - yMin, v.p1 - v.p0));
    const p0 = Math.max(yMin, Math.min(yMax - s, v.p0));
    return { c0, c1: c0 + w, p0, p1: p0 + s };
  };
  const zoomed = zoom?.window === heatmap.window ? zoom.view : null;
  const vc0 = zoomed ? Math.max(0, zoomed.c0) : 0;
  const vc1 = zoomed ? Math.min(cols, zoomed.c1) : cols;
  const vp0 = zoomed ? Math.max(yMin, zoomed.p0) : yMin;
  const vp1 = zoomed ? Math.min(yMax, zoomed.p1) : yMax;
  const view: View = { c0: vc0, c1: vc1, p0: vp0, p1: vp1 };
  const isZoomed = vc0 > 0.01 || vc1 < cols - 0.01 || vp0 > yMin + step * 0.01 || vp1 < yMax - step * 0.01;

  const xOf = (col: number) => plotX + ((col + 0.5 - vc0) / (vc1 - vc0)) * plotW;
  const colAt = (x: number) => vc0 + ((x - plotX) / plotW) * (vc1 - vc0);
  const yOf = (price: number) => plotH - ((price - vp0) / (vp1 - vp0)) * plotH;
  const priceAt = (y: number) => vp0 + (1 - y / plotH) * (vp1 - vp0);
  const colW = plotW / (vc1 - vc0);
  const rowH = (step / (vp1 - vp0)) * plotH;

  // Everything the wheel handler needs, read at event time so the listener is registered once.
  const geo = useRef({ view, plotX, plotW, plotH, cols, window: heatmap.window, clampView, colAt, priceAt });
  geo.current = { view, plotX, plotW, plotH, cols, window: heatmap.window, clampView, colAt, priceAt };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const g = geo.current;
      const box = el.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;
      if (y >= g.plotH) return;
      e.preventDefault();
      const v = g.view;
      const inPlot = x >= g.plotX && x < g.plotX + g.plotW;
      // A sideways swipe on a trackpad pans through time.
      if (!e.shiftKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dc = (e.deltaX / g.plotW) * (v.c1 - v.c0);
        apply(g.clampView({ ...v, c0: v.c0 + dc, c1: v.c1 + dc }));
        return;
      }
      // Some browsers turn Shift + wheel into a sideways scroll.
      const delta = e.deltaY || e.deltaX;
      const f = Math.exp(Math.sign(delta) * Math.min(Math.abs(delta), 120) * 0.0025);
      const next = { ...v };
      if (!e.shiftKey && inPlot) {
        const c = g.colAt(x);
        next.c0 = c - (c - v.c0) * f;
        next.c1 = c + (v.c1 - c) * f;
      }
      if (!e.altKey) {
        const p = g.priceAt(y);
        next.p0 = p - (p - v.p0) * f;
        next.p1 = p + (v.p1 - p) * f;
      }
      apply(g.clampView(next));
    };
    // Wheel events can arrive faster than React renders: each one builds on the last, not on the last render.
    const apply = (next: View) => {
      geo.current.view = next;
      setZoom({ window: geo.current.window, view: next });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Heat cells: one pixel per cell in a small bitmap, redrawn only when the data or colours change.
  const bitmap = useMemo(() => {
    const bmp = document.createElement('canvas');
    bmp.width = cols;
    bmp.height = R;
    const bctx = bmp.getContext('2d');
    if (!bctx) return bmp;
    const img = bctx.createImageData(cols, R);
    for (let r = 0; r < R; r++) {
      const src = r * cols;
      const dst = (R - 1 - r) * cols * 4;
      for (let c = 0; c < cols; c++) {
        const [Rr, G, B] = lut[cells[src + c]];
        const k = dst + c * 4;
        img.data[k] = Rr;
        img.data[k + 1] = G;
        img.data[k + 2] = B;
        img.data[k + 3] = 255;
      }
    }
    bctx.putImageData(img, 0, 0);
    return bmp;
  }, [cells, lut, cols, R]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const dpr = globalThis.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(HEIGHT * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = UI.panel;
    ctx.fillRect(0, 0, width, HEIGHT);

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotX, 0, plotW, plotH);
    ctx.clip();
    // The visible part of the bitmap, stretched over the plot without smoothing.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, vc0, R - (vp1 - yMin) / step, vc1 - vc0, (vp1 - vp0) / step, plotX, 0, plotW, plotH);

    const cFrom = Math.max(0, Math.floor(vc0));
    const cTo = Math.min(cols - 1, Math.ceil(vc1) - 1);
    // Zoomed in far enough, each cell prints its estimate.
    if (colW >= CELL_TEXT_W && rowH >= CELL_TEXT_H) {
      ctx.font = `600 9px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const rFrom = Math.max(0, Math.floor((vp0 - yMin) / step));
      const rTo = Math.min(R - 1, Math.ceil((vp1 - yMin) / step) - 1);
      for (let r = rFrom; r <= rTo; r++) {
        for (let c = cFrom; c <= cTo; c++) {
          const b = cells[r * cols + c];
          if (!b || b / 255 < prefs.lo) continue;
          ctx.fillStyle = inkOn(lut[b]);
          ctx.fillText(shortUsd(usdOf(b)), xOf(c), yOf(yMin + (r + 0.5) * step));
        }
      }
    }

    // Price on top: candles, a line of closes (also when columns get thinner than a pixel), or nothing.
    const asLine = prefs.price === 'line' || (prefs.price === 'candles' && colW < 1.5);
    if (prefs.price !== 'off' && asLine) {
      const path = () => {
        ctx.beginPath();
        for (let c = Math.max(0, cFrom - 1); c <= Math.min(cols - 1, cTo + 1); c++) {
          const k = heatmap.candles[c];
          if (c === Math.max(0, cFrom - 1)) ctx.moveTo(xOf(c), yOf(k.c));
          else ctx.lineTo(xOf(c), yOf(k.c));
        }
      };
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(17,17,16,0.75)';
      ctx.lineWidth = 3;
      path();
      ctx.stroke();
      ctx.strokeStyle = UI.ink;
      ctx.lineWidth = 1.25;
      path();
      ctx.stroke();
    } else if (prefs.price === 'candles') {
      const bodyW = Math.max(1, Math.min(12, colW * 0.6));
      for (let c = cFrom; c <= cTo; c++) {
        const k = heatmap.candles[c];
        const x = xOf(c);
        const up = k.c >= k.o;
        const top = yOf(Math.max(k.o, k.c));
        const bot = yOf(Math.min(k.o, k.c));
        ctx.strokeStyle = up ? UI.up : UI.down;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, yOf(k.h));
        ctx.lineTo(x, yOf(k.l));
        ctx.stroke();
        ctx.fillStyle = up ? UI.up : UI.down;
        ctx.fillRect(x - bodyW / 2, top, bodyW, Math.max(1, bot - top));
      }
    }
    ctx.restore();

    // Key levels and the current price, across the plot and the map.
    const across = (y: number) => {
      ctx.beginPath();
      ctx.moveTo(plotX, y);
      ctx.lineTo(plotX + plotW, y);
      if (showMap) {
        ctx.moveTo(mapX, y);
        ctx.lineTo(mapX + mapW, y);
      }
      ctx.stroke();
    };
    const yPx = Math.round(yOf(last.c)) + 0.5;
    const markYs = marks.map((m) => Math.round(yOf(m.price)) + 0.5);
    // Where the tags go: a key level too close to the current price (or to the other key level) has its
    // tag pushed away from it, shorts upwards and longs downwards, so no label hides another.
    const tagYs = marks.map((m, i) => {
      const dir = m.side === 'short' ? -1 : 1;
      let y = markYs[i];
      if (Math.abs(y - yPx) < 17) y = yPx + dir * 17;
      return y;
    });
    ctx.lineWidth = 1;
    marks.forEach((m, i) => {
      if (markYs[i] < 0 || markYs[i] > plotH) return;
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = m.side === 'short' ? SHORT_COLOR : LONG_COLOR;
      across(markYs[i]);
    });
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = UI.ink2;
    if (yPx >= 0 && yPx <= plotH) across(yPx);
    ctx.setLineDash([]);

    // Colour scale on the left, labelled with the estimate in one cell at each end of the intensity range.
    const barX = 14;
    const barW = 10;
    const grad = ctx.createLinearGradient(0, plotH - 4, 0, 14);
    for (let s = 0; s <= 10; s++) grad.addColorStop(s / 10, rgb(ramp(s / 10)));
    ctx.fillStyle = grad;
    ctx.fillRect(barX, 14, barW, plotH - 18);
    ctx.fillStyle = UI.mute;
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(fmtCompactUsd(heatmap.maxUsd * Math.max(prefs.lo + 0.05, prefs.hi)), 2, 12);
    ctx.textBaseline = 'top';
    ctx.fillText(prefs.lo > 0 ? fmtCompactUsd(heatmap.maxUsd * prefs.lo) : '0', 2, plotH - 2);

    // Axes: prices on the right of the heatmap, dates along the bottom.
    ctx.font = `11px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = UI.line;
    ctx.beginPath();
    ctx.moveTo(plotX + plotW + 0.5, 0);
    ctx.lineTo(plotX + plotW + 0.5, plotH);
    ctx.moveTo(plotX, plotH + 0.5);
    ctx.lineTo(plotX + plotW, plotH + 0.5);
    ctx.stroke();
    const span = vp1 - vp0;
    const tick = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000].find((s) => span / s <= 9) ?? 100000;
    const taken = [yPx, ...tagYs];
    for (let p = Math.ceil(vp0 / tick) * tick; p < vp1; p += tick) {
      if (taken.some((y) => Math.abs(yOf(p) - y) < 10)) continue;
      ctx.fillText(p.toLocaleString('en-US'), plotX + plotW + 6, yOf(p));
    }
    // Price tags: key levels in their side's colour, the current price in white on top.
    const tag = (y: number, text: string, bg: string, fg: string) => {
      if (y < 0 || y > plotH) return;
      ctx.fillStyle = bg;
      ctx.fillRect(plotX + plotW + 1, y - 8, AXIS_RIGHT - 2, 16);
      ctx.fillStyle = fg;
      ctx.font = `600 10px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, plotX + plotW + 5, y);
    };
    marks.forEach((m, i) => tag(tagYs[i], Math.round(m.price).toLocaleString('en-US'), m.side === 'short' ? SHORT_COLOR : LONG_COLOR, UI.bg));
    tag(yPx, Math.round(last.c).toLocaleString('en-US'), UI.ink, UI.bg);
    // Key level labels inside the plot, on the left.
    marks.forEach((m, i) => {
      const y = tagYs[i];
      if (y < 9 || y > plotH - 9) return;
      const text = t(m.side === 'short' ? 'Most short liquidations · {usd}' : 'Most long liquidations · {usd}', { usd: fmtCompactUsd(m.usd) });
      ctx.font = `600 10px ${FONT}`;
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = m.side === 'short' ? SHORT_COLOR : LONG_COLOR;
      ctx.beginPath();
      ctx.roundRect(plotX + 4, y - 8, w, 16, 3);
      ctx.fill();
      ctx.fillStyle = UI.bg;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, plotX + 9, y);
    });

    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = UI.mute;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const ticks = Math.max(2, Math.floor(plotW / 110));
    const first = Math.max(0, Math.round(vc0));
    const lastCol = Math.min(cols - 1, Math.round(vc1 - 1));
    const spanDays = (heatmap.t[lastCol] - heatmap.t[first]) / 86_400;
    for (let i = 0; i <= ticks; i++) {
      const c = Math.min(cols - 1, Math.max(0, Math.round(vc0 + (i / ticks) * (vc1 - vc0) - 0.5)));
      const d = new Date(heatmap.t[c] * 1000);
      const day = `${d.getUTCDate()} ${d.toLocaleString(LOCALE[lang], { month: 'short', timeZone: 'UTC' })}`;
      const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      const label = spanDays <= 4 ? `${day} ${time}` : spanDays > 300 ? `${d.toLocaleString(LOCALE[lang], { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}` : day;
      ctx.fillText(label, Math.max(plotX + 30, Math.min(plotX + plotW - 30, xOf(c))), plotH + 5);
    }

    // Liquidation map: bars coloured like the heatmap, cumulative curves from the current price outwards.
    if (showMap) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(mapX, 0, mapW, plotH);
      ctx.clip();
      ctx.fillStyle = UI.bg;
      ctx.fillRect(mapX, 0, mapW, plotH);
      const barMax = mapW - 6;
      const top = Math.max(prefs.lo + 0.05, prefs.hi);
      for (let r = 0; r < R; r++) {
        const v = map.long[r] + map.short[r];
        if (v <= 0) continue;
        const y = yOf(yMin + (r + 1) * step);
        if (y > plotH || y + rowH < 0) continue;
        const frac = v / map.maxRow;
        ctx.fillStyle = rgb(ramp(Math.max(0.3, Math.min(1, frac / top))));
        ctx.fillRect(mapX, y, Math.max(1, frac * barMax), Math.max(1, rowH - 0.3));
      }
      const curve = (cum: Float64Array, from: number, to: number, color: string) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const dir = to >= from ? 1 : -1;
        let started = false;
        for (let r = from; dir > 0 ? r <= to : r >= to; r += dir) {
          if (r < 0 || r >= R) continue;
          const x = mapX + (cum[r] / map.maxCum) * barMax;
          const y = yOf(yMin + (r + 0.5) * step);
          if (!started) {
            ctx.moveTo(mapX, y);
            started = true;
          }
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      curve(map.cumShort, map.priceRow, R - 1, SHORT_COLOR);
      curve(map.cumLong, map.priceRow, 0, LONG_COLOR);
      ctx.restore();
      ctx.fillStyle = UI.mute;
      ctx.font = `10px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(t('Liquidation map'), mapX + 4, plotH + 5);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatmap, cells, lut, bitmap, width, showMap, lang, map, marks, prefs.price, prefs.lo, prefs.hi, vc0, vc1, vp0, vp1]);

  // Pointer: drag to pan (prices only over the liquidation map), double-click to reset.
  const drag = useRef<{ x: number; y: number; view: View; priceOnly: boolean } | null>(null);
  const local = (e: PointerEvent | MouseEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  // What is under the cursor: a heat cell, or a row of the liquidation map.
  type HeatTip = { kind: 'heat'; col: number; row: number; price: number };
  type MapTip = { kind: 'map'; row: number; price: number };
  const tip = ((): HeatTip | MapTip | null => {
    if (!hover || dragging || hover.y >= plotH) return null;
    const price = priceAt(hover.y);
    const row = Math.max(0, Math.min(R - 1, Math.floor((price - yMin) / step)));
    if (hover.x >= plotX && hover.x < plotX + plotW) return { kind: 'heat', col: Math.min(cols - 1, Math.max(0, Math.floor(colAt(hover.x)))), row, price };
    if (showMap && hover.x >= mapX) return { kind: 'map', row, price };
    return null;
  })();
  const fromNow = (p: number) => (p / last.c - 1) * 100;

  // Tooltip detail for a heat cell: the cells around it, the sides split at that bar's close, and what a
  // move from the close to the cursor would have swept in that bar.
  const heatDetail = (tp: HeatTip) => {
    const k = heatmap.candles[tp.col];
    const prev = heatmap.candles[tp.col - 1];
    const closeRow = Math.floor((k.c - yMin) / step);
    const cell = (c: number, r: number) => usdOf(cells[r * cols + c]);
    const gridCols: number[] = [];
    for (let c = tp.col - GRID_COLS; c <= tp.col + GRID_COLS; c++) if (c >= 0 && c < cols) gridCols.push(c);
    const gridRows: number[] = [];
    for (let r = tp.row + GRID_ROWS; r >= tp.row - GRID_ROWS; r--) if (r >= 0 && r < R) gridRows.push(r);
    const near = { shorts: 0, longs: 0 };
    for (const r of gridRows) {
      if (r > closeRow) near.shorts += cell(tp.col, r);
      else if (r < closeRow) near.longs += cell(tp.col, r);
    }
    let swept = 0;
    if (tp.row > closeRow) for (let r = closeRow + 1; r <= tp.row; r++) swept += cell(tp.col, r);
    else if (tp.row < closeRow) for (let r = tp.row; r < closeRow; r++) swept += cell(tp.col, r);
    return { k, change: prev ? (k.c / prev.c - 1) * 100 : null, closeRow, gridCols, gridRows, near, swept, usd: cell(tp.col, tp.row) };
  };

  const keyRows = (list: Level[], n: number) => list.slice(0, n);
  const shortsList = keyRows(levels.shorts, 5).sort((a, b) => b.price - a.price);
  const longsList = keyRows(levels.longs, 5).sort((a, b) => b.price - a.price);
  const listMax = Math.max(1, ...shortsList.map((l) => l.usd), ...longsList.map((l) => l.usd));
  const total = map.totalLong + map.totalShort;
  const wide = width >= 640;

  const levelRow = (l: Level) => (
    <div key={`${l.side}${l.row}`} className="num grid grid-cols-[4.5rem_1fr_3.5rem_3.75rem] items-center gap-2 py-0.5 text-[11px]">
      <span className="text-ink">{fmtUsd(l.price)}</span>
      <span className="h-1.5 rounded-full bg-raised">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(3, (l.usd / listMax) * 100)}%`, background: l.side === 'short' ? SHORT_COLOR : LONG_COLOR }} />
      </span>
      <span className="text-right text-ink">{fmtCompactUsd(l.usd)}</span>
      <span className="text-right text-mute">{signedPct(fromNow(l.price))}</span>
    </div>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="num flex flex-wrap items-center gap-x-3 text-[11px] text-ink2">
          <span className="font-semibold text-ink">{t('BTC/USDT · estimated liquidation levels · {tf} bars', { tf: TF_INFO[tf].label })}</span>
          <span>{t('last {price}', { price: fmtUsd(last.c) })}</span>
          {loading && <span className="text-mute">{t('loading {window}…', { window: windowId })}</span>}
        </div>
        <div className="thin-scroll max-w-full overflow-x-auto">
          <Segmented label={t('Heatmap window')} size="sm" value={windowId} onChange={onWindow} options={HEATMAP_WINDOWS.map((w) => ({ value: w, label: w === 'All' ? t('All') : w }))} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-3 py-1.5 text-[11px] text-ink2">
        <IntensityRange
          lo={prefs.lo}
          hi={prefs.hi}
          maxUsd={heatmap.maxUsd}
          onChange={(lo, hi) => updatePrefs({ lo, hi })}
          onReset={() => updatePrefs({ lo: DEFAULT_LO, hi: DEFAULT_HI })}
        />
        <div className="flex items-center gap-2">
          <span>{t('Price')}</span>
          <Segmented
            label={t('Price')}
            size="sm"
            value={prefs.price}
            onChange={(price) => updatePrefs({ price })}
            options={[
              { value: 'candles', label: t('Candles') },
              { value: 'line', label: t('Line') },
              { value: 'off', label: t('Hidden') },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5" title={t('Mark the biggest short liquidation level above the price and the biggest long liquidation level below it.')}>
            <input type="checkbox" checked={prefs.keyLevels} onChange={(e) => updatePrefs({ keyLevels: e.target.checked })} className="accent-[#3987e5]" />
            <span>{t('Key levels')}</span>
          </label>
          {prefs.keyLevels && (
            <Segmented
              label={t('Look for key levels within')}
              size="sm"
              value={prefs.keyRange}
              onChange={(keyRange) => updatePrefs({ keyRange })}
              options={[1, 3, 5, 0].map((r) => ({ value: r, label: r === 0 ? t('All') : `±${r}%` }))}
            />
          )}
        </div>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={prefs.showMap} onChange={(e) => updatePrefs({ showMap: e.target.checked })} className="accent-[#3987e5]" />
          <span>{t('Liquidation map')}</span>
        </label>
        {isZoomed && (
          <button onClick={() => setZoom(null)} className="flex items-center gap-1 rounded border border-line px-1.5 py-0.5 text-ink2 hover:text-ink">
            <RotateCcw size={11} />
            {t('Reset zoom')}
          </button>
        )}
      </div>

      <div
        ref={wrap}
        className={clsx('relative select-none', dragging ? 'cursor-grabbing' : 'cursor-crosshair')}
        style={{ height: HEIGHT, touchAction: 'pan-y' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const p = local(e);
          if (p.y >= plotH || p.x < plotX) return;
          drag.current = { ...p, view, priceOnly: p.x >= plotX + plotW };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const p = local(e);
          setHover(p);
          const d = drag.current;
          if (!d) return;
          const dx = p.x - d.x;
          const dy = p.y - d.y;
          if (!dragging && Math.abs(dx) + Math.abs(dy) < 4) return;
          setDragging(true);
          const dc = d.priceOnly ? 0 : -(dx / plotW) * (d.view.c1 - d.view.c0);
          const dp = (dy / plotH) * (d.view.p1 - d.view.p0);
          setZoom({ window: heatmap.window, view: clampView({ c0: d.view.c0 + dc, c1: d.view.c1 + dc, p0: d.view.p0 + dp, p1: d.view.p1 + dp }) });
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
        }}
        onDoubleClick={() => setZoom(null)}
        onMouseLeave={() => setHover(null)}
      >
        <canvas ref={canvas} style={{ width, height: HEIGHT }} className="block" role="img" aria-label={t('Heatmap of estimated liquidation levels by price and time, with candles')} />
        {hover && hover.y < plotH && hover.x >= plotX && (
          <>
            {tip?.kind === 'heat' && <div className="pointer-events-none absolute top-0 w-px bg-mute/60" style={{ left: hover.x, height: plotH }} />}
            <div className="pointer-events-none absolute h-px bg-mute/60" style={{ top: hover.y, left: plotX, width: width - plotX }} />
            {/* The price under the cursor, on the price axis. */}
            <div className="num pointer-events-none absolute flex items-center rounded-sm bg-raised px-1 text-[10px] font-semibold text-ink ring-1 ring-mute/50" style={{ top: hover.y - 8, left: plotX + plotW + 1, width: AXIS_RIGHT - 2, height: 16 }}>
              {Math.round(priceAt(hover.y)).toLocaleString('en-US')}
            </div>
          </>
        )}
        {tip && hover && (
          <div
            className="num pointer-events-none absolute z-10 rounded-md border border-line bg-raised px-2.5 py-2 text-[11px] shadow-lg"
            style={{
              left: hover.x + 14 + 260 > width ? Math.max(4, hover.x - 14 - 260) : hover.x + 14,
              top: Math.max(4, Math.min(hover.y + 14, plotH - (tip.kind === 'heat' ? 300 : 90))),
              width: tip.kind === 'heat' ? 260 : 230,
            }}
          >
            {tip.kind === 'heat' ? (
              (() => {
                const d = heatDetail(tip);
                const behind = cols - 1 - tip.col;
                return (
                  <>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-ink">
                        {new Date(heatmap.t[tip.col] * 1000).toLocaleString(LOCALE[lang], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC
                      </span>
                      <span className={clsx(d.change == null ? 'text-ink2' : d.change >= 0 ? 'text-up' : 'text-down')}>
                        {t('Close {price}', { price: fmtUsd(d.k.c) })}
                        {d.change != null && ` ${signedPct(d.change)}`}
                      </span>
                    </div>
                    <div className="mb-1.5 text-[10px] text-mute">
                      {behind === 0 ? t('Latest bar') : t('{dur} before the latest bar', { dur: durOf(tf, behind) })} · {t('{tf} per column', { tf: TF_INFO[tf].label })}
                    </div>
                    <table className="w-full border-separate border-spacing-[2px] text-[9.5px]">
                      <thead>
                        <tr>
                          {d.gridCols.map((c) => {
                            const dt = new Date(heatmap.t[c] * 1000);
                            return (
                              <th key={c} className={clsx('font-normal', c === tip.col ? 'text-ink' : 'text-mute')}>
                                {`${String(dt.getUTCHours()).padStart(2, '0')}:${String(dt.getUTCMinutes()).padStart(2, '0')}`}
                              </th>
                            );
                          })}
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {d.gridRows.map((r) => (
                          <tr key={r}>
                            {d.gridCols.map((c) => {
                              const b = cells[r * cols + c];
                              const hidden = !b || b / 255 < prefs.lo;
                              const col = lut[hidden ? 0 : b];
                              return (
                                <td
                                  key={c}
                                  className={clsx('h-4 rounded-sm text-center', c === tip.col && r === tip.row && 'ring-1 ring-ink')}
                                  style={{ background: rgb(col), color: inkOn(col) }}
                                >
                                  {hidden ? '·' : shortUsd(usdOf(b))}
                                </td>
                              );
                            })}
                            <td className={clsx('pl-1 text-right', r === tip.row ? 'font-semibold text-ink' : r > d.closeRow ? 'text-up/80' : 'text-down/80')}>
                              {Math.round(yMin + (r + 0.5) * step).toLocaleString('en-US')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-1 flex justify-between border-b border-line pb-1.5 text-[10px] text-mute">
                      <span>{t('±{n} rows: shorts · longs', { n: GRID_ROWS })}</span>
                      <span>
                        <span style={{ color: SHORT_COLOR }}>{fmtCompactUsd(d.near.shorts)}</span> · <span style={{ color: LONG_COLOR }}>{fmtCompactUsd(d.near.longs)}</span>
                      </span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
                      <span className="text-ink2">{t('Est. liquidations')}</span>
                      <span className="text-right text-ink">{d.usd > 0 ? `≈ ${fmtCompactUsd(d.usd)}` : t('none')}</span>
                      <span className="text-ink2">{t('Side')}</span>
                      <span className="text-right" style={{ color: tip.row > d.closeRow ? SHORT_COLOR : tip.row < d.closeRow ? LONG_COLOR : UI.ink2 }}>
                        {tip.row > d.closeRow ? t('Shorts (above the close)') : tip.row < d.closeRow ? t('Longs (below the close)') : t('At the close')}
                      </span>
                      <span className="text-ink2">{t('From current price')}</span>
                      <span className="text-right text-ink">
                        {fmtUsd(tip.price)} · {signedPct(fromNow(tip.price))}
                      </span>
                      <span className="text-ink2">{t('Swept from the close to here')}</span>
                      <span className="text-right text-ink">≈ {fmtCompactUsd(d.swept)}</span>
                    </div>
                  </>
                );
              })()
            ) : (
              <>
                <div className="font-medium text-ink">
                  {fmtUsd(tip.price)} <span className="text-mute">({signedPct(fromNow(tip.price))})</span>
                </div>
                <div className="text-ink2">
                  {t('At this level')} <span className="text-ink">≈ {fmtCompactUsd(map.long[tip.row] + map.short[tip.row])}</span>
                </div>
                {tip.row >= map.priceRow ? (
                  <div style={{ color: SHORT_COLOR }}>{t('Shorts liquidated on the way up: ≈ {usd}', { usd: fmtCompactUsd(map.cumShort[tip.row]) })}</div>
                ) : (
                  <div style={{ color: LONG_COLOR }}>{t('Longs liquidated on the way down: ≈ {usd}', { usd: fmtCompactUsd(map.cumLong[tip.row]) })}</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className="border-t border-line px-3 py-1 text-[10.5px] text-mute">{t('Scroll to zoom (Shift: price only, Alt: time only), drag to pan, double-click to see everything. Zoomed in far enough, each cell shows its estimate.')}</div>

      <div className={clsx('grid gap-4 border-t border-line p-3', wide && 'grid-cols-2')}>
        <section>
          <h4 className="mb-1.5 flex items-baseline justify-between text-[11px] font-semibold uppercase tracking-wider text-ink2">
            {t('Key liquidation levels')}
            <span className="font-normal normal-case tracking-normal text-mute">{t('distance from price')}</span>
          </h4>
          <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] text-mute">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: SHORT_COLOR }} />
            {t('Above · short liquidations')}
          </div>
          {shortsList.length ? shortsList.map(levelRow) : <div className="py-0.5 text-[11px] text-mute">{t('None outstanding')}</div>}
          <div className="num my-1 flex items-center gap-2 text-[10.5px] text-ink2">
            <span className="h-px flex-1 bg-line" />
            {t('price {price}', { price: fmtUsd(last.c) })}
            <span className="h-px flex-1 bg-line" />
          </div>
          <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] text-mute">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: LONG_COLOR }} />
            {t('Below · long liquidations')}
          </div>
          {longsList.length ? longsList.map(levelRow) : <div className="py-0.5 text-[11px] text-mute">{t('None outstanding')}</div>}
        </section>
        <section className="num text-[11px]">
          <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink2">{t('Outstanding now')}</h4>
          <div className="text-[10.5px] text-mute">{t('Estimated liquidation levels still open (total)')}</div>
          <div className="mb-1.5 text-lg font-semibold text-ink">{fmtCompactUsd(total)}</div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-raised">
            <span style={{ width: `${total > 0 ? (map.totalLong / total) * 100 : 50}%`, background: LONG_COLOR }} />
            <span className="flex-1" style={{ background: SHORT_COLOR }} />
          </div>
          <div className="mt-1 flex justify-between gap-2">
            <span>
              <span style={{ color: LONG_COLOR }}>●</span> {t('Longs (below price)')} <span className="text-ink">{fmtCompactUsd(map.totalLong)}</span>{' '}
              <span className="text-mute">{total > 0 ? `${Math.round((map.totalLong / total) * 100)}%` : ''}</span>
            </span>
            <span className="text-right">
              <span style={{ color: SHORT_COLOR }}>●</span> {t('Shorts (above price)')} <span className="text-ink">{fmtCompactUsd(map.totalShort)}</span>{' '}
              <span className="text-mute">{total > 0 ? `${Math.round((map.totalShort / total) * 100)}%` : ''}</span>
            </span>
          </div>
          <div className="mt-2.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 border-t border-line pt-2">
            <span className="text-ink2">{t('Largest single level')}</span>
            <span className="text-right text-ink">{t('{usd} at {price}', { usd: fmtCompactUsd(map.maxRow), price: fmtUsd(yMin + (map.maxAt + 0.5) * step) })}</span>
            <span className="text-ink2">{t('Within ±{pct}% of price', { pct: 3 })}</span>
            <span className="text-right text-ink">
              {fmtCompactUsd(withinPct(map, yMin, step, last.c, 0.03, 'short'))} <span className="text-mute">↑</span> · {fmtCompactUsd(withinPct(map, yMin, step, last.c, 0.03, 'long'))} <span className="text-mute">↓</span>
            </span>
            <span className="text-ink2">{t('Row height / column')}</span>
            <span className="text-right text-ink">{t('{step} / {tf}', { step: fmtUsd(step, step < 100 ? 2 : 0), tf: TF_INFO[tf].label })}</span>
          </div>
        </section>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line p-3">
        <p className="text-[11px] leading-relaxed text-ink2">
          {t('Bright bands are price levels where many leveraged positions would be force-closed. Bands above price are short liquidations, bands below are long liquidations; price is often drawn toward the brightest nearby band, and a band ends where price traded through it.')}
        </p>
        {showMap && (
          <p className="text-[11px] leading-relaxed text-ink2">
            {t('The liquidation map on the right shows what is still outstanding at each price now. The green curve adds up the short liquidations from the current price upwards and the red curve the long liquidations downwards: the steeper a curve, the more fuel a move in that direction would find.')}
          </p>
        )}
        {heatmap.notes.map((n) => (
          <Note key={n}>{n}</Note>
        ))}
      </div>
    </div>
  );
}

/** Outstanding liquidations on one side within a share of the current price. */
function withinPct(map: { long: number[]; short: number[] }, yMin: number, step: number, price: number, pct: number, side: 'long' | 'short'): number {
  const values = side === 'long' ? map.long : map.short;
  let sum = 0;
  for (let r = 0; r < values.length; r++) {
    const p = yMin + (r + 0.5) * step;
    if (Math.abs(p / price - 1) <= pct) sum += values[r];
  }
  return sum;
}

/**
 * Two-handle intensity range over the colour ramp: cells below the left handle are hidden and everything
 * above the right handle is drawn at full brightness. Labelled with the estimate in one cell at each handle.
 */
function IntensityRange({ lo, hi, maxUsd, onChange, onReset }: { lo: number; hi: number; maxUsd: number; onChange: (lo: number, hi: number) => void; onReset: () => void }) {
  const { t } = useT();
  const track = useRef<HTMLDivElement>(null);
  const active = useRef<'lo' | 'hi' | null>(null);
  const MIN_GAP = 0.05;
  const at = (clientX: number) => {
    const box = track.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * 100) / 100;
  };
  const set = (which: 'lo' | 'hi', v: number) => {
    if (which === 'lo') onChange(Math.max(0, Math.min(v, hi - MIN_GAP, 0.9)), hi);
    else onChange(lo, Math.min(1, Math.max(v, lo + MIN_GAP, 0.05)));
  };
  const key = (which: 'lo' | 'hi') => (e: KeyboardEvent) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 0.05 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.05 : 0;
    if (!d) return;
    e.preventDefault();
    set(which, Math.round(((which === 'lo' ? lo : hi) + d) * 100) / 100);
  };
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <div className="flex items-center gap-2" title={t('Cells below the left handle are hidden, which clears away small scattered levels; everything above the right handle is drawn at full brightness, which brings out mid-sized zones. The figures are the estimated liquidations in one cell.')}>
      <span>{t('Intensity')}</span>
      <div
        ref={track}
        className="relative h-2.5 w-32 cursor-pointer rounded-full"
        style={{ background: GRADIENT, touchAction: 'none' }}
        onPointerDown={(e) => {
          const v = at(e.clientX);
          active.current = Math.abs(v - lo) <= Math.abs(v - hi) && v <= hi ? 'lo' : 'hi';
          set(active.current, v);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => active.current && set(active.current, at(e.clientX))}
        onPointerUp={() => (active.current = null)}
      >
        {/* Hidden part on the left, saturated part on the right. */}
        <div className="absolute inset-y-0 left-0 rounded-l-full bg-bg/80" style={{ width: pct(lo) }} />
        <div className="absolute inset-y-0 right-0 rounded-r-full" style={{ width: `${(1 - hi) * 100}%`, background: rgb(STOPS[STOPS.length - 1]) }} />
        {(['lo', 'hi'] as const).map((which) => (
          <div
            key={which}
            role="slider"
            tabIndex={0}
            aria-label={which === 'lo' ? t('Hide cells below') : t('Full brightness from')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((which === 'lo' ? lo : hi) * 100)}
            onKeyDown={key(which)}
            className="absolute top-1/2 h-4 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-bg bg-ink shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            style={{ left: pct(which === 'lo' ? lo : hi) }}
          />
        ))}
      </div>
      <span className="num whitespace-nowrap text-ink">
        ≥ {pct(lo)} · {lo > 0 ? fmtCompactUsd(maxUsd * lo) : '0'} – ≤ {pct(hi)} · {fmtCompactUsd(maxUsd * hi)}
      </span>
      {(lo !== DEFAULT_LO || hi !== DEFAULT_HI) && (
        <button onClick={onReset} className="text-mute underline-offset-2 hover:text-ink hover:underline">
          {t('Reset')}
        </button>
      )}
    </div>
  );
}
