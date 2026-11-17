import {
  METRIC_GROUP_LABEL,
  type AnnotationDef,
  type AnnotationPayload,
  type MetricDef,
  type MetricGroup,
  type MetricSnapshot,
  type RelationWindow,
  type Relations,
  type Timeframe,
} from '@smart-btc/shared';
import clsx from 'clsx';
import { ChevronDown, Eye, EyeOff } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { fmtDate, fmtMetric, fmtPct, fmtProb } from '../lib/format';
import { useT } from '../lib/i18n';
import { SERIES, diverging } from '../lib/palette';
import { Card, DivergingBar, Loading, Note, Segmented, Td, Th } from './ui';

export type GuideSection = 'metrics' | 'relations' | 'method';

const GROUP_ORDER: MetricGroup[] = ['momentum', 'drawdown', 'gain', 'volatility', 'trend', 'onchain', 'derivatives', 'sentiment', 'liquidity', 'macro', 'cycle'];
const WINDOW_LABEL: Record<RelationWindow, string> = { all: 'All history', '4y': 'Last 4 years', '1y': 'Last year' };

const signed = (r: number) => `${r >= 0 ? '+' : '−'}${Math.abs(r).toFixed(2)}`;

interface Props {
  section: GuideSection;
  onSection: (s: GuideSection) => void;
  /** Metric whose entry is open. */
  focusId: string | null;
  onFocus: (id: string | null) => void;
  metrics: MetricDef[];
  snapshot: MetricSnapshot[];
  annotations: AnnotationDef[];
  enabledAnnotations: string[];
  annotationData: AnnotationPayload[];
  onToggleAnnotation: (id: string) => void;
  relations: { data: Relations | undefined; error: Error | null; isFetching: boolean };
  window: RelationWindow;
  onWindow: (w: RelationWindow) => void;
  tf: Timeframe;
}

export function GuidePanel(props: Props) {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-center">
        <Segmented
          label={t('Guide section')}
          value={props.section}
          onChange={props.onSection}
          options={[
            { value: 'metrics', label: t('What each metric means') },
            { value: 'relations', label: t('Correlations') },
            { value: 'method', label: t('How it works') },
          ]}
        />
      </div>
      {props.section === 'metrics' && <MetricGuide {...props} />}
      {props.section === 'relations' && <RelationsView {...props} />}
      {props.section === 'method' && <Method />}
    </div>
  );
}

// ───────────────────────── metric by metric ─────────────────────────

