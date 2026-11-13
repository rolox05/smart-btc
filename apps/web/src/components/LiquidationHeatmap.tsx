import { HEATMAP_WINDOWS, TF_INFO, type HeatmapWindow, type LiquidationHeatmap as Heatmap } from '@smart-btc/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtCompactUsd, fmtUsd } from '../lib/format';
import { UI } from '../lib/palette';
import { Note, Segmented } from './ui';

const HEIGHT = 560;
const AXIS_RIGHT = 64;
const AXIS_BOTTOM = 22;

/**
 * Sequential single-hue ramp for intensity: the chart surface at zero, through deep blue, to near-white.
 * A gamma above 1 holds ordinary levels back so the strongest clusters stand out.
 */
const STOPS: [number, number, number][] = [
  [26, 26, 25],
  [13, 54, 107],
  [37, 106, 191],
  [109, 167, 236],
  [205, 226, 251],
];
function ramp(v: number): [number, number, number] {
  const x = Math.pow(Math.max(0, Math.min(1, v)), 1.5) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  return [0, 1, 2].map((k) => Math.round(STOPS[i][k] + (STOPS[i + 1][k] - STOPS[i][k]) * f)) as [number, number, number];
}
const LUT = Array.from({ length: 256 }, (_, v) => ramp(v / 255));
const GRADIENT = `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1].map((v) => `rgb(${ramp(v).join(',')})`).join(', ')})`;

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Estimated liquidation levels through time, drawn as a heatmap with the hourly candles on top.
 * Brighter cells mean more leveraged notional would be force-closed if price reached that level.
 */
