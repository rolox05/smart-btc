import clsx from 'clsx';
import { useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';

/** Width the chart column always keeps while a side panel is dragged wider. */
const MIN_CENTER = 420;

/**
 * Vertical drag handle on the inner edge of a side panel. While dragging it writes the width straight
 * into a CSS variable on the layout grid (no React re-render per pixel, so the charts stay smooth) and
 * reports the final width once the pointer is released. Double-click resets to the default width.
 */
export function ResizeHandle({
  edge,
  cssVar,
  min,
  max,
  label,
  onCommit,
  className,
}: {
  /** Which edge of its panel the handle sits on: 'right' for the left panel, 'left' for the right one. */
  edge: 'left' | 'right';
  cssVar: string;
  min: number;
  max: number;
  label: string;
  onCommit: (width: number | null) => void;
  className?: string;
}) {
  const drag = useRef<{ x: number; w: number; lo: number; hi: number; last: number } | null>(null);

  const grid = (el: HTMLElement) => el.closest<HTMLElement>('[data-resizable-grid]');
  const limits = (el: HTMLElement) => {
    const panel = el.parentElement!;
    const w = panel.getBoundingClientRect().width;
    const center = grid(el)?.querySelector<HTMLElement>('[data-center-panel]')?.getBoundingClientRect().width ?? Infinity;
    return { w, lo: min, hi: Math.max(min, Math.min(max, w + center - MIN_CENTER)) };
  };
  const apply = (el: HTMLElement, width: number) => grid(el)?.style.setProperty(cssVar, `${Math.round(width)}px`);
  const sign = edge === 'right' ? 1 : -1;

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const { w, lo, hi } = limits(e.currentTarget);
    drag.current = { x: e.clientX, w, lo, hi, last: w };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.last = Math.min(d.hi, Math.max(d.lo, d.w + sign * (e.clientX - d.x)));
    apply(e.currentTarget, d.last);
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (Math.abs(d.last - d.w) >= 1) onCommit(Math.round(d.last));
  };
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    grid(e.currentTarget)?.style.removeProperty(cssVar);
    onCommit(null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const { w, lo, hi } = limits(e.currentTarget);
    const step = (e.shiftKey ? 64 : 16) * (e.key === 'ArrowRight' ? 1 : -1) * sign;
    const next = Math.round(Math.min(hi, Math.max(lo, w + step)));
    apply(e.currentTarget, next);
    onCommit(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className={clsx(
        'group absolute top-0 bottom-0 z-20 w-3 cursor-col-resize touch-none outline-none',
        edge === 'right' ? '-right-3' : '-left-3',
        className,
      )}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent group-active:bg-accent" />
    </div>
  );
}
