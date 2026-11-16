import { LANGS, LANG_NAME, type Lang, type Overview, type Ticker } from '@smart-btc/shared';
import clsx from 'clsx';
import { Globe, Info, RefreshCw, TrendingUp } from 'lucide-react';
import { fmtCompactUsd, fmtPct, fmtUsd } from '../lib/format';
import { useT } from '../lib/i18n';

export function Header({
  ticker,
  overview,
  onRefresh,
  refreshing,
  onOpenData,
  explain,
  onExplain,
  lang,
  onLang,
}: {
  ticker?: Ticker;
  overview?: Overview;
  onRefresh: () => void;
  refreshing: boolean;
  onOpenData: () => void;
  /** "Explain on hover" switch; omitted while the app is still loading. */
  explain?: boolean;
  onExplain?: (on: boolean) => void;
  lang: Lang;
  onLang: (lang: Lang) => void;
}) {
  const { t } = useT();
  // Sources the user switched off are not expected to be live.
  const sources = (overview?.sources ?? []).filter((s) => s.status !== 'off');
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
            <div className="text-[10px] text-mute">{t('Probabilistic outlook from history')}</div>
          </div>
        </div>

        <div className="num flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold text-ink">{fmtUsd(price, 2)}</span>
            {change != null && <span className={clsx('text-sm font-medium', change >= 0 ? 'text-up' : 'text-down')}>{fmtPct(change, 2)} 24h</span>}
          </div>
          {ticker && (
            <div className="hidden gap-3 text-[11px] text-mute xl:flex">
              <span>
                {t('24h high')} <span className="text-ink2">{fmtUsd(ticker.high24h)}</span>
              </span>
              <span>
                {t('low')} <span className="text-ink2">{fmtUsd(ticker.low24h)}</span>
              </span>
              <span>
                {t('volume')} <span className="text-ink2">{fmtCompactUsd(ticker.volume24hUsd)}</span>
              </span>
              <span>{t('via {source}', { source: ticker.source })}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-xs text-ink2 hover:bg-raised" title={t('Language')}>
            <Globe size={13} className="text-mute" />
            <select
              value={lang}
              onChange={(e) => onLang(e.target.value as Lang)}
              aria-label={t('Language')}
              className="cursor-pointer bg-transparent py-0.5 text-xs text-ink2 outline-none [&>option]:bg-panel"
            >
              {LANGS.map((l) => (
                <option key={l} value={l}>
                  {LANG_NAME[l]}
                </option>
              ))}
            </select>
          </label>
          {onExplain && (
            <button
              onClick={() => onExplain(!explain)}
              role="switch"
              aria-checked={!!explain}
              title={explain ? t('Explanations appear when you rest the cursor on a metric or a chart line. Click to turn them off.') : t('Turn on explanations when hovering metrics and chart lines.')}
              className={clsx('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', explain ? 'border-accent/50 bg-accent/15 text-ink' : 'border-line text-mute hover:bg-raised')}
            >
              <Info size={13} /> {explain ? t('Hints on') : t('Hints off')}
            </button>
          )}
          <button onClick={onOpenData} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink2 hover:bg-raised" title={t('Data source status')}>
            <span className={clsx('h-2 w-2 rounded-full', allLive ? 'bg-good' : sources.length ? 'bg-warn' : 'bg-mute')} />
            {sources.length ? t('{live}/{total} sources live', { live, total: sources.length }) : t('Connecting…')}
          </button>
          <button onClick={onRefresh} disabled={refreshing} aria-label={t('Sync data now')} title={t('Sync data now')} className="rounded-md border border-line p-1.5 text-ink2 hover:bg-raised disabled:opacity-50">
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>
    </header>
  );
}
