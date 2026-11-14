import { HEATMAP_WINDOWS, TF_INFO, type HeatmapWindow, type LiquidationHeatmap as Heatmap } from '@smart-btc/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtCompactUsd, fmtUsd } from '../lib/format';
import { LOCALE, useT } from '../lib/i18n';
import { UI } from '../lib/palette';
import { Note, Segmented } from './ui';

const HEIGHT = 560;
const AXIS_LEFT = 44;
const AXIS_RIGHT = 60;
const AXIS_BOTTOM = 22;
const MAP_W = 170;
/** Colours of the cumulative curves on the liquidation map. */
const LONG_COLOR = '#e25c5c';
const SHORT_COLOR = '#3fcf8e';

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

/**
 * Lookup table for one threshold. As on Coinglass, the threshold is where the colour scale tops out, as a
 * share of the largest cluster: lower it and more levels turn bright, raise it and only the biggest do.
 * A gamma just under 1 keeps mid-sized levels visible as teal bands while only real clusters reach yellow.
 */
function makeLut(threshold: number): [number, number, number][] {
  return Array.from({ length: 256 }, (_, v) => (v === 0 ? STOPS[0] : ramp(Math.pow(Math.min(1, v / 255 / Math.max(0.05, threshold)), 0.9))));
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const PREFS_KEY = 'smart-btc:heatmap:v1';
function loadPrefs(): { threshold: number; showMap: boolean } {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return { threshold: typeof p.threshold === 'number' && p.v === 2 ? p.threshold : 0.85, showMap: p.showMap !== false };
  } catch {
    return { threshold: 0.85, showMap: true };
  }
}

/**
 * Estimated liquidation levels through time, drawn as a heatmap with the candles on top, and beside it
 * the liquidation map: what is still outstanding at each price now, with cumulative totals from the
 * current price outwards.
 */
