import { CYCLE_BACKS, CYCLE_SPANS, type CycleBack, type CyclePoint, type CycleSpan } from '@smart-btc/shared';
import clsx from 'clsx';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useCycleRepeat } from '../hooks/useData';
import { fmtCompactUsd, fmtDate, fmtPct, fmtUsd } from '../lib/format';
import { msg, useT } from '../lib/i18n';
import { SERIES, UI } from '../lib/palette';
import { ChartTip, Legend, Loading, Note, Segmented, Switch, Td, Th } from './ui';

interface Prefs {
  cycles: number[];
  span: CycleSpan;
  back: CycleBack;
  log: boolean;
}

/** Each past cycle keeps its colour whether or not the others are shown. */
const CYCLE_COLOR: Record<number, string> = { 1: SERIES[3], 2: SERIES[2], 3: SERIES[1] };
const AVERAGE_COLOR = SERIES[0];
const SPAN_LABEL: Record<CycleSpan, string> = { '6m': msg('6 months'), '1y': msg('1 year'), halving: msg('To next halving'), '2y': msg('2 years') };
const BACK_LABEL: Record<CycleBack, string> = { '6m': msg('6 months'), '1y': msg('1 year'), halving: msg('Since the halving') };

function PointCell({ p }: { p: CyclePoint | null }) {
  if (!p) return <Td right className="text-mute">–</Td>;
  return (
    <Td right>
      <span className="text-ink">{fmtUsd(p.price)}</span> <span className={p.pct >= 0 ? 'text-up' : 'text-down'}>{fmtPct(p.pct, 0)}</span>
      <div className="text-[10px] text-mute">{fmtDate(p.t)}</div>
    </Td>
  );
}

/**
 * Past halving cycles replayed from today's price: pick which cycles to follow, and the chart shows
 * where price would go if the rest of this cycle moved like each of them, and like their average.
 */