export function LiquidationHeatmapView({ heatmap, window: windowId, onWindow, loading }: { heatmap: Heatmap; window: HeatmapWindow; onWindow: (w: HeatmapWindow) => void; loading: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);

  const cells = useMemo(() => decode(heatmap.data), [heatmap.data]);
  const total = heatmap.t.length;
  // The server already cropped the data to the chosen window.
  const cols = total;
  const first = 0;

  // Vertical range: the prices traded in the window, padded so nearby clusters above and below stay in view.
  const { yMin, yMax } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let c = first; c < total; c++) {
      lo = Math.min(lo, heatmap.candles[c].l);
      hi = Math.max(hi, heatmap.candles[c].h);
    }
    const pad = (hi - lo) * 0.35 + hi * 0.02;
    const top = heatmap.priceMin + heatmap.rows * heatmap.priceStep;
    return { yMin: Math.max(heatmap.priceMin, lo - pad), yMax: Math.min(top, hi + pad) };
  }, [heatmap, first, total]);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(320, Math.floor(e.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  const plotW = width - AXIS_RIGHT;
  const plotH = HEIGHT - AXIS_BOTTOM;
  const xOf = (col: number) => ((col - first + 0.5) / cols) * plotW;
  const yOf = (price: number) => plotH - ((price - yMin) / (yMax - yMin)) * plotH;

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

    // Heat cells: paint the window into a small bitmap (one pixel per cell) and stretch it over the plot.
    const rowLo = Math.max(0, Math.floor((yMin - heatmap.priceMin) / heatmap.priceStep));
    const rowHi = Math.min(heatmap.rows - 1, Math.ceil((yMax - heatmap.priceMin) / heatmap.priceStep));
    const rows = rowHi - rowLo + 1;
    const bmp = document.createElement('canvas');
    bmp.width = cols;
    bmp.height = rows;
    const bctx = bmp.getContext('2d')!;
    const img = bctx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++) {
      const src = (rowLo + r) * total + first;
      const dst = (rows - 1 - r) * cols * 4;
      for (let c = 0; c < cols; c++) {
        const [R, G, B] = LUT[cells[src + c]];
        const k = dst + c * 4;
        img.data[k] = R;
        img.data[k + 1] = G;
        img.data[k + 2] = B;
        img.data[k + 3] = 255;
      }
    }
    bctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const yTop = yOf(heatmap.priceMin + (rowHi + 1) * heatmap.priceStep);
    const yBottom = yOf(heatmap.priceMin + rowLo * heatmap.priceStep);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, plotW, plotH);
    ctx.clip();
    ctx.drawImage(bmp, 0, yTop, plotW, yBottom - yTop);

    // Candles on top, with a dark outline so they stay readable over bright cells.
    const bodyW = Math.max(1, Math.min(9, (plotW / cols) * 0.7));
    for (let c = first; c < total; c++) {
      const k = heatmap.candles[c];
      const x = xOf(c);
      const up = k.c >= k.o;
      const top = yOf(Math.max(k.o, k.c));
      const bot = yOf(Math.min(k.o, k.c));
      ctx.strokeStyle = UI.bg;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, yOf(k.h));
      ctx.lineTo(x, yOf(k.l));
      ctx.stroke();
      ctx.strokeStyle = up ? UI.up : UI.down;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yOf(k.h));
      ctx.lineTo(x, yOf(k.l));
      ctx.stroke();
      ctx.fillStyle = up ? UI.up : UI.down;
      ctx.fillRect(x - bodyW / 2, top, bodyW, Math.max(1, bot - top));
    }
    ctx.restore();

    // Axes: prices on the right, dates along the bottom.
    ctx.fillStyle = UI.mute;
    ctx.font = '11px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = UI.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotW + 0.5, 0);
    ctx.lineTo(plotW + 0.5, plotH);
    ctx.lineTo(0, plotH + 0.5);
    ctx.stroke();
    const span = yMax - yMin;
    const step = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000].find((s) => span / s <= 8) ?? 20000;
    for (let p = Math.ceil(yMin / step) * step; p < yMax; p += step) ctx.fillText(p.toLocaleString('en-US'), plotW + 6, yOf(p));
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const ticks = Math.max(2, Math.floor(plotW / 110));
    for (let i = 0; i <= ticks; i++) {
      const c = first + Math.min(cols - 1, Math.round((i / ticks) * (cols - 1)));
      const d = new Date(heatmap.t[c] * 1000);
      const day = `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
      const spanDays = (heatmap.t[total - 1] - heatmap.t[0]) / 86_400;
      const label = spanDays <= 4 ? `${day} ${String(d.getUTCHours()).padStart(2, '0')}:00` : spanDays > 300 ? `${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}` : day;
      ctx.fillText(label, Math.max(30, Math.min(plotW - 30, xOf(c))), plotH + 5);
    }
    ctx.textAlign = 'left';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatmap, cells, width, cols, first, yMin, yMax]);

  // What is under the cursor.
  let tip: { col: number; price: number; usd: number } | null = null;
  if (hover && hover.x < plotW && hover.y < plotH) {
    const col = first + Math.min(cols - 1, Math.max(0, Math.floor((hover.x / plotW) * cols)));
    const price = yMin + (1 - hover.y / plotH) * (yMax - yMin);
    const row = Math.floor((price - heatmap.priceMin) / heatmap.priceStep);
    const v = row >= 0 && row < heatmap.rows ? cells[row * total + col] : 0;
    tip = { col, price, usd: (v / 255) * heatmap.maxUsd };
  }
  const last = heatmap.candles[total - 1];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="num flex flex-wrap items-center gap-x-3 text-[11px] text-ink2">
          <span className="font-semibold text-ink">BTC/USDT · estimated liquidation levels · {TF_INFO[heatmap.timeframe].label} bars</span>
          <span>last {fmtUsd(last.c)}</span>
          {loading && <span className="text-mute">loading {windowId}…</span>}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-[10px] text-mute">
            <span>less</span>
            <span className="h-2 w-24 rounded-full" style={{ background: GRADIENT }} />
            <span>more · about {fmtCompactUsd(heatmap.maxUsd)} per cell</span>
          </div>
          <div className="thin-scroll max-w-full overflow-x-auto">
            <Segmented label="Heatmap window" size="sm" value={windowId} onChange={onWindow} options={HEATMAP_WINDOWS.map((w) => ({ value: w, label: w }))} />
          </div>
        </div>
      </div>

      <div
        ref={wrap}
        className="relative"
        style={{ height: HEIGHT }}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover({ x: e.clientX - box.left, y: e.clientY - box.top });
        }}
        onMouseLeave={() => setHover(null)}
      >
        <canvas ref={canvas} style={{ width, height: HEIGHT }} className="block" role="img" aria-label="Heatmap of estimated liquidation levels by price and time, with hourly candles" />
        {tip && hover && (
          <>
            <div className="pointer-events-none absolute top-0 w-px bg-mute/60" style={{ left: hover.x, height: plotH }} />
            <div className="pointer-events-none absolute left-0 h-px bg-mute/60" style={{ top: hover.y, width: plotW }} />
            <div
              className="num pointer-events-none absolute z-10 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[11px] shadow-lg"
              style={{ left: Math.min(hover.x + 14, plotW - 190), top: Math.max(4, Math.min(hover.y + 14, plotH - 70)) }}
            >
              <div className="font-medium text-ink">{fmtUsd(tip.price)}</div>
              <div className="text-ink2">
                {new Date(heatmap.t[tip.col] * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC
              </div>
              <div className="text-ink2">
                Est. liquidations <span className="text-ink">{tip.usd > 0 ? `≈ ${fmtCompactUsd(tip.usd)}` : 'none'}</span>
              </div>
              <div className="text-mute">Candle close {fmtUsd(heatmap.candles[tip.col].c)}</div>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-line p-3">
        <p className="text-[11px] leading-relaxed text-ink2">
          Bright bands are price levels where many leveraged positions would be force-closed. Bands above price are short liquidations, bands below are long liquidations; price is often drawn toward the brightest nearby band, and a band ends where price traded through it.
        </p>
        {heatmap.notes.map((n) => (
          <Note key={n}>{n}</Note>
        ))}
      </div>
    </div>
  );
}
