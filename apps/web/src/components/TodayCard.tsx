import type { EdgeState, TodayChange, TodayScenario, TodaySummary } from '@smart-btc/shared';
import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { fmtBarTime, fmtCompactUsd, fmtDate, fmtPct, fmtProb, fmtUsd } from '../lib/format';
import { msg, useT } from '../lib/i18n';
import { UI } from '../lib/palette';
import { Badge, Card, Loading, Note, ProbBar } from './ui';

const EDGE: Record<EdgeState, { label: string; tone: 'neutral' | 'warn' | 'good'; hint: string }> = {
  none: { label: 'No edge', tone: 'neutral', hint: 'The models say nothing a plain historical average would not. That is the usual state.' },
  weak: { label: 'Weak edge', tone: 'warn', hint: 'The models differ from the historical average, but they disagree with each other, rest on few comparable days, or have barely beaten the average in testing.' },
  present: { label: 'Edge', tone: 'good', hint: 'The models agree, differ clearly from the historical average, and have beaten it in testing at this horizon. Still a tilt in the odds, not a certainty.' },
};

const SCENARIO: Record<TodayScenario['id'], { label: string; color: string }> = {
  bull: { label: 'Bull', color: UI.up },
  base: { label: 'Base', color: UI.mute },
  bear: { label: 'Bear', color: UI.down },
};

const WORD: Record<string, string> = {
  up: msg('upward'), down: msg('downward'), neutral: msg('no lean'),
  none: msg('no edge'), weak: msg('weak edge'), present: msg('clear edge'),
  low: msg('low confidence'), moderate: msg('moderate confidence'), good: msg('good confidence'),
};
const CHANGE_LABEL: Record<TodayChange['field'], string> = {
  pUp: msg('Chance of a rise'),
  medianPct: msg('Median outcome'),
  edge: msg('Edge'),
  confidence: msg('Confidence'),
  direction: msg('Lean'),
};

interface Props {
  query: { data: TodaySummary | undefined; error: Error | null; isFetching: boolean };
  /** Only the headline is shown. */
  collapsed: boolean;
  onCollapsed: (v: boolean) => void;
}

