import { METRIC_GROUP_LABEL, type AnnotationDef, type MetricDef, type MetricGroup, type MetricSnapshot } from '@smart-btc/shared';
import clsx from 'clsx';
import { BookOpen, BrainCircuit, CornerDownRight, Eye, EyeOff, PanelLeftClose } from 'lucide-react';
import { Fragment } from 'react';
import { fmtDate, fmtMetric } from '../lib/format';
import { useT } from '../lib/i18n';
import { SERIES } from '../lib/palette';
import type { Layers } from '../lib/state';
import { HoverCard, Switch } from './ui';

const GROUP_ORDER: MetricGroup[] = ['momentum', 'drawdown', 'volatility', 'trend', 'onchain', 'derivatives', 'sentiment', 'liquidity', 'macro', 'cycle'];

interface Props {
  metrics: MetricDef[];
  annotations: AnnotationDef[];
  enabledAnnotations: string[];
  snapshot: MetricSnapshot[];
  visible: string[];
  model: string[];
  layers: Layers;
  onToggleVisible: (id: string) => void;
  onToggleModel: (id: string) => void;
  onToggleAnnotation: (id: string) => void;
  /** Open the guide, optionally at one metric. */
  onOpenGuide: (metricId?: string) => void;
  onLayers: (l: Layers) => void;
  /** Hide this whole panel. */
  onCollapse: () => void;
  /** Show explanation cards on hover. */
  explain: boolean;
  onResetSelections: () => void;
}

