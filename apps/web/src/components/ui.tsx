import clsx from 'clsx';
import { AlertTriangle, Info, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';

/**
 * Explanation card shown beside an element after a short hover. Rendered in a portal so that
 * scrolling containers cannot clip it. Inert when `enabled` is false (the user turned hints off).
 */
export function HoverCard({ enabled, content, children, className }: { enabled: boolean; content: ReactNode; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const hide = () => {
    window.clearTimeout(timer.current);
    setPos(null);
  };
  useEffect(() => hide, []);
  useEffect(() => {
    if (!enabled) hide();
  }, [enabled]);
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const box = ref.current?.getBoundingClientRect();
      if (!box) return;
      const width = 288;
      // Prefer the right side; fall back to the left, then to below on narrow screens.
      const right = box.right + 8;
      const left = right + width <= window.innerWidth ? right : box.left - width - 8 >= 0 ? box.left - width - 8 : Math.max(8, window.innerWidth - width - 8);
      const below = left < box.right && left + width > box.left;
      setPos({ left, top: below ? Math.min(box.bottom + 6, window.innerHeight - 180) : Math.max(8, Math.min(box.top - 4, window.innerHeight - 240)) });
    }, 280);
  };
  return (
    <div ref={ref} className={className} onMouseEnter={enabled ? show : undefined} onMouseLeave={hide}>
      {children}
      {pos &&
        enabled &&
        createPortal(
          <div role="tooltip" className="pointer-events-none fixed z-50 w-72 rounded-md border border-line bg-raised px-3 py-2.5 text-[11px] leading-relaxed text-ink2 shadow-xl" style={pos}>
            {content}
          </div>,
          document.body,
        )}
    </div>
  );
}

export function Card({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-lg border border-line bg-panel', className)}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink2">{title}</h3>
          {right}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="min-w-0 rounded-md bg-raised px-2.5 py-2">
      <div className="truncate text-[10px] uppercase tracking-wider text-mute">{label}</div>
      <div className={clsx('num mt-0.5 truncate text-[15px] font-semibold', tone === 'up' && 'text-up', tone === 'down' && 'text-down')}>
        {value}
      </div>
      {sub && <div className="num mt-0.5 truncate text-[11px] text-mute">{sub}</div>}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  label?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line bg-bg p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'num rounded px-2 font-medium transition-colors',
            size === 'sm' ? 'py-0.5 text-[11px]' : 'py-1 text-xs',
            o.value === value ? 'bg-raised text-ink' : 'text-mute hover:text-ink2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Labelled range slider with the current value shown on the right. */
export function Slider({
  label,
  value,
  onChange,
  min,
  max,
  step,
  display,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  display: string;
  hint?: string;
}) {
  return (
    <label className="block min-w-0" title={hint}>
      <span className="mb-1 flex items-baseline justify-between gap-2 text-[10px] uppercase tracking-wider text-mute">
        <span className="truncate">{label}</span>
        <span className="num normal-case tracking-normal text-[11px] text-ink">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="h-1 w-full cursor-pointer accent-[#3987e5]"
        aria-label={label}
      />
    </label>
  );
}

export function Switch({ checked, onChange, label, bare, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; /** Show the switch alone; the label is still read out. */ bare?: boolean; disabled?: boolean }) {
  return (
    <label className={clsx('flex cursor-pointer items-center justify-between gap-3 text-xs text-ink2', !bare && 'py-1', disabled && 'cursor-default opacity-50')}>
      {!bare && <span>{label}</span>}
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative h-4 w-7 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line')}
      >
        <span className={clsx('absolute top-0.5 h-3 w-3 rounded-full bg-ink transition-all', checked ? 'left-3.5' : 'left-0.5')} />
      </button>
    </label>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  hint,
  ariaLabel,
}: {
  /** Visible caption; pass '' with `ariaLabel` when a heading next to the field already names it. */
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  hint?: string;
  ariaLabel?: string;
}) {
  return (
    <label className="block min-w-0" title={hint}>
      {label && <span className="mb-1 block truncate text-[10px] uppercase tracking-wider text-mute">{label}</span>}
      <span className="flex items-center rounded-md border border-line bg-bg focus-within:border-accent">
        <input
          type="number"
          className="num w-full min-w-0 bg-transparent px-2 py-1 text-xs text-ink outline-none"
          aria-label={ariaLabel ?? label}
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = e.target.valueAsNumber;
            if (!Number.isFinite(v)) return;
            onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
          }}
        />
        {suffix && <span className="pr-2 text-[11px] text-mute">{suffix}</span>}
      </span>
    </label>
  );
}

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'crit' | 'accent'; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        tone === 'neutral' && 'bg-raised text-ink2',
        tone === 'good' && 'bg-good/15 text-[#5fd35f]',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'crit' && 'bg-crit/20 text-[#f08a8a]',
        tone === 'accent' && 'bg-accent/15 text-[#7fb2f0]',
      )}
    >
      {children}
    </span>
  );
}

