import type { LiquidationFeed } from '@smart-btc/shared';
import clsx from 'clsx';
import { fmtCompactUsd, fmtUsd } from '../lib/format';
import { LOCALE, useT } from '../lib/i18n';
import { UI } from '../lib/palette';
import { Card, Td, Th } from './ui';

/** Forced liquidations as the exchanges report them, received over websockets and stored locally. */
export function LiveLiquidations({ feed }: { feed: LiquidationFeed }) {
  const { t, lang } = useT();
  const time = (ms: number) => new Date(ms).toLocaleTimeString(LOCALE[lang], { hour: '2-digit', minute: '2-digit' });
  const day = feed.totals.find((x) => x.window === '24h');
  const maxProfile = Math.max(1, ...feed.profile.map((p) => p.longUsd + p.shortUsd));

  return (
    <Card
      title={t('Live liquidations · Binance + Bybit')}
      right={
        <div className="flex items-center gap-2.5 text-[11px] text-ink2">
          {feed.venues.map((v) => (
            <span key={v.venue} className="flex items-center gap-1" title={v.connected ? t('Connected') : (v.error ?? t('Reconnecting…'))}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: v.connected ? UI.good : UI.crit }} />
              {v.venue}
            </span>
          ))}
        </div>
      }
    >
      <table className="w-full">
        <thead>
          <tr>
            <Th>{t('Window')}</Th>
            <Th right>{t('Longs liquidated')}</Th>
            <Th right>{t('Shorts liquidated')}</Th>
            <Th right>{t('Prints')}</Th>
          </tr>
        </thead>
        <tbody>
          {feed.totals.map((x) => (
            <tr key={x.window} className="border-t border-line">
              <Td className="text-ink2">{x.window}</Td>
              <Td right className="text-down">{fmtCompactUsd(x.longUsd)}</Td>
              <Td right className="text-up">{fmtCompactUsd(x.shortUsd)}</Td>
              <Td right className="text-mute">{x.count}</Td>
            </tr>
          ))}
        </tbody>
      </table>

      {day && day.count === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-mute">{t('No liquidation received yet. The exchanges only publish them as they happen, so the record starts now and fills in as the market moves.')}</p>
      ) : (
        <>
          {feed.profile.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-mute">{t('Where they happened (24h)')}</div>
              <div className="flex flex-col gap-0.5">
                {feed.profile.map((p) => (
                  <div key={p.price} className="num flex items-center gap-2 text-[11px]">
                    <span className="w-16 shrink-0 text-ink2">{fmtUsd(p.price)}</span>
                    <div className="flex h-2 min-w-0 flex-1 gap-px overflow-hidden rounded-sm">
                      <div style={{ width: `${(p.longUsd / maxProfile) * 100}%`, background: UI.down }} title={t('Longs liquidated')} />
                      <div style={{ width: `${(p.shortUsd / maxProfile) * 100}%`, background: UI.up }} title={t('Shorts liquidated')} />
                    </div>
                    <span className="w-14 shrink-0 text-right text-mute">{fmtCompactUsd(p.longUsd + p.shortUsd)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {feed.largest.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-wider text-mute">{t('Largest in the last 24h')}</div>
              <ul className="num flex flex-col text-[11px]">
                {feed.largest.slice(0, 8).map((p, i) => (
                  <li key={`${p.t}:${i}`} className="flex items-center justify-between gap-2 border-t border-line py-1 first:border-t-0">
                    <span className="text-mute">{time(p.t)}</span>
                    <span className={clsx('w-12', p.side === 'long' ? 'text-down' : 'text-up')}>{t(p.side)}</span>
                    <span className="text-ink2">{fmtUsd(p.price)}</span>
                    <span className="text-ink">{fmtCompactUsd(p.usd)}</span>
                    <span className="w-14 text-right text-mute">{p.venue}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-mute">
        {feed.since
          ? t('Real liquidations from the exchange websockets, stored locally since {date}. Both exchanges sample their feeds (Binance sends at most one order per second), so totals are a floor.', { date: new Date(feed.since).toLocaleDateString(LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric' }) })
          : t('Real liquidations from the exchange websockets, stored locally from now on. Both exchanges sample their feeds (Binance sends at most one order per second), so totals are a floor.')}
      </p>
    </Card>
  );
}
