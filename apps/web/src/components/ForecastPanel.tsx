import { TF_INFO, type BacktestResult, type FeatureUse, type ForecastResult, type ForecastSettings, type MetricDef, type Scenario, type Timeframe } from '@smart-btc/shared';
import clsx from 'clsx';
import { ChevronDown, Minus, SlidersHorizontal, TrendingDown, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { fmtBarTime, fmtBars, fmtMetric, fmtPct, fmtPctAuto, fmtProb, fmtUsd } from '../lib/format';
import { msg, useT } from '../lib/i18n';
import { UI } from '../lib/palette';
import { Badge, Card, Note, NumberField, ProbBar, Segmented, Switch, Td, Th } from './ui';

type Settings = Omit<ForecastSettings, 'features'>;

export function ForecastSettingsBar({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const { t, dur } = useT();
  const [open, setOpen] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink2">{t('Horizon')}</span>
          <Segmented
            label={t('Forecast horizon')}
            value={settings.horizon}
            onChange={(v) => set('horizon', v)}
            options={TF_INFO[settings.timeframe].horizons.map((h) => ({ value: h, label: dur(settings.timeframe, h) }))}
          />
        </div>
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink2 hover:bg-raised"
        >
          <SlidersHorizontal size={13} /> {t('Model settings')}
          <ChevronDown size={13} className={clsx('transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <div className="border-t border-line px-3 py-3">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            <NumberField label={t('Analogs (k)')} value={settings.k} min={10} max={400} step={10} onChange={(v) => set('k', Math.round(v))} hint={t('How many similar past bars to draw outcomes from. More = smoother but less specific.')} />
            <NumberField label={t('Min. gap between analogs')} value={settings.minGapBars} min={1} max={500} suffix={t('bars')} onChange={(v) => set('minGapBars', Math.round(v))} hint={t('Keeps one historical episode from supplying many near-identical analogs.')} />
            <NumberField label={t('History from')} value={settings.startYear} min={2011} max={2025} onChange={(v) => set('startYear', Math.round(v))} hint={t('Ignore history before this year.')} />
            <NumberField label={t('Base-rate blend')} value={Math.round(settings.baseRateBlend * 100)} min={0} max={100} step={10} suffix="%" onChange={(v) => set('baseRateBlend', v / 100)} hint={t('Share of the plain historical base rate mixed into the result. 0% = analogs only. Higher is steadier; backtests favour ~50%.')} />
            <NumberField label={t('Recency half-life')} value={settings.recencyHalfLifeYears} min={0} max={20} step={0.5} suffix={t('yrs')} onChange={(v) => set('recencyHalfLifeYears', v)} hint={t('Down-weight old analogs. 0 = all history counts equally.')} />
            <NumberField label={t('Scenario threshold')} value={settings.scenarioThresholdPct} min={0} max={60} step={0.5} suffix="%" onChange={(v) => set('scenarioThresholdPct', v)} hint={t('Move that separates rally / range / decline. 0 = automatic (half the expected move at current volatility).')} />
          </div>
          <div className="mt-2 max-w-sm">
            <Switch checked={settings.volAdjust} onChange={(v) => set('volAdjust', v)} label={t("Rescale past moves to today's volatility")} />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-mute">
            {t('Model inputs are chosen with the model input buttons in the metrics list. Every change re-runs the forecast and its backtest.')}
          </p>
        </div>
      )}
    </div>
  );
}

const SCENARIO_STYLE: Record<Scenario['id'], { color: string; Icon: typeof TrendingUp }> = {
  rally: { color: UI.up, Icon: TrendingUp },
  range: { color: UI.mute, Icon: Minus },
  decline: { color: UI.down, Icon: TrendingDown },
};

function ScenarioCard({ s, top, horizon, tf }: { s: Scenario; top: boolean; horizon: number; tf: Timeframe }) {
  const { t, dur } = useT();
  const { color, Icon } = SCENARIO_STYLE[s.id];
  const delta = (s.probability - s.baseProbability) * 100;
  return (
    <div className={clsx('rounded-md border bg-raised/60 p-2.5', top ? 'border-ink2/40' : 'border-line')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Icon size={15} style={{ color }} />
          <span className="text-sm font-semibold text-ink">{s.label}</span>
          {top && <Badge tone="accent">{t('Most likely')}</Badge>}
        </div>
        <span className="num text-xl font-semibold text-ink">{fmtProb(s.probability)}</span>
      </div>
      <div className="mt-1.5">
        <ProbBar value={s.probability} base={s.baseProbability} color={color} />
      </div>
      <div className="num mt-1 text-[11px] text-mute">
        {t('Usually {p}', { p: fmtProb(s.baseProbability) })} ·{' '}
        <span className={clsx(Math.abs(delta) >= 3 && 'font-medium text-ink')}>
          {Math.round(delta) === 0 ? t('same as usual') : t('{delta} pts', { delta: `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(0)}` })}
        </span>
      </div>
      <dl className="num mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-mute">{t('Median target')}</dt>
        <dd className="text-right text-ink">
          {fmtUsd(s.targetPrice)} <span className="text-mute">({fmtPct(s.targetPct)})</span>
        </dd>
        <dt className="text-mute">{t('Typical range')}</dt>
        <dd className="text-right text-ink2">
          {fmtUsd(s.lowPrice)} – {fmtUsd(s.highPrice)}
        </dd>
        {s.id !== 'range' ? (
          <>
            <dt className="text-mute">{t('Time to develop')}</dt>
            <dd className="text-right text-ink2">
              {s.daysToConfirm ? t('confirms after {dur}', { dur: fmtBars(tf, s.daysToConfirm) }) : '–'}
              {s.daysToExtreme ? t(s.id === 'rally' ? ', peaks {dur} in' : ', bottoms {dur} in', { dur: fmtBars(tf, s.daysToExtreme) }) : ''}
            </dd>
            <dt className="text-mute">{s.id === 'rally' ? t('Dip on the way') : t('Bounce on the way')}</dt>
            <dd className="text-right text-ink2">{fmtPct(s.adverseExcursionPct)}</dd>
          </>
        ) : (
          <>
            <dt className="text-mute">{t('Swings inside {dur}', { dur: dur(tf, horizon) })}</dt>
            <dd className="text-right text-ink2">
              {fmtPct(s.adverseExcursionPct)} / {fmtPct(s.favourableExcursionPct)}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** How unusual a reading is, in words, from its distance to its own historical average. */
function unusual(z: number): { word: string; strong: boolean } {
  const a = Math.abs(z);
  if (a < 0.5) return { word: msg('typical'), strong: false };
  if (a < 1.5) return { word: z > 0 ? msg('above normal') : msg('below normal'), strong: false };
  if (a < 2.5) return { word: z > 0 ? msg('far above normal') : msg('far below normal'), strong: true };
  return { word: z > 0 ? msg('extreme high') : msg('extreme low'), strong: true };
}

function Reading({ f, def }: { f: FeatureUse; def?: MetricDef }) {
  const { t } = useT();
  const z = Math.max(-3, Math.min(3, f.z));
  const u = unusual(f.z);
  return (
    <div className="text-xs" title={t('{z} standard deviations from its historical average', { z: f.z.toFixed(2) })}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-ink2">{def?.name ?? f.name}</span>
        <span className="num shrink-0 font-medium text-ink">{def ? fmtMetric(f.value, def.unit) : f.value.toFixed(2)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="relative h-1.5 flex-1 rounded-full bg-raised">
          <div className="absolute left-1/2 top-[-2px] h-2.5 w-px bg-mute" />
          <div
            className={clsx('absolute top-0 h-full rounded-full', u.strong ? 'bg-warn' : 'bg-accent')}
            style={z >= 0 ? { left: '50%', width: `${(z / 3) * 50}%` } : { right: '50%', width: `${(-z / 3) * 50}%` }}
          />
        </div>
        <span className={clsx('num w-40 shrink-0 whitespace-nowrap text-right text-[11px]', u.strong ? 'text-warn' : 'text-mute')}>
          {t(u.word)} · {f.z >= 0 ? '+' : '−'}{Math.abs(f.z).toFixed(1)}σ
        </span>
      </div>
    </div>
  );
}

interface PanelProps {
  forecast: ForecastResult;
  backtest?: BacktestResult;
  backtestPending: boolean;
  onOpenBacktest: () => void;
  /** Chance of a higher price from all three models together (the Today card), at the same horizon. */
  consensusPUp?: number;
  onOpenModels: () => void;
  metrics?: MetricDef[];
}

export function ForecastPanel({ forecast, backtest, backtestPending, onOpenBacktest, consensusPUp, onOpenModels, metrics }: PanelProps) {
  const { t, dur: durOf } = useT();
  const [showAnalogs, setShowAnalogs] = useState(false);
  const H = forecast.settings.horizon;
  const tf = forecast.settings.timeframe;
  const dur = durOf(tf, H);
  const verdictTone = backtest?.verdict.label === 'measurable edge' ? 'good' : backtest?.verdict.label === 'weak edge' ? 'warn' : 'crit';
  const matchTone = forecast.confidence.label === 'good' ? 'good' : forecast.confidence.label === 'moderate' ? 'warn' : 'crit';
  const defs = new Map((metrics ?? []).map((m) => [m.id, m]));

  return (
    <div className="flex flex-col gap-3">
      <Card title={t('Analog outlook · next {dur} · {tf} bars', { dur, tf: TF_INFO[tf].label })} right={<span className="num text-[11px] text-mute">{t('as of {time}', { time: fmtBarTime(forecast.asOf, tf) })} · {fmtUsd(forecast.price)}</span>}>
        <p className="text-[13px] leading-relaxed text-ink">{forecast.headline}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {backtest ? (
            <Badge tone={verdictTone} title={backtest.verdict.text}>{t('Backtest: {v}', { v: t(backtest.verdict.label) })}</Badge>
          ) : backtestPending ? (
            <Badge>{t('Backtest running…')}</Badge>
          ) : null}
          <Badge tone={matchTone} title={forecast.confidence.notes.join(' ')}>{t('Historical match: {v}', { v: t(forecast.confidence.label) })}</Badge>
        </div>
        {consensusPUp != null && (
          <div className="mt-2">
            {Math.abs(forecast.terminal.probUp - consensusPUp) < 0.05 ? (
              <p className="text-[11px] leading-relaxed text-mute">
                {t('This view is the analog model alone. All three models together (the Today card) agree: {c} chance of a higher price after {dur}.', { c: fmtProb(consensusPUp), dur })}
              </p>
            ) : (
              <Note tone="warn">
                {t(
                  forecast.terminal.probUp > consensusPUp
                    ? 'This view is the analog model alone, and it is more bullish than all three models together: {a} against {c} chance of a higher price after {dur}. The Today card uses all three.'
                    : 'This view is the analog model alone, and it is more bearish than all three models together: {a} against {c} chance of a higher price after {dur}. The Today card uses all three.',
                  { a: fmtProb(forecast.terminal.probUp), c: fmtProb(consensusPUp), dur },
                )}{' '}
                <button onClick={onOpenModels} className="text-[#7fb2f0] underline-offset-2 hover:underline">
                  {t('Compare the models')}
                </button>
              </Note>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2">
          {forecast.scenarios.map((s, i) => (
            <ScenarioCard key={s.id} s={s} top={i === 0} horizon={H} tf={tf} />
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          {t("Scenarios split the outcome at ±{t}% after {dur}. The white tick on each bar, and \"usually\", is how often that outcome happened across all history, regardless of today's readings.", { t: forecast.thresholdPct, dur })}
        </p>
      </Card>

      <Card title={t('How much to trust this')}>
        <div className="flex flex-col gap-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-ink">{t('Backtested skill of these inputs')}</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-mute">
                {backtest ? backtest.verdict.text : backtestPending ? t('Running a walk-forward backtest of this exact configuration…') : t('Backtest unavailable.')}
              </div>
              <button onClick={onOpenBacktest} className="mt-1 text-[11px] text-[#7fb2f0] underline-offset-2 hover:underline">
                {t('Open the backtest')}
              </button>
            </div>
            {backtest && <Badge tone={verdictTone}>{t(backtest.verdict.label)}</Badge>}
          </div>
          <div className="flex items-start justify-between gap-3 border-t border-line pt-2.5">
            <div className="min-w-0">
              <div className="text-xs font-medium text-ink">{t('Quality of the historical match')}</div>
              <ul className="mt-0.5 list-none space-y-1 text-[11px] leading-relaxed text-mute">
                {forecast.confidence.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
            <Badge tone={matchTone}>{t(forecast.confidence.label)}</Badge>
          </div>
        </div>
      </Card>

      <Card title={t('Where price ends after {dur}', { dur })}>
        <table className="w-full">
          <thead>
            <tr>
              <Th>{t('Probability')}</Th>
              <Th right>{t('Low')}</Th>
              <Th right>{t('High')}</Th>
              <Th right>{t('Range')}</Th>
            </tr>
          </thead>
          <tbody>
            {forecast.bands.map((b) => (
              <tr key={b.confidence} className="border-t border-line">
                <Td className="text-ink">{t('{p} of outcomes', { p: fmtProb(b.confidence) })}</Td>
                <Td right>{fmtUsd(b.lowPrice)}</Td>
                <Td right>{fmtUsd(b.highPrice)}</Td>
                <Td right className="text-mute">
                  {fmtPctAuto(b.lowPct, true)} … {fmtPctAuto(b.highPct, true)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="num mt-2 grid grid-cols-3 gap-2 text-xs">
          {[
            { label: t('Chance higher'), value: fmtProb(forecast.terminal.probUp), usual: fmtProb(forecast.base.probUp) },
            { label: t('Median'), value: fmtPct(forecast.terminal.p50), usual: fmtPct(forecast.base.p50) },
            { label: t('Mean'), value: fmtPct(forecast.terminal.mean), usual: fmtPct(forecast.base.mean) },
          ].map((x) => (
            <div key={x.label} className="rounded-md bg-raised px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wider text-mute">{x.label}</div>
              <div className="font-semibold text-ink">{x.value}</div>
              <div className="text-[10.5px] text-mute">{t('usually {x}', { x: x.usual })}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title={t("Today's readings used by the model")}>
        {forecast.featuresDropped.length > 0 && (
          <div className="mb-2">
            <Note tone="warn">
              {t('Ignored: {list}', { list: forecast.featuresDropped.map((d) => `${d.id} (${d.reason})`).join('; ') })}
            </Note>
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {[...forecast.featuresUsed]
            .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
            .map((f) => (
              <Reading key={f.id} f={f} def={defs.get(f.id)} />
            ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          {t('Most unusual first. Each bar shows how far the reading sits from its own historical average, in standard deviations (σ). The model searches {cand} past bars for the {k} where the same combination occurred most closely.', { cand: forecast.sample.candidates.toLocaleString('en-US'), k: forecast.sample.neighbors })}
        </p>
        <button
          onClick={() => setShowAnalogs(!showAnalogs)}
          aria-expanded={showAnalogs}
          className="mt-2 flex items-center gap-1 text-[11px] text-[#7fb2f0] underline-offset-2 hover:underline"
        >
          <ChevronDown size={12} className={clsx('transition-transform', showAnalogs && 'rotate-180')} />
          {t(showAnalogs ? 'Hide the {n} closest historical analogs' : 'Show the {n} closest historical analogs', { n: forecast.analogs.length })}
        </button>
        {showAnalogs && (
          <div className="thin-scroll mt-2 max-h-72 overflow-auto rounded-md border border-line">
            <table className="w-full">
              <thead className="sticky top-0 bg-panel">
                <tr>
                  <Th>{t('Date')}</Th>
                  <Th right>{t('Price')}</Th>
                  <Th right title={t('Distance in standard deviations per input; lower is more similar')}>{t('Dist.')}</Th>
                  <Th right title={t('What price actually did over the next {dur}', { dur })}>{t('Next {dur}', { dur })}</Th>
                  <Th right title={t("Best and worst excursion inside the window, rescaled to today's volatility")}>{t('Max up / down')}</Th>
                </tr>
              </thead>
              <tbody>
                {forecast.analogs.map((a) => (
                  <tr key={a.t} className="border-t border-line">
                    <Td>{fmtBarTime(a.t, tf)}</Td>
                    <Td right>{fmtUsd(a.price)}</Td>
                    <Td right className="text-mute">{a.distance.toFixed(2)}</Td>
                    <Td right className={a.fwdReturnPct >= 0 ? 'text-up' : 'text-down'}>{fmtPct(a.fwdReturnPct)}</Td>
                    <Td right className="text-mute">
                      {fmtPct(a.maxUpPct, 0)} / {fmtPct(a.maxDownPct, 0)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