/** Horizontal probability bar with an optional base-rate tick for comparison. */
export function ProbBar({ value, base, color, height = 6 }: { value: number; base?: number; color: string; height?: number }) {
  return (
    <div className="relative w-full rounded-full bg-raised" style={{ height }}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, value * 100))}%`, background: color }} />
      {base != null && (
        <div
          className="absolute -top-0.5 w-0.5 rounded bg-ink"
          style={{ left: `calc(${Math.min(100, Math.max(0, base * 100))}% - 1px)`, height: height + 4 }}
          title={`Base rate ${Math.round(base * 100)}%`}
        />
      )}
    </div>
  );
}

/** Bar growing left (negative) or right (positive) from a centre line. */
export function DivergingBar({ value, scale, positive, negative }: { value: number; scale: number; positive: string; negative: string }) {
  const w = Math.min(1, Math.abs(value) / scale) * 50;
  return (
    <div className="relative h-1.5 w-16 shrink-0 rounded-full bg-raised">
      <div className="absolute left-1/2 top-[-2px] h-2.5 w-px bg-mute" />
      <div
        className="absolute top-0 h-full rounded-full"
        style={value >= 0 ? { left: '50%', width: `${w}%`, background: positive } : { right: '50%', width: `${w}%`, background: negative }}
      />
    </div>
  );
}

export function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'error' }) {
  const Icon = tone === 'info' ? Info : AlertTriangle;
  return (
    <div
      className={clsx(
        'flex gap-2 rounded-md border px-2.5 py-2 text-xs leading-relaxed',
        tone === 'info' && 'border-line bg-raised/50 text-ink2',
        tone === 'warn' && 'border-warn/30 bg-warn/10 text-ink',
        tone === 'error' && 'border-crit/40 bg-crit/10 text-ink',
      )}
    >
      <Icon size={14} className={clsx('mt-0.5 shrink-0', tone === 'info' ? 'text-mute' : tone === 'warn' ? 'text-warn' : 'text-[#f08a8a]')} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-2 py-6 text-xs text-mute">
      <Loader2 size={14} className="animate-spin" />
      {label ?? t('Loading…')}
    </div>
  );
}

/** Standard async wrapper: loading, error or content. */
export function Async<T>({
  query,
  children,
  loadingLabel,
}: {
  query: { data: T | undefined; error: Error | null; isPending: boolean };
  children: (data: T) => ReactNode;
  loadingLabel?: string;
}) {
  if (query.data !== undefined) {
    return (
      <>
        {query.error && <div className="mb-2"><Note tone="error">{query.error.message}</Note></div>}
        {children(query.data)}
      </>
    );
  }
  if (query.error) return <Note tone="error">{query.error.message}</Note>;
  return <Loading label={loadingLabel} />;
}

export function Th({ children, right, title }: { children?: ReactNode; right?: boolean; title?: string }) {
  return (
    <th title={title} className={clsx('whitespace-nowrap px-1.5 py-1 text-[10px] font-medium uppercase tracking-wider text-mute', right ? 'text-right' : 'text-left')}>
      {children}
    </th>
  );
}

export function Td({ children, right, className, title }: { children?: ReactNode; right?: boolean; className?: string; title?: string }) {
  return (
    <td title={title} className={clsx('num whitespace-nowrap px-1.5 py-1 text-xs', right && 'text-right', className)}>
      {children}
    </td>
  );
}

/** Tooltip shell shared by every Recharts chart. */
export function ChartTip({ title, rows }: { title: ReactNode; rows: { label: string; value: string; color?: string }[] }) {
  return (
    <div className="rounded-md border border-line bg-raised px-2.5 py-1.5 text-xs shadow-lg">
      <div className="mb-1 font-medium text-ink">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 text-ink2">
          <span className="flex items-center gap-1.5">
            {r.color && <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className="num text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink2">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-3.5"
            style={i.dashed ? { borderTop: `2px dashed ${i.color}`, height: 0 } : { background: i.color, height: 3, borderRadius: 2 }}
          />
          {i.label}
        </span>
      ))}
    </div>
  );
}