export function MetricSidebar({ metrics, annotations, enabledAnnotations, snapshot, visible, model, layers, onToggleVisible, onToggleModel, onToggleAnnotation, onOpenGuide, onLayers, onCollapse, explain, onResetSelections }: Props) {
  const { t } = useT();
  const snap = new Map(snapshot.map((s) => [s.id, s]));
  const layer = (key: keyof Layers, labelKey: string, whatKey: string) => {
    const label = t(labelKey);
    const what = t(whatKey);
    return (
    <HoverCard enabled={explain} content={<><div className="font-medium text-ink">{label}</div><div className="mt-0.5">{what}</div></>}>
      <Switch checked={layers[key]} onChange={(v) => onLayers({ ...layers, [key]: v })} label={label} />
    </HoverCard>
    );
  };

  return (
    <aside className="flex flex-col gap-3">
      <section className="rounded-lg border border-line bg-panel">
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink2">{t('Chart layers')}</h3>
          <button onClick={onCollapse} title={t('Hide this panel (bring it back with the button above the chart)')} className="flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[10.5px] text-ink2 hover:bg-raised">
            <PanelLeftClose size={12} /> {t('Hide panel')}
          </button>
        </header>
        <div className="px-3 py-1.5">
          {layer('cone', 'Forecast cone', 'Draws where the modelled paths go from here: the median (solid), the band holding half of them (dashed) and the band holding eight in ten (dotted).')}
          {layer('targets', 'Scenario targets', 'Horizontal lines at the median outcome of the rally and decline scenarios, labelled with their probability.')}
          {layer('volume', 'Volume bars', 'Traded volume of each bar, drawn along the bottom of the price chart. Green when the bar closed higher than it opened, red when lower. Big moves on high volume carry more conviction than the same move on thin volume.')}
          {layer('swings', 'Liquidity pools (swing highs / lows)', 'Marks swing highs and lows that price has not revisited. Stop orders cluster just beyond them, so price is often drawn there.')}
          {layer('liquidations', 'Estimated liquidation clusters', 'Price zones where many leveraged positions would be force-closed. An estimate from open-interest growth and an assumed leverage mix, not exchange data.')}
          {layer('walls', 'Order-book walls', 'Unusually large resting buy or sell orders in the combined spot order books. They can slow price, and they can be withdrawn.')}
          {layer('logScale', 'Log price scale', 'Equal distances on the axis become equal percentage moves. Useful when the chart spans several years.')}
        </div>
      </section>

      <section className="rounded-lg border border-line bg-panel">
        <header className="flex items-center justify-between border-b border-line px-3 py-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink2">{t('Metrics')}</h3>
          <div className="flex items-center gap-2 text-[10px] text-mute">
            <span className="flex items-center gap-1"><Eye size={11} /> {t('chart')}</span>
            <span className="flex items-center gap-1"><BrainCircuit size={11} /> {t('model input')}</span>
          </div>
        </header>
        <div className="divide-y divide-line">
          {GROUP_ORDER.map((g) => {
            const items = metrics.filter((m) => m.group === g);
            if (!items.length) return null;
            return (
              <div key={g} className="px-2 py-2">
                <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-mute">{t(METRIC_GROUP_LABEL[g])}</div>
                {items.map((m) => {
                  const s = snap.get(m.id);
                  const isVisible = visible.includes(m.id);
                  const inModel = model.includes(m.id);
                  const card = (
                    <>
                      <div className="font-medium text-ink">{m.name}</div>
                      <div className="mt-0.5">{m.description}</div>
                      {m.guide && (
                        <ul className="mt-1.5 list-disc space-y-1 pl-3.5">
                          {m.guide.read.slice(0, 2).map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      )}
                      {m.guide?.caveat && (
                        <div className="mt-1.5">
                          <span className="font-medium text-warn">{t('Watch out:')} </span>
                          {m.guide.caveat}
                        </div>
                      )}
                      <div className="mt-1.5 text-mute">
                        {m.source}
                        {s?.since ? ` · ${t('since {date}', { date: fmtDate(s.since) })}` : ''}
                        {m.delayedDays ? ` · ${t('delayed {n} days', { n: m.delayedDays })}` : ''} · {t('click the name for the full guide')}
                      </div>
                    </>
                  );
                  return (
                    <Fragment key={m.id}>
                    <HoverCard enabled={explain} content={card} className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-raised/60">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SERIES[m.colorSlot], opacity: isVisible ? 1 : 0.35 }} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <button onClick={() => onOpenGuide(m.id)} className="truncate text-left text-xs text-ink underline-offset-2 hover:underline" aria-label={t('What {name} means', { name: m.name })}>
                            {m.short}
                          </button>
                          <span className="num shrink-0 text-xs font-medium text-ink">{fmtMetric(s?.value, m.unit)}</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-2 text-[10.5px]">
                          <span className={clsx('truncate', s?.tone === 'bullish' ? 'text-up' : s?.tone === 'bearish' ? 'text-down' : 'text-mute')}>
                            {s?.reading || ' '}
                          </span>
                          {s?.percentile != null && m.display === 'pane' && (
                            <span className="num shrink-0 text-mute" title={t("Percentile of the current value within the metric's own history")}>
                              p{Math.round(s.percentile)}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => onToggleVisible(m.id)}
                        aria-pressed={isVisible}
                        aria-label={t(isVisible ? 'Hide {name} on the chart' : 'Show {name} on the chart', { name: m.name })}
                        className={clsx('rounded p-1', isVisible ? 'bg-raised text-ink' : 'text-mute hover:text-ink2')}
                      >
                        {isVisible ? <Eye size={14} /> : <EyeOff size={14} />}
                      </button>
                      <button
                        onClick={() => m.forecastable && onToggleModel(m.id)}
                        disabled={!m.forecastable}
                        aria-pressed={inModel}
                        aria-label={t(inModel ? 'Remove {name} as a forecast input' : 'Use {name} as a forecast input', { name: m.name })}
                        className={clsx(
                          'rounded p-1',
                          !m.forecastable && 'cursor-not-allowed opacity-20',
                          inModel ? 'bg-accent/20 text-[#7fb2f0]' : 'text-mute hover:text-ink2',
                        )}
                      >
                        <BrainCircuit size={14} />
                      </button>
                    </HoverCard>
                    {annotations
                      .filter((a) => a.metricId === m.id)
                      .map((a) => {
                        const on = enabledAnnotations.includes(a.id);
                        return (
                          <HoverCard key={a.id} enabled={explain} content={<><div className="font-medium text-ink">{a.name}</div><div className="mt-0.5">{a.description}</div></>} className="ml-[18px] flex items-center gap-2 rounded px-1 py-0.5 hover:bg-raised/60">
                            <CornerDownRight size={12} className="shrink-0 text-mute" />
                            <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink2">{a.name}</span>
                            <button
                              onClick={() => onToggleAnnotation(a.id)}
                              aria-pressed={on}
                              aria-label={t(on ? 'Hide {name} on the chart' : 'Show {name} on the chart', { name: a.name })}
                              className={clsx('rounded p-1', on ? 'bg-raised text-ink' : 'text-mute hover:text-ink2')}
                            >
                              {on ? <Eye size={14} /> : <EyeOff size={14} />}
                            </button>
                            <span className="w-[22px] shrink-0" />
                          </HoverCard>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </div>
            );
          })}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2">
          <button onClick={() => onOpenGuide()} className="flex items-center gap-1.5 text-[11px] text-[#7fb2f0] underline-offset-2 hover:underline">
            <BookOpen size={12} /> {t('What do these mean?')}
          </button>
          <button onClick={onResetSelections} className="text-[11px] text-mute underline-offset-2 hover:text-ink2 hover:underline">
            {t('Reset selections')}
          </button>
        </footer>
      </section>
    </aside>
  );
}