export function LiquidationHeatmapView({ heatmap, window: windowId, onWindow, loading }: { heatmap: Heatmap; window: HeatmapWindow; onWindow: (w: HeatmapWindow) => void; loading: boolean }) {
  const { t, lang } = useT();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const updatePrefs = (p: Partial<typeof prefs>) =>
    setPrefs((cur) => {
      const next = { ...cur, ...p };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify({ ...next, v: 2 }));
      } catch {
        /* private mode */
      }
      return next;
    });

  const cells = useMemo(() => decode(heatmap.data), [heatmap.data]);
  const lut = useMemo(() => makeLut(prefs.threshold), [prefs.threshold]);
  const cols = heatmap.t.length;
  const R = heatmap.rows;
  const yMin = heatmap.priceMin;
  const yMax = heatmap.priceMin + R * heatmap.priceStep;
  const last = heatmap.candles[cols - 1];

  // Liquidation map: outstanding notional per row and the running totals from the current price outwards.
  const map = useMemo(() => {
    const long = heatmap.profile?.long ?? new Array(R).fill(0);
    const short = heatmap.profile?.short ?? new Array(R).fill(0);
    const priceRow = Math.floor((last.c - heatmap.priceMin) / heatmap.priceStep);
    const cumLong = new Float64Array(R);
    const cumShort = new Float64Array(R);
    let acc = 0;
    for (let r = Math.min(R - 1, priceRow); r >= 0; r--) cumLong[r] = acc += long[r];
    acc = 0;
    for (let r = Math.max(0, priceRow); r < R; r++) cumShort[r] = acc += short[r];
    let maxRow = 1;
    for (let r = 0; r < R; r++) maxRow = Math.max(maxRow, long[r] + short[r]);
    return { long, short, cumLong, cumShort, priceRow, maxRow, maxCum: Math.max(1, cumLong[0] ?? 0, cumShort[R - 1] ?? 0) };
  }, [heatmap, R, last.c]);

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
  const xOf = (col: number) => plotX + ((col + 0.5) / cols) * plotW;
  const yOf = (price: number) => plotH - ((price - yMin) / (yMax - yMin)) * plotH;
  const rowH = plotH / R;

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

    // Heat cells: one pixel per cell in a small bitmap, stretched over the plot without smoothing.
    const bmp = document.createElement('canvas');
    bmp.width = cols;
    bmp.height = R;
    const bctx = bmp.getContext('2d')!;
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
    ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotX, 0, plotW, plotH);
    ctx.clip();
    ctx.drawImage(bmp, plotX, 0, plotW, plotH);

    // Candles on top, with a dark outline so they stay readable over bright cells.
    const bodyW = Math.max(1, Math.min(5, (plotW / cols) * 0.6));
    for (let c = 0; c < cols; c++) {
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
    ctx.restore();

    // Current price across the plot and the map.
    const yPx = Math.round(yOf(last.c)) + 0.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = UI.ink2;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotX, yPx);
    ctx.lineTo(plotX + plotW, yPx);
    if (showMap) {
      ctx.moveTo(mapX, yPx);
      ctx.lineTo(mapX + mapW, yPx);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Colour scale on the left, labelled in USD per cell.
    const barX = 14;
    const barW = 10;
    const grad = ctx.createLinearGradient(0, plotH - 4, 0, 14);
    for (let s = 0; s <= 10; s++) grad.addColorStop(s / 10, rgb(ramp(s / 10)));
    ctx.fillStyle = grad;
    ctx.fillRect(barX, 14, barW, plotH - 18);
    ctx.fillStyle = UI.mute;
    ctx.font = '10px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(fmtCompactUsd(heatmap.maxUsd * Math.max(0.05, prefs.threshold)), 2, 12);
    ctx.textBaseline = 'top';
    ctx.fillText('0', 14, plotH - 2);

    // Axes: prices on the right of the heatmap, dates along the bottom.
    ctx.font = '11px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = UI.line;
    ctx.beginPath();
    ctx.moveTo(plotX + plotW + 0.5, 0);
    ctx.lineTo(plotX + plotW + 0.5, plotH);
    ctx.moveTo(plotX, plotH + 0.5);
    ctx.lineTo(plotX + plotW, plotH + 0.5);
    ctx.stroke();
    const span = yMax - yMin;
    const step = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000].find((s) => span / s <= 9) ?? 100000;
    for (let p = Math.ceil(yMin / step) * step; p < yMax; p += step) {
      if (Math.abs(yOf(p) - yPx) < 9) continue;
      ctx.fillText(p.toLocaleString('en-US'), plotX + plotW + 6, yOf(p));
    }
    // Current price tag.
    ctx.fillStyle = UI.ink;
    ctx.fillRect(plotX + plotW + 1, yPx - 8, AXIS_RIGHT - 2, 16);
    ctx.fillStyle = UI.bg;
    ctx.font = '600 10px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(Math.round(last.c).toLocaleString('en-US'), plotX + plotW + 5, yPx);
    ctx.font = '11px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = UI.mute;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const ticks = Math.max(2, Math.floor(plotW / 110));
    const spanDays = (heatmap.t[cols - 1] - heatmap.t[0]) / 86_400;
    for (let i = 0; i <= ticks; i++) {
      const c = Math.min(cols - 1, Math.round((i / ticks) * (cols - 1)));
      const d = new Date(heatmap.t[c] * 1000);
      const day = `${d.getUTCDate()} ${d.toLocaleString(LOCALE[lang], { month: 'short', timeZone: 'UTC' })}`;
      const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
      const label = spanDays <= 4 ? `${day} ${time}` : spanDays > 300 ? `${d.toLocaleString(LOCALE[lang], { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}` : day;
      ctx.fillText(label, Math.max(plotX + 30, Math.min(plotX + plotW - 30, xOf(c))), plotH + 5);
    }

    // Liquidation map: bars coloured like the heatmap, cumulative curves from the current price outwards.
    if (showMap) {
      ctx.fillStyle = UI.bg;
      ctx.fillRect(mapX, 0, mapW, plotH);
      const barMax = mapW - 6;
      for (let r = 0; r < R; r++) {
        const v = map.long[r] + map.short[r];
        if (v <= 0) continue;
        const frac = v / map.maxRow;
        const y = plotH - (r + 1) * rowH;
        ctx.fillStyle = rgb(ramp(Math.max(0.3, Math.min(1, frac / Math.max(0.05, prefs.threshold)))));
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
          const y = plotH - (r + 0.5) * rowH;
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
      ctx.fillStyle = UI.mute;
      ctx.font = '10px Inter, ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(t('Liquidation map'), mapX + 4, plotH + 5);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatmap, cells, lut, width, showMap, lang, map]);

  // What is under the cursor: a heat cell, or a row of the liquidation map.
  let tip: { kind: 'heat'; col: number; price: number; usd: number } | { kind: 'map'; row: number; price: number } | null = null;
  if (hover && hover.y < plotH) {
    const price = yMin + (1 - hover.y / plotH) * (yMax - yMin);
    const row = Math.max(0, Math.min(R - 1, Math.floor((price - heatmap.priceMin) / heatmap.priceStep)));
    if (hover.x >= plotX && hover.x < plotX + plotW) {
      const col = Math.min(cols - 1, Math.max(0, Math.floor(((hover.x - plotX) / plotW) * cols)));
      tip = { kind: 'heat', col, price, usd: (cells[row * cols + col] / 255) * heatmap.maxUsd };
    } else if (showMap && hover.x >= mapX) tip = { kind: 'map', row, price };
  }
  const distPct = (p: number) => ((p / last.c - 1) * 100).toFixed(1);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="num flex flex-wrap items-center gap-x-3 text-[11px] text-ink2">
          <span className="font-semibold text-ink">{t('BTC/USDT · estimated liquidation levels · {tf} bars', { tf: TF_INFO[heatmap.timeframe].label })}</span>
          <span>{t('last {price}', { price: fmtUsd(last.c) })}</span>
          {loading && <span className="text-mute">{t('loading {window}…', { window: windowId })}</span>}
        </div>
        <div className="thin-scroll max-w-full overflow-x-auto">
          <Segmented label={t('Heatmap window')} size="sm" value={windowId} onChange={onWindow} options={HEATMAP_WINDOWS.map((w) => ({ value: w, label: w === 'All' ? t('All') : w }))} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-1.5 border-b border-line px-3 py-1.5 text-[11px] text-ink2">
        <label className="flex items-center gap-2" title={t('Where the colour scale tops out, as a share of the largest cluster: lower it to light up more levels, raise it to keep only the biggest ones bright.')}>
          <span>{t('Liquidity threshold')}</span>
          <input
            type="range"
            min={0.05}
            max={1}
            step={0.05}
            value={prefs.threshold}
            onChange={(e) => updatePrefs({ threshold: +e.target.value })}
            className="h-1 w-28 cursor-pointer accent-[#3987e5]"
            aria-label={t('Liquidity threshold')}
          />
          <span className="num w-8 text-ink">{prefs.threshold.toFixed(2)}</span>
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={prefs.showMap} onChange={(e) => updatePrefs({ showMap: e.target.checked })} className="accent-[#3987e5]" />
          <span>{t('Liquidation map')}</span>
        </label>
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
        <canvas ref={canvas} style={{ width, height: HEIGHT }} className="block" role="img" aria-label={t('Heatmap of estimated liquidation levels by price and time, with candles')} />
        {tip && hover && (
          <>
            {tip.kind === 'heat' && <div className="pointer-events-none absolute top-0 w-px bg-mute/60" style={{ left: hover.x, height: plotH }} />}
            <div className="pointer-events-none absolute h-px bg-mute/60" style={{ top: hover.y, left: plotX, width: width - plotX }} />
            <div
              className="num pointer-events-none absolute z-10 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[11px] shadow-lg"
              style={{ left: Math.max(4, Math.min(hover.x + 14, width - 230)), top: Math.max(4, Math.min(hover.y + 14, plotH - 90)) }}
            >
              <div className="font-medium text-ink">
                {fmtUsd(tip.price)} <span className="text-mute">({+distPct(tip.price) > 0 ? '+' : ''}{distPct(tip.price)}%)</span>
              </div>
              {tip.kind === 'heat' ? (
                <>
                  <div className="text-ink2">
                    {new Date(heatmap.t[tip.col] * 1000).toLocaleString(LOCALE[lang], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC
                  </div>
                  <div className="text-ink2">
                    {t('Est. liquidations')} <span className="text-ink">{tip.usd > 0 ? `≈ ${fmtCompactUsd(tip.usd)}` : t('none')}</span>
                  </div>
                  <div className="text-mute">{t('Candle close {price}', { price: fmtUsd(heatmap.candles[tip.col].c) })}</div>
                </>
              ) : (
                <>
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
          </>
        )}
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
