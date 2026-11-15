import type { EventsReport, MarketEventKind } from '@smart-btc/shared';
import { fmtCompactUsd, fmtProb, fmtUsd } from '../lib/format';
import { LOCALE, useT } from '../lib/i18n';
import { SERIES, UI } from '../lib/palette';
import { Badge, Card, Note, Td, Th } from './ui';

const KIND_COLOR: Record<MarketEventKind, string> = { fomc: SERIES[0], cpi: SERIES[1], expiry: SERIES[2] };

/** Scheduled macro and derivatives events, how Bitcoin behaved on past ones, and ETF activity. */
export function EventsPanel({ report }: { report: EventsReport }) {
  const { t, lang } = useT();
  const today = Math.floor(Date.now() / 86_400_000) * 86_400;
  const fmtDay = (sec: number) => new Date(sec * 1000).toLocaleDateString(LOCALE[lang], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const kindName: Record<MarketEventKind, string> = { fomc: t('Fed'), cpi: t('Inflation'), expiry: t('Options') };
  const maxEtf = report.etf ? Math.max(...report.etf.series.map((p) => p.usd)) : 1;

  return (
    <div className="flex flex-col gap-3">
      <Card title={t('Upcoming events')}>
        {report.upcoming.length === 0 && <p className="text-xs text-mute">{t('No scheduled event in the next four months.')}</p>}
        <ul className="flex flex-col">
          {report.upcoming.slice(0, 9).map((e) => {
            const days = Math.round((e.t - today) / 86_400);
            return (
              <li key={`${e.kind}:${e.t}`} className="flex gap-2.5 border-t border-line py-2 first:border-t-0 first:pt-0">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[e.kind] }} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="text-xs font-medium text-ink">{e.title}</span>
                    <span className="num text-[11px] text-ink2">
                      {fmtDay(e.t)} · {days <= 0 ? t('today') : days === 1 ? t('tomorrow') : t('in {n} days', { n: days })}
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-mute">{e.detail}</p>
                </div>
                {e.estimated && <Badge tone="warn" title={t('The official calendar is not available to programs; the date follows the usual pattern and can be off by a few days.')}>{t('est.')}</Badge>}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title={t('How Bitcoin moved on past event days')}>
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full min-w-[400px]">
            <thead>
              <tr>
                <Th>{t('Event')}</Th>
                <Th right title={t('Number of past event days measured')}>{t('Days')}</Th>
                <Th right title={t('Average absolute daily move on event days, and on all other days')}>{t('Avg move · normal')}</Th>
                <Th right title={t('Variance of volatility-adjusted returns on event days relative to other days. Above 1: riskier than a normal day.')}>{t('Risk vs normal')}</Th>
                <Th right title={t('Share of event days that closed higher')}>{t('Closed up')}</Th>
              </tr>
            </thead>
            <tbody>
              {report.studies.map((s) => (
                <tr key={s.kind} className="border-t border-line">
                  <Td className="text-ink2">
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: KIND_COLOR[s.kind] }} />
                    {s.name}
                  </Td>
                  <Td right className="text-mute">{s.n}</Td>
                  <Td right className="text-ink2">
                    {s.avgAbsMovePct.toFixed(2)}% · {s.normalAbsMovePct.toFixed(2)}%
                  </Td>
                  <Td right className={s.varianceRatio > 1.1 ? 'font-medium text-warn' : 'text-ink2'}>{Number.isFinite(s.varianceRatio) ? `${s.varianceRatio.toFixed(2)}×` : '–'}</Td>
                  <Td right className="text-ink2">{fmtProb(s.upShare)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          {t('"Risk vs normal" is what the Models tab uses: an event inside the forecast horizon widens the range only if past ones were riskier than ordinary days. Daily bars hide the first minutes after a release, where most of the reaction happens.')}
        </p>
      </Card>

      {report.expiries.length > 0 && (
        <Card title={t('Option expiries (Deribit)')}>
          <div className="thin-scroll overflow-x-auto">
            <table className="w-full min-w-[400px]">
              <thead>
                <tr>
                  <Th>{t('Expiry')}</Th>
                  <Th right>{t('Open interest')}</Th>
                  <Th right title={t('Put open interest divided by call open interest. Above 1: more downside protection than upside bets.')}>{t('Put / call')}</Th>
                  <Th right title={t('Settlement price at which option holders collect the least. Price sometimes drifts toward it into a large expiry.')}>{t('Max pain')}</Th>
                </tr>
              </thead>
              <tbody>
                {report.expiries.map((e) => (
                  <tr key={e.t} className="border-t border-line">
                    <Td className="text-ink2">
                      {e.label} {e.monthly && <span className="text-[10px] uppercase tracking-wider text-mute">· {t('monthly')}</span>}
                    </Td>
                    <Td right className="text-ink2">
                      {fmtCompactUsd(e.notionalUsd)} <span className="text-mute">· {Math.round(e.openInterestBtc).toLocaleString('en-US')} BTC</span>
                    </Td>
                    <Td right className="text-ink2">{Number.isFinite(e.putCallRatio) ? e.putCallRatio.toFixed(2) : '–'}</Td>
                    <Td right className="text-ink2">{fmtUsd(e.maxPain)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {report.inflation.length > 0 && (
        <Card title={t('US inflation (CPI)')}>
          <div className="flex items-end gap-1.5" style={{ height: 84 }}>
            {report.inflation.map((m) => (
              <div key={m.month} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1" title={t('{month}: {yoy}% over a year, {mom}% over the month', { month: m.month, yoy: m.yoyPct.toFixed(1), mom: m.momPct.toFixed(2) })}>
                <span className="num text-[10px] text-ink2">{m.yoyPct.toFixed(1)}</span>
                <div className="w-full rounded-sm" style={{ height: `${Math.max(4, (m.yoyPct / Math.max(...report.inflation.map((x) => x.yoyPct), 0.1)) * 48)}px`, background: SERIES[1] }} />
                <span className="num text-[9px] text-mute">{m.month.slice(5)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-mute">{t('Year-over-year change of the consumer price index, in %, by month (seasonally adjusted series from the BLS). Rising inflation pushes rate cuts further away, which has weighed on risk assets.')}</p>
        </Card>
      )}

      {report.etf && (
        <Card title={t('Spot ETF activity (IBIT)')}>
          <div className="num flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
            <span className="text-ink">
              <span className="text-base font-semibold">{fmtCompactUsd(report.etf.lastUsd)}</span> {t('last session')}
            </span>
            <span className="text-ink2">{t('30-day average {usd}', { usd: fmtCompactUsd(report.etf.avg30Usd) })}</span>
            <Badge tone={report.etf.ratio > 1.5 ? 'warn' : 'neutral'}>{t('{x}× average', { x: report.etf.ratio.toFixed(2) })}</Badge>
          </div>
          <div className="mt-2 flex items-end gap-0.5" style={{ height: 56 }} role="img" aria-label={t('Daily dollar volume of the ETF over the last 30 sessions')}>
            {report.etf.series.map((p) => (
              <div key={p.t} className="min-w-0 flex-1 rounded-sm" title={`${fmtDay(p.t)}: ${fmtCompactUsd(p.usd)}`} style={{ height: `${Math.max(2, (p.usd / maxEtf) * 56)}px`, background: p.usd > (report.etf?.avg30Usd ?? 0) * 1.5 ? UI.warn : UI.accent, opacity: 0.85 }} />
            ))}
          </div>
        </Card>
      )}

      {report.notes.map((n) => (
        <Note key={n}>{n}</Note>
      ))}
    </div>
  );
}