export function CycleRepeatView({ prefs, onPrefs }: { prefs: Prefs; onPrefs: (p: Prefs) => void }) {
  const { t } = useT();
  const query = useCycleRepeat(prefs.cycles, prefs.span, prefs.back, true);
  const r = query.data;
  if (!r) {
    return <div className="px-3">{query.error ? <div className="py-4"><Note tone="error">{query.error.message}</Note></div> : <Loading label={t('Lining up past cycles…')} />}</div>;
  }

  const shown = r.cycles.filter((c) => r.selected.includes(c.id));
  const toggle = (id: number) => {
    const next = prefs.cycles.includes(id) ? prefs.cycles.filter((c) => c !== id) : [...prefs.cycles, id];
    // At least one cycle stays selected: with none there is nothing to replay.
    if (next.length) onPrefs({ ...prefs, cycles: next.sort() });
  };

  const rows = r.t.map((time, i) => {
    const row: Record<string, number | [number, number] | null> = { t: time, actual: r.actual[i], average: r.average?.values[i] ?? null };
    for (const c of shown) row[`c${c.id}`] = c.values[i];
    const lo = r.average?.low[i];
    const hi = r.average?.high[i];
    row.band = i >= r.today && lo != null && hi != null ? [lo, hi] : null;
    return row;
  });
  const cycleName = (label: string) => t('{years} cycle', { years: label });
  const axis = { fill: UI.mute, fontSize: 10 };

  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2">
        <div className="flex items-center gap-1.5" role="group" aria-label={t('Cycles to follow')}>
          <span className="text-[11px] text-mute">{t('If this cycle behaves like')}</span>
          {r.cycles.map((c) => {
            // From the preference, not the last answer: the button reacts before the new paths arrive.
            const on = prefs.cycles.includes(c.id);
            return (
              <button
                key={c.id}
                aria-pressed={on}
                disabled={!c.end}
                onClick={() => toggle(c.id)}
                title={c.end ? undefined : t('Not enough history for this cycle')}
                className={clsx('num flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40', on ? 'border-line bg-raised text-ink' : 'border-line text-mute hover:text-ink2')}
              >
                <span className="h-2 w-2 rounded-sm" style={{ background: on ? CYCLE_COLOR[c.id] : UI.line }} />
                {c.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-mute">{t('Ahead')}</span>
          <Segmented label={t('Ahead')} size="sm" value={prefs.span} onChange={(span) => onPrefs({ ...prefs, span })} options={CYCLE_SPANS.map((s) => ({ value: s, label: t(SPAN_LABEL[s]) }))} />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-mute">{t('Back')}</span>
          <Segmented label={t('Back')} size="sm" value={prefs.back} onChange={(back) => onPrefs({ ...prefs, back })} options={CYCLE_BACKS.map((b) => ({ value: b, label: t(BACK_LABEL[b]) }))} />
        </div>
        <div className="w-28">
          <Switch checked={prefs.log} onChange={(log) => onPrefs({ ...prefs, log })} label={t('Log scale')} />
        </div>
      </div>

      <div className={clsx('h-[440px] transition-opacity', query.isFetching && query.isPlaceholderData && 'opacity-60')}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
            <CartesianGrid stroke={UI.grid} vertical={false} />
            <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tick={axis} tickLine={false} axisLine={{ stroke: UI.line }} tickFormatter={(v) => fmtDate(Number(v)).replace(/^\d+\s/, '')} minTickGap={56} />
            <YAxis orientation="right" scale={prefs.log ? 'log' : 'linear'} domain={['auto', 'auto']} tick={axis} tickLine={false} axisLine={false} tickFormatter={(v) => fmtCompactUsd(Number(v))} width={56} allowDataOverflow />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as (typeof rows)[number];
                const time = d.t as number;
                const day = Math.round((time - r.halving) / 86_400);
                const val = (v: unknown) => (typeof v === 'number' ? `${fmtUsd(v)}${time > r.asOf ? ` (${fmtPct((v / r.price - 1) * 100, 0)})` : ''}` : '–');
                const items = [
                  ...(d.actual != null ? [{ label: t('This cycle'), value: fmtUsd(d.actual as number), color: UI.ink }] : []),
                  ...(d.average != null ? [{ label: t('Average of selected'), value: val(d.average), color: AVERAGE_COLOR }] : []),
                  ...shown.filter((c) => d[`c${c.id}`] != null).map((c) => ({ label: cycleName(c.label), value: val(d[`c${c.id}`]), color: CYCLE_COLOR[c.id] })),
                ];
                return <ChartTip title={`${fmtDate(time)} · ${t('day {n} of the cycle', { n: day })}`} rows={items} />;
              }}
            />
            {r.average && <Area dataKey="band" stroke="none" fill={AVERAGE_COLOR} fillOpacity={0.12} isAnimationActive={false} connectNulls={false} />}
            {shown.map((c) => (
              <Line key={c.id} dataKey={`c${c.id}`} stroke={CYCLE_COLOR[c.id]} strokeWidth={r.average ? 1.25 : 2} strokeOpacity={r.average ? 0.75 : 1} dot={false} isAnimationActive={false} />
            ))}
            {r.average && <Line dataKey="average" stroke={AVERAGE_COLOR} strokeWidth={2.25} dot={false} isAnimationActive={false} />}
            <Line dataKey="actual" stroke={UI.ink} strokeWidth={2} dot={false} isAnimationActive={false} />
            <ReferenceLine x={r.asOf} stroke={UI.mute} strokeDasharray="3 3" label={{ value: t('Today'), fill: UI.ink2, fontSize: 10, position: 'insideTopLeft' }} />
            {r.nextHalving > r.asOf && r.nextHalving <= r.t[r.t.length - 1] && (
              <ReferenceLine x={r.nextHalving} stroke={UI.warn} strokeDasharray="3 3" label={{ value: t('Next halving (est.)'), fill: UI.warn, fontSize: 10, position: 'insideTopRight' }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <Legend
        items={[
          { label: t('This cycle (actual)'), color: UI.ink },
          ...(r.average ? [{ label: t('Average of selected'), color: AVERAGE_COLOR }] : []),
          ...shown.map((c) => ({ label: cycleName(c.label), color: CYCLE_COLOR[c.id] })),
        ]}
      />

      <div className="thin-scroll overflow-x-auto">
        <table className="w-full min-w-[520px]">
          <thead>
            <tr>
              <Th>{t('If it behaves like')}</Th>
              <Th right title={t('Where the path stands at the end of the window')}>{t('At the end of the window')}</Th>
              <Th right>{t('Highest on the way')}</Th>
              <Th right>{t('Lowest on the way')}</Th>
              <Th right title={t('How alike the two cycles have moved over the look-back: correlation of their 30-day returns, from −1 (opposite) to 1 (identical). Near 0 means no resemblance.')}>{t('Resemblance so far')}</Th>
            </tr>
          </thead>
          <tbody>
            {r.average && (
              <tr className="border-t border-line align-top">
                <Td className="font-medium text-ink">
                  <span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: AVERAGE_COLOR }} />
                  {t('Average of selected')}
                </Td>
                <PointCell p={r.average.end} />
                <PointCell p={r.average.high_} />
                <PointCell p={r.average.low_} />
                <Td right className="text-mute">–</Td>
              </tr>
            )}
            {r.cycles.map((c) => {
              const on = r.selected.includes(c.id);
              return (
                <tr key={c.id} className={clsx('border-t border-line align-top', !on && 'opacity-50')}>
                  <Td className="font-medium text-ink">
                    <span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ background: CYCLE_COLOR[c.id] }} />
                    {cycleName(c.label)}
                  </Td>
                  <PointCell p={c.end} />
                  <PointCell p={c.high} />
                  <PointCell p={c.low} />
                  <Td right className="num text-ink2">{c.match == null ? '–' : c.match.toFixed(2)}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-mute">
        {t('Day {d} of the cycle that began with the halving of {date}.', { d: r.cycleDay, date: fmtDate(r.halving) })} {r.notes.join(' ')}
      </p>
    </div>
  );
}