function MetricGuide({ focusId, onFocus, metrics, snapshot, annotations, enabledAnnotations, annotationData, onToggleAnnotation, relations, tf }: Props) {
  const { t, tx, dur } = useT();
  const snap = useMemo(() => new Map(snapshot.map((s) => [s.id, s])), [snapshot]);
  const byId = useMemo(() => new Map(metrics.map((m) => [m.id, m])), [metrics]);
  const openRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusId) openRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusId]);

  const rel = relations.data;
  const related = (id: string) => {
    if (!rel) return null;
    const i = rel.ids.indexOf(id);
    if (i < 0) return null;
    const others = rel.ids
      .map((other, j) => ({ other, r: rel.matrix[i][j] }))
      .filter((x): x is { other: string; r: number } => x.other !== id && x.r != null);
    return {
      together: others.filter((x) => x.r >= 0.5).sort((a, b) => b.r - a.r).slice(0, 3),
      opposite: others.filter((x) => x.r <= -0.4).sort((a, b) => a.r - b.r).slice(0, 2),
      forward: rel.forward.find((f) => f.id === id),
    };
  };
  const links = (list: { other: string; r: number }[]) =>
    list.map((x, k) => (
      <Fragment key={x.other}>
        {k > 0 && ', '}
        <button className="text-ink underline-offset-2 hover:underline" onClick={() => onFocus(x.other)}>
          {byId.get(x.other)?.short ?? x.other}
        </button>{' '}
        <span className="num text-mute">({signed(x.r)})</span>
      </Fragment>
    ));

  return (
    <>
      {GROUP_ORDER.map((g) => {
        const items = metrics.filter((m) => m.group === g);
        if (!items.length) return null;
        return (
          <Card key={g} title={t(METRIC_GROUP_LABEL[g])}>
            <div className="-my-1 divide-y divide-line">
              {items.map((m) => {
                const open = focusId === m.id;
                const s = snap.get(m.id);
                const r = open ? related(m.id) : null;
                return (
                  <div key={m.id} ref={open ? openRef : undefined} className="scroll-mt-20">
                    <button onClick={() => onFocus(open ? null : m.id)} aria-expanded={open} className="flex w-full items-center gap-2 py-2 text-left">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SERIES[m.colorSlot] }} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{m.name}</span>
                      <span className="num shrink-0 text-xs text-ink2">{fmtMetric(s?.value, m.unit)}</span>
                      <ChevronDown size={14} className={clsx('shrink-0 text-mute transition-transform', open && 'rotate-180')} />
                    </button>
                    {open && (
                      <div className="flex flex-col gap-2.5 pb-3 text-xs leading-relaxed">
                        <p className="text-ink">{m.description}</p>

                        {m.guide && (
                          <div>
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-mute">{t('How to read it')}</div>
                            <ul className="list-disc space-y-1 pl-4 text-ink2">
                              {m.guide.read.map((line) => (
                                <li key={line}>{line}</li>
                              ))}
                            </ul>
                            {m.guide.caveat && (
                              <p className="mt-1.5 text-ink2">
                                <span className="font-medium text-warn">{t('Watch out:')} </span>
                                {m.guide.caveat}
                              </p>
                            )}
                          </div>
                        )}

                        <div className="num rounded-md bg-raised px-2.5 py-2 text-ink2">
                          <span className="text-mute">{t('Now:')} </span>
                          <span className="font-medium text-ink">{fmtMetric(s?.value, m.unit)}</span>
                          {s?.reading ? ` · ${s.reading}` : ''}
                          {s?.percentile != null && m.display === 'pane' ? ` · ${t('higher than {p}% of its history', { p: Math.round(s.percentile) })}` : ''}
                        </div>

                        {r && (r.together.length > 0 || r.opposite.length > 0 || r.forward) && (
                          <div>
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-mute">{t('How it relates')}</div>
                            <ul className="list-disc space-y-1 pl-4 text-ink2">
                              {r.together.length > 0 && (
                                <li>{tx('Moves with {list}: they largely tell the same story, so do not count them as separate confirmations.', { list: links(r.together) })}</li>
                              )}
                              {r.opposite.length > 0 && <li>{tx('Moves against {list}.', { list: links(r.opposite) })}</li>}
                              {r.together.length === 0 && r.opposite.length === 0 && <li>{t('Largely independent of the other metrics: it adds its own information.')}</li>}
                              {r.forward?.low && r.forward.high && rel && (
                                <li>
                                  {tx(
                                    'Over {period}, its lowest fifth of readings was followed by a median move of {low} (up {lowWin} of the time) and its highest fifth by {high} (up {highWin}) over the next {dur}. Any time: {base}, up {baseWin}.',
                                    {
                                      period: t(WINDOW_LABEL[rel.window]).toLowerCase(),
                                      low: <span className="num text-ink">{fmtPct(r.forward.low.medianPct)}</span>,
                                      lowWin: fmtProb(r.forward.low.winRate),
                                      high: <span className="num text-ink">{fmtPct(r.forward.high.medianPct)}</span>,
                                      highWin: fmtProb(r.forward.high.winRate),
                                      dur: dur(rel.timeframe, rel.horizon),
                                      base: <span className="num">{fmtPct(rel.base.medianPct)}</span>,
                                      baseWin: fmtProb(rel.base.winRate),
                                    },
                                  )}
                                </li>
                              )}
                            </ul>
                          </div>
                        )}

                        {annotations
                          .filter((a) => a.metricId === m.id)
                          .map((a) => (
                            <AnnotationBlock
                              key={a.id}
                              def={a}
                              on={enabledAnnotations.includes(a.id)}
                              payload={annotationData.find((p) => p.id === a.id)}
                              onToggle={() => onToggleAnnotation(a.id)}
                              tf={tf}
                            />
                          ))}

                        <p className="text-[11px] text-mute">
                          {t('Source: {source}', { source: m.source })}
                          {s?.since ? ` · ${t('history since {date}', { date: fmtDate(s.since) })}` : ''}
                          {m.delayedDays ? ` · ${t('delayed {n} days', { n: m.delayedDays })}` : ''}
                          {m.forecastable ? ` · ${t('can be used as a model input')}` : ` · ${t('chart only')}`}
                        </p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
      {!rel && relations.isFetching && <Loading label={t('Computing relationships between metrics…')} />}
    </>
  );
}

function AnnotationBlock({ def, on, payload, onToggle, tf }: { def: AnnotationDef; on: boolean; payload?: AnnotationPayload; onToggle: () => void; tf: Timeframe }) {
  const { t, tx, dur } = useT();
  return (
    <div className="rounded-md border border-line p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-ink">{def.name}</div>
        <button onClick={onToggle} aria-pressed={on} className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[11px] text-ink2 hover:bg-raised">
          {on ? <Eye size={12} /> : <EyeOff size={12} />} {on ? t('Shown on chart') : t('Show on chart')}
        </button>
      </div>
      <p className="mt-1 text-ink2">{def.description}</p>
      {payload ? (
        <>
          <table className="mt-2 w-full">
            <thead>
              <tr>
                <Th>{t('Signal')}</Th>
                <Th right>{t('After')}</Th>
                <Th right title={t('Median move from the bar the signal was confirmed')}>{t('Median move')}</Th>
                <Th right>{t('Ended higher')}</Th>
              </tr>
            </thead>
            <tbody>
              {payload.stats.flatMap((st) =>
                st.horizons.map((h, k) => (
                  <tr key={`${st.kind}-${h.bars}`} className="border-t border-line">
                    <Td className="text-ink2">{k === 0 ? `${st.label} (${st.count})` : ''}</Td>
                    <Td right>{dur(tf, h.bars)}</Td>
                    <Td right>
                      <span className="text-ink">{fmtPct(h.medianPct)}</span> <span className="text-mute">{t('vs {x}', { x: fmtPct(h.baseMedianPct) })}</span>
                    </Td>
                    <Td right>
                      <span className="text-ink">{fmtProb(h.winRate)}</span> <span className="text-mute">{t('vs {x}', { x: fmtProb(h.baseWinRate) })}</span>
                    </Td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-ink2">
            {payload.stats.map((st) =>
              st.move ? (
                <li key={st.kind}>
                  {tx(
                    st.kind === 'bullish'
                      ? 'After a bullish signal the move up lasted {avg} on average (median {median}) from confirmation to its best point, for a typical {pct} ({n} past signals, measured within {window}).'
                      : 'After a bearish signal the move down lasted {avg} on average (median {median}) from confirmation to its best point, for a typical {pct} ({n} past signals, measured within {window}).',
                    {
                      avg: <span className="num text-ink">{dur(tf, st.move.avgBars)}</span>,
                      median: dur(tf, st.move.medianBars),
                      pct: <span className="num text-ink">{st.move.medianPct.toFixed(1)}%</span>,
                      n: st.move.n,
                      window: dur(tf, st.move.lookahead),
                    },
                  )}
                </li>
              ) : null,
            )}
          </ul>
          <p className="mt-1.5 text-[11px] text-mute">
            {t('"vs" is any bar in history.')} {payload.notes.join(' ')} {t('With this few signals, treat the figures as anecdotes rather than odds.')}
          </p>
        </>
      ) : (
        <p className="mt-1.5 text-[11px] text-mute">{t('Turn it on to load how past signals played out.')}</p>
      )}
    </div>
  );
}

// ───────────────────────── correlations ─────────────────────────

function RelationsView({ metrics, relations, window, onWindow, onFocus, onSection }: Props) {
  const { t, tx, dur } = useT();
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const byId = useMemo(() => new Map(metrics.map((m) => [m.id, m])), [metrics]);
  const rel = relations.data;
  const name = (id: string) => byId.get(id)?.short ?? id;
  const strength = (r: number) => (Math.abs(r) >= 0.7 ? t('strongly') : Math.abs(r) >= 0.4 ? t('moderately') : t('weakly'));

  const pairs = useMemo(() => {
    if (!rel) return [];
    const out: { a: string; b: string; r: number }[] = [];
    for (let i = 0; i < rel.ids.length; i++) {
      for (let j = i + 1; j < rel.ids.length; j++) {
        const r = rel.matrix[i][j];
        if (r != null) out.push({ a: rel.ids[i], b: rel.ids[j], r });
      }
    }
    return out;
  }, [rel]);

  if (!rel) return relations.error ? <Note tone="error">{relations.error.message}</Note> : <Loading label={t('Computing relationships between metrics…')} />;

  const top = [...pairs].sort((x, y) => y.r - x.r).slice(0, 6);
  const bottom = [...pairs].sort((x, y) => x.r - y.r).filter((p) => p.r < -0.3).slice(0, 4);
  const hovered = hover ? { a: rel.ids[hover.i], b: rel.ids[hover.j], r: rel.matrix[hover.i][hover.j] } : null;
  const forward = [...rel.forward].sort((x, y) => Math.abs(y.ic ?? 0) - Math.abs(x.ic ?? 0));
  const horizon = dur(rel.timeframe, rel.horizon);
  const open = (id: string) => {
    onSection('metrics');
    onFocus(id);
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label={t('Period')}
          size="sm"
          value={window}
          onChange={onWindow}
          options={(['all', '4y', '1y'] as const).map((w) => ({ value: w, label: t(WINDOW_LABEL[w]) }))}
        />
        <span className="num text-[11px] text-mute">
          {fmtDate(rel.from)} → {fmtDate(rel.to)}
        </span>
      </div>

      <Card title={t('Do metrics move together?')}>
        <div className="num mb-2 min-h-8 text-xs text-ink2">
          {hovered && hovered.r != null ? (
            hovered.a === hovered.b ? (
              <span className="text-ink">{byId.get(hovered.a)?.name}</span>
            ) : (
              <>
                <span className="text-ink">{name(hovered.a)}</span> × <span className="text-ink">{name(hovered.b)}</span>:{' '}
                <span className="font-semibold text-ink">{signed(hovered.r)}</span> ·{' '}
                {t(hovered.r >= 0 ? 'move together {how}' : 'move opposite {how}', { how: strength(hovered.r) })}
              </>
            )
          ) : hovered ? (
            t('Not enough overlapping history for this pair.')
          ) : (
            <span className="text-mute">{t('Hover or tap a cell. +1 = always high and low together, −1 = one high when the other is low, 0 = unrelated.')}</span>
          )}
        </div>

        <div
          className="grid gap-0.5"
          style={{ gridTemplateColumns: `minmax(64px, 96px) repeat(${rel.ids.length}, minmax(0, 1fr))` }}
          onMouseLeave={() => setHover(null)}
        >
          <div />
          {rel.ids.map((id, j) => (
            <div key={id} className="flex h-20 items-end justify-center overflow-hidden pb-1">
              <span
                className={clsx('whitespace-nowrap text-[10px]', hover?.j === j ? 'text-ink' : 'text-mute')}
                style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
              >
                {name(id)}
              </span>
            </div>
          ))}
          {rel.ids.map((rowId, i) => (
            <div key={rowId} className="contents">
              <button onClick={() => open(rowId)} className={clsx('truncate pr-1 text-right text-[10px] hover:underline', hover?.i === i ? 'text-ink' : 'text-mute')} title={byId.get(rowId)?.name}>
                {name(rowId)}
              </button>
              {rel.ids.map((colId, j) => {
                const r = rel.matrix[i][j];
                return (
                  <div
                    key={colId}
                    onMouseEnter={() => setHover({ i, j })}
                    onClick={() => setHover({ i, j })}
                    className={clsx('aspect-square rounded-[3px]', hover?.i === i && hover?.j === j && 'outline outline-1 outline-ink')}
                    style={{ background: i === j ? 'var(--color-raised)' : r == null ? 'transparent' : diverging(r, 1), border: r == null ? '1px dashed var(--color-line)' : undefined }}
                  />
                );
              })}
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2 text-[10px] text-mute">
          <span>{t('−1 opposite')}</span>
          <span className="h-2 flex-1 rounded-full" style={{ background: `linear-gradient(to right, ${diverging(-1, 1)}, ${diverging(0, 1)}, ${diverging(1, 1)})` }} />
          <span>{t('together +1')}</span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          {t('Rank correlation of the readings on this timeframe. Two metrics that move together are mostly one signal seen twice: agreement between them is not extra confirmation, and using both as model inputs adds little.')}
        </p>
      </Card>

      <Card title={t('Strongest links')}>
        <ul className="flex flex-col gap-1.5 text-xs text-ink2">
          {[...top, ...bottom].map((p) => (
            <li key={`${p.a}-${p.b}`} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                <button className="text-ink underline-offset-2 hover:underline" onClick={() => open(p.a)}>
                  {name(p.a)}
                </button>
                {p.r >= 0 ? ` ${t('and')} ` : ' vs '}
                <button className="text-ink underline-offset-2 hover:underline" onClick={() => open(p.b)}>
                  {name(p.b)}
                </button>
                <span className="text-mute"> · {p.r >= 0 ? t('same story') : t('opposite')}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <DivergingBar value={p.r} scale={1} positive={SERIES[0]} negative={SERIES[7]} />
                <span className="num w-10 text-right text-ink">{signed(p.r)}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t('Readings vs what price did over the next {dur}', { dur: horizon })}>
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full min-w-[400px]">
            <thead>
              <tr>
                <Th>{t('Metric')}</Th>
                <Th right title={t('Rank correlation between the reading and the forward return. Positive: higher readings were followed by better returns.')}>{t('Link')}</Th>
                <Th right title={t('Median forward move and share of up outcomes after the lowest fifth of readings')}>{t('After low readings')}</Th>
                <Th right title={t('Median forward move and share of up outcomes after the highest fifth of readings')}>{t('After high readings')}</Th>
              </tr>
            </thead>
            <tbody>
              {forward.map((f) => (
                <tr key={f.id} className="border-t border-line">
                  <Td>
                    <button className="text-ink2 underline-offset-2 hover:underline" onClick={() => open(f.id)}>
                      {name(f.id)}
                    </button>
                  </Td>
                  <Td right>
                    {f.ic != null ? (
                      <div className="flex items-center justify-end gap-2">
                        <DivergingBar value={f.ic} scale={0.3} positive={SERIES[0]} negative={SERIES[7]} />
                        <span className="w-10 text-right text-ink">{signed(f.ic)}</span>
                      </div>
                    ) : (
                      <span className="text-mute">–</span>
                    )}
                  </Td>
                  <Td right>
                    {f.low ? (
                      <>
                        <span className="text-ink">{fmtPct(f.low.medianPct)}</span> <span className="text-mute">· {t('{p} up', { p: fmtProb(f.low.winRate) })}</span>
                      </>
                    ) : (
                      '–'
                    )}
                  </Td>
                  <Td right>
                    {f.high ? (
                      <>
                        <span className="text-ink">{fmtPct(f.high.medianPct)}</span> <span className="text-mute">· {t('{p} up', { p: fmtProb(f.high.winRate) })}</span>
                      </>
                    ) : (
                      '–'
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          {tx('Any bar in this period: median {median}, up {win} of the time. "Low" and "high" are the bottom and top fifth of each metric\'s readings. The horizon follows the forecast horizon selected above.', {
            median: <span className="num text-ink2">{fmtPct(rel.base.medianPct)}</span>,
            win: <span className="num text-ink2">{fmtProb(rel.base.winRate)}</span>,
          })}
        </p>
      </Card>

      <Note>
        {t('These are descriptions of the past, measured on the same data they describe, with overlapping {dur} windows. They show which way a reading has leaned, not a tested edge: the Ranking section of the Evidence tab is the out-of-sample check. Relationships also change between periods, so compare "All history" with "Last 4 years".', { dur: horizon })}
      </Note>
    </>
  );
}

// ───────────────────────── method and vocabulary ─────────────────────────

const TERMS: [string, string][] = [
  ['Base rate', "How often something happened across all history, ignoring today's readings. Every probability in the app is shown next to it."],
  ['Analog', "A past day whose metric readings resembled today's. What price did after the analogs is the raw material of the forecast."],
  ['Skill', "Brier skill score: how much closer the model's probabilities were to reality than the base rate, out of sample. 0% = no better; a few percent is already meaningful."],
  ['Touch', 'Price reaching a level at any moment inside the window (daily high or low), as opposed to where it ends.'],
  ['R', 'The amount risked on a trade. +0.3R expected value means an average gain of 0.3 times the risk per trade.'],
  ['p30, p90 …', "Percentile: today's reading is higher than that share of the metric's own history."],
  ['σ (sigma)', "Standard deviations from the metric's historical average. Beyond ±2σ is unusual."],
  ['Divergence', 'Price and an indicator disagreeing at successive highs or lows, a hint that the move is losing force.'],
];

function Method() {
  const { t } = useT();
  return (
    <>
      <Card title={t('How the forecast works')}>
        <ol className="list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-ink2">
          <li>{t('Today is described by the readings of the metrics you marked as model inputs.')}</li>
          <li>{t('The model finds the past days whose readings were most similar (the analogs), spaced apart so one episode cannot dominate.')}</li>
          <li>{t("What price did after each analog, rescaled to today's volatility, becomes one possible path forward. The analogs are blended with the all-history base rate to steady the estimate.")}</li>
          <li>{t('Scenario probabilities, targets, timings, touch odds and stop/target outcomes are all counted from those paths.')}</li>
          <li>{t('The backtest repeats steps 1–4 for every past date using only data known at the time, and checks the probabilities against what really happened.')}</li>
        </ol>
      </Card>
      <Card title={t('Terms used in this app')}>
        <dl className="flex flex-col gap-2 text-xs leading-relaxed">
          {TERMS.map(([term, text]) => (
            <div key={term}>
              <dt className="font-medium text-ink">{t(term)}</dt>
              <dd className="text-ink2">{t(text)}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title={t('Reading several signals together')}>
        <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-ink2">
          <li>{t('Check the Correlations section first: metrics that move together count as one vote, not several.')}</li>
          <li>{t('Look for agreement between metrics from different families (momentum, on-chain, derivatives positioning), which are less related.')}</li>
          <li>{t('Slow gauges (MVRV, drawdown from the high, halving cycle) describe the regime; fast ones (RSI, funding, divergences) describe timing inside it.')}</li>
          <li>{t('Use the Ranking section of the Evidence tab to see whether a combination actually held up out of sample before leaning on it.')}</li>
        </ul>
      </Card>
    </>
  );
}
