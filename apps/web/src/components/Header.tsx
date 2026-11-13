import type { Overview, Ticker } from '@smart-btc/shared';
import clsx from 'clsx';
import { Info, RefreshCw, TrendingUp } from 'lucide-react';
import { fmtCompactUsd, fmtPct, fmtUsd } from '../lib/format';

export function Header({
  ticker,
  overview,
  onRefresh,
  refreshing,
  onOpenData,
  explain,
  onExplain,
}: {
  ticker?: Ticker;
  overview?: Overview;
  onRefresh: () => void;
  refreshing: boolean;
  onOpenData: () => void;
  /** "Explain on hover" switch; omitted while the app is still loading. */
  explain?: boolean;
  onExplain?: (on: boolean) => void;
}) {
  const sources = overview?.sources ?? [];
  const live = sources.filter((s) => s.status === 'ok').length;
  const allLive = sources.length > 0 && live === sources.length;
  const price = ticker?.price ?? overview?.price;
  const change = ticker?.change24hPct;

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1900px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-raised">
            <TrendingUp size={16} className="text-[#c98500]" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-semibold text-ink">Smart BTC</div>
            <div className="text-[10px] text-mute">Probabilistic outlook from history</div>
          </div>
        </div>

        <div className="num flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold text-ink">{fmtUsd(price, 2)}</span>
            {change != null && <span className={clsx('text-sm font-medium', change >= 0 ? 'text-up' : 'text-down')}>{fmtPct(change, 2)} 24h</span>}
          </div>
          {ticker && (
            <div className="hidden gap-3 text-[11px] text-mute xl:flex">
              <span>24h high <span className="text-ink2">{fmtUsd(ticker.high24h)}</span></span>
              <span>low <span className="text-ink2">{fmtUsd(ticker.low24h)}</span></span>
              <span>volume <span className="text-ink2">{fmtCompactUsd(ticker.volume24hUsd)}</span></span>
              <span>via {ticker.source}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {onExplain && (
            <button
              onClick={() => onExplain(!explain)}
              role="switch"
              aria-checked={!!explain}
              title={explain ? 'Explanations appear when you rest the cursor on a metric or a chart line. Click to turn them off.' : 'Turn on explanations when hovering metrics and chart lines.'}
              className={clsx('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', explain ? 'border-accent/50 bg-accent/15 text-ink' : 'border-line text-mute hover:bg-raised')}
            >
              <Info size={13} /> Hints {explain ? 'on' : 'off'}
            </button>
          )}
          <button onClick={onOpenData} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink2 hover:bg-raised" title="Data source status">
            <span className={clsx('h-2 w-2 rounded-full', allLive ? 'bg-good' : sources.length ? 'bg-warn' : 'bg-mute')} />
            {sources.length ? `${live}/${sources.length} sources live` : 'Connecting…'}
          </button>
          <button onClick={onRefresh} disabled={refreshing} aria-label="Sync data now" title="Sync data now" className="rounded-md border border-line p-1.5 text-ink2 hover:bg-raised disabled:opacity-50">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>
    </header>
  );
}