/** The conclusion before the evidence: one reading, three scenarios, what to watch and what changed. */
export function TodayCard({ query, collapsed, onCollapsed }: Props) {
  const { t, dur } = useT();
  const [why, setWhy] = useState(false);
  const s = query.data;

  if (!s) {
    return <Card title={t('Today')}>{query.error ? <Note tone="error">{query.error.message}</Note> : <Loading label={t('Putting the reading together…')} />}</Card>;
  }

  const h = dur(s.timeframe, s.horizon);
  const edge = EDGE[s.edge];
  const value = (c: TodayChange, x: number | string) =>
    typeof x === 'string' ? t(WORD[x] ?? x) : c.field === 'pUp' ? fmtProb(x) : fmtPct(x);
  const liq = s.levels.filter((l) => l.kind === 'liqAbove' || l.kind === 'liqBelow');
  const range = { low: s.levels.find((l) => l.kind === 'rangeLow'), high: s.levels.find((l) => l.kind === 'rangeHigh') };

  return (
    <Card
      title={t('Today · next {h}', { h })}
      right={
        <div className="flex items-center gap-1.5">
          <Badge tone={edge.tone} title={t(edge.hint)}>{t(edge.label)}</Badge>
          <button onClick={() => onCollapsed(!collapsed)} aria-expanded={!collapsed} title={t(collapsed ? 'Show the full summary' : 'Show the headline only')} className="rounded p-0.5 text-mute hover:bg-raised hover:text-ink">
            <ChevronDown size={14} className={clsx('transition-transform', !collapsed && 'rotate-180')} />
          </button>
        </div>
      }
      className={clsx(query.isFetching && 'opacity-80')}
    >
      <p className="text-sm font-medium leading-snug text-ink">{s.headline}</p>
      <p className="num mt-1 text-[11px] text-ink2">
        {t('{p} chance of a higher price · {base} on any day in history', { p: fmtProb(s.pUp), base: fmtProb(s.basePUp) })}
        {range.low && range.high && <> · {t('8 in 10 outcomes between {low} and {high}', { low: fmtUsd(range.low.price), high: fmtUsd(range.high.price) })}</>}
      </p>

      {!collapsed && (
      <>
      <table className="mt-2.5 w-full text-xs">
        <tbody>
          {[...s.scenarios].reverse().map((sc) => (
            <tr key={sc.id} className="border-t border-line">
              <td className="w-12 py-1.5 font-medium" style={{ color: SCENARIO[sc.id].color }}>{t(SCENARIO[sc.id].label)}</td>
              <td className="num w-10 py-1.5 text-right text-ink">{fmtProb(sc.probability)}</td>
              <td className="w-[30%] px-2 py-1.5"><ProbBar value={sc.probability} base={sc.baseProbability ?? undefined} color={SCENARIO[sc.id].color} /></td>
              <td className="num py-1.5 text-right text-ink2">
                {sc.id === 'bear'
                  ? t('below {price}', { price: fmtUsd(sc.highPrice) })
                  : sc.id === 'bull'
                    ? t('above {price}', { price: fmtUsd(sc.lowPrice) })
                    : `${fmtUsd(sc.lowPrice)} – ${fmtUsd(sc.highPrice)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10.5px] text-mute">{t('Where price ends after {h}, split at ±{x}%. The tick on each bar is the share in all of history.', { h, x: s.thresholdPct.toFixed(s.thresholdPct < 3 ? 1 : 0) })}</p>

      {(s.events.length > 0 || liq.length > 0) && (
        <div className="mt-2.5 border-t border-line pt-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-mute">{t('Watch')}</div>
          <ul className="mt-1 space-y-0.5 text-[11.5px] text-ink2">
            {s.events.map((e) => (
              <li key={`${e.kind}:${e.t}`} className="flex justify-between gap-2">
                <span>{e.title}{e.estimated ? ` (${t('estimated date')})` : ''}</span>
                <span className="num shrink-0 text-mute">{e.days === 0 ? t('today') : t('in {n}d', { n: e.days })} · {fmtDate(e.t, false)}</span>
              </li>
            ))}
            {liq.map((l) => (
              <li key={l.kind} className="flex justify-between gap-2">
                <span>{t(l.kind === 'liqAbove' ? 'Largest liquidation cluster above' : 'Largest liquidation cluster below')}</span>
                <span className="num shrink-0 text-mute">{fmtUsd(l.price)} ({fmtPct(l.distancePct)}) · {fmtCompactUsd(l.notionalUsd)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-2.5 border-t border-line pt-2 text-[11.5px] text-ink2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-mute">{t('What changed')}</div>
        {!s.previous ? (
          <p className="mt-1 text-mute">{t('First reading saved. Changes will show from the next bar.')}</p>
        ) : s.changes.length === 0 ? (
          <p className="mt-1 text-mute">{t('Nothing material since {when}.', { when: fmtBarTime(s.previous.asOf, s.timeframe) })}</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {s.changes.map((c) => (
              <li key={c.field} className="flex justify-between gap-2">
                <span>{t(CHANGE_LABEL[c.field])}</span>
                <span className="num shrink-0"><span className="text-mute">{value(c, c.from)} →</span> <span className="text-ink">{value(c, c.to)}</span></span>
              </li>
            ))}
            <li className="text-[10.5px] text-mute">{t('Compared with the reading of {when}.', { when: fmtBarTime(s.previous.asOf, s.timeframe) })}</li>
          </ul>
        )}
      </div>

      <button onClick={() => setWhy(!why)} aria-expanded={why} className="mt-2 flex items-center gap-1 text-[11px] text-[#7fb2f0] hover:underline">
        {t('Why this reading')} <ChevronDown size={12} className={clsx('transition-transform', why && 'rotate-180')} />
      </button>
      {why && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11.5px] leading-relaxed text-ink2">
          {s.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      </>
      )}
    </Card>
  );
}
