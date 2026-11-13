import { TF_INFO, durationLabel, type BacktestResult, type ForecastResult, type ForecastSettings, type Scenario, type Timeframe } from '@smart-btc/shared';
import clsx from 'clsx';
import { ChevronDown, Minus, SlidersHorizontal, TrendingDown, TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { fmtBarTime, fmtBars, fmtPct, fmtPctAuto, fmtProb, fmtUsd } from '../lib/format';
import { UI } from '../lib/palette';
import { Badge, Card, Note, NumberField, ProbBar, Segmented, Switch, Td, Th } from './ui';

type Settings = Omit<ForecastSettings, 'features'>;

export function ForecastSettingsBar({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink2">Horizon</span>
          <Segmented
            label="Forecast horizon"
            value={settings.horizon}
            onChange={(v) => set('horizon', v)}
            options={TF_INFO[settings.timeframe].horizons.map((h) => ({ value: h, label: durationLabel(settings.timeframe, h) }))}
          />
        </div>
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink2 hover:bg-raised"
        >
          <SlidersHorizontal size={13} /> Model settings
          <ChevronDown size={13} className={clsx('transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && (
        <div className="border-t border-line px-3 py-3">
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            <NumberField label="Analogs (k)" value={settings.k} min={10} max={400} step={10} onChange={(v) => set('k', Math.round(v))} hint="How many similar past bars to draw outcomes from. More = smoother but less specific." />
            <NumberField label="Min. gap between analogs" value={settings.minGapBars} min={1} max={500} suffix="bars" onChange={(v) => set('minGapBars', Math.round(v))} hint="Keeps one historical episode from supplying many near-identical analogs." />
            <NumberField label="History from" value={settings.startYear} min={2011} max={2025} onChange={(v) => set('startYear', Math.round(v))} hint="Ignore history before this year." />
            <NumberField label="Base-rate blend" value={Math.round(settings.baseRateBlend * 100)} min={0} max={100} step={10} suffix="%" onChange={(v) => set('baseRateBlend', v / 100)} hint="Share of the plain historical base rate mixed into the result. 0% = analogs only. Higher is steadier; backtests favour ~50%." />
            <NumberField label="Recency half-life" value={settings.recencyHalfLifeYears} min={0} max={20} step={0.5} suffix="yrs" onChange={(v) => set('recencyHalfLifeYears', v)} hint="Down-weight old analogs. 0 = all history counts equally." />
            <NumberField label="Scenario threshold" value={settings.scenarioThresholdPct} min={0} max={60} step={0.5} suffix="%" onChange={(v) => set('scenarioThresholdPct', v)} hint="Move that separates rally / range / decline. 0 = automatic (half the expected move at current volatility)." />
          </div>
          <div className="mt-2 max-w-sm">
            <Switch checked={settings.volAdjust} onChange={(v) => set('volAdjust', v)} label="Rescale past moves to today's volatility" />
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-mute">
            Model inputs are chosen with the <span className="text-ink2">model input</span> buttons in the metrics list. Every change re-runs the forecast and its backtest.
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
  const { color, Icon } = SCENARIO_STYLE[s.id];
  const delta = (s.probability - s.baseProbability) * 100;
  return (
    <div className={clsx('rounded-md border bg-raised/60 p-2.5', top ? 'border-ink2/40' : 'border-line')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Icon size={15} style={{ color }} />
          <span className="text-sm font-semibold text-ink">{s.label}</span>
          {top && <Badge tone="accent">Most likely</Badge>}
        </div>
        <span className="num text-xl font-semibold text-ink">{fmtProb(s.probability)}</span>
      </div>
      <div className="mt-1.5">
        <ProbBar value={s.probability} base={s.baseProbability} color={color} />
      </div>
      <div className="num mt-1 text-[11px] text-mute">
        Base rate {fmtProb(s.baseProbability)} ({delta >= 0 ? '+' : ''}
        {delta.toFixed(0)} pts)
      </div>
      <dl className="num mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <dt className="text-mute">Median target</dt>
        <dd className="text-right text-ink">
          {fmtUsd(s.targetPrice)} <span className="text-mute">({fmtPct(s.targetPct)})</span>
        </dd>
        <dt className="text-mute">Typical range</dt>
        <dd className="text-right text-ink2">
          {fmtUsd(s.lowPrice)} – {fmtUsd(s.highPrice)}
        </dd>
        {s.id !== 'range' ? (
          <>
            <dt className="text-mute">Time to develop</dt>
            <dd className="text-right text-ink2">
              {s.daysToConfirm ? `confirms after ${fmtBars(tf, s.daysToConfirm)}` : '–'}
              {s.daysToExtreme ? `, ${s.id === 'rally' ? 'peaks' : 'bottoms'} ${fmtBars(tf, s.daysToExtreme)} in` : ''}
            </dd>
            <dt className="text-mute">{s.id === 'rally' ? 'Dip on the way' : 'Bounce on the way'}</dt>
            <dd className="text-right text-ink2">{fmtPct(s.adverseExcursionPct)}</dd>
          </>
        ) : (
          <>
            <dt className="text-mute">Swings inside {durationLabel(tf, horizon)}</dt>
            <dd className="text-right text-ink2">
              {fmtPct(s.adverseExcursionPct)} / {fmtPct(s.favourableExcursionPct)}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function ForecastPanel({ forecast, backtest, backtestPending, onOpenBacktest }: { forecast: ForecastResult; backtest?: BacktestResult; backtestPending: boolean; onOpenBacktest: () => void }) {
  const [showAnalogs, setShowAnalogs] = useState(false);
  const H = forecast.settings.horizon;
  const tf = forecast.settings.timeframe;
  const dur = durationLabel(tf, H);
  const verdictTone = backtest?.verdict.label === 'measurable edge' ? 'good' : backtest?.verdict.label === 'weak edge' ? 'warn' : 'crit';
  const matchTone = forecast.confidence.label === 'good' ? 'good' : forecast.confidence.label === 'moderate' ? 'warn' : 'crit';

  return (
    <div className="flex flex-col gap-3">
      <Card title={`Outlook · next ${dur} · ${TF_INFO[tf].label} bars`} right={<span className="num text-[11px] text-mute">as of {fmtBarTime(forecast.asOf, tf)} · {fmtUsd(forecast.price)}</span>}>
        <p className="text-[13px] leading-relaxed text-ink">{forecast.headline}</p>

        <div className="mt-3 flex flex-col gap-2">
          {forecast.scenarios.map((s, i) => (
            <ScenarioCard key={s.id} s={s} top={i === 0} horizon={H} tf={tf} />
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          Scenarios split the outcome at ±{forecast.thresholdPct}% after {dur}. The white tick on each bar is the base rate: how often that outcome happened across all history, regardless of today's readings.
        </p>
      </Card>

      <Card title="How much to trust this">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-ink">Backtested skill of these inputs</div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-mute">
                {backtest ? backtest.verdict.text : backtestPending ? 'Running a walk-forward backtest of this exact configuration…' : 'Backtest unavailable.'}
              </div>
              <button onClick={onOpenBacktest} className="mt-1 text-[11px] text-[#7fb2f0] underline-offset-2 hover:underline">
                Open the backtest
              </button>
            </div>
            {backtest && <Badge tone={verdictTone}>{backtest.verdict.label}</Badge>}
          </div>
          <div className="flex items-start justify-between gap-3 border-t border-line pt-2.5">
            <div className="min-w-0">
              <div className="text-xs font-medium text-ink">Quality of the historical match</div>
              <ul className="mt-0.5 list-none space-y-1 text-[11px] leading-relaxed text-mute">
                {forecast.confidence.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
            <Badge tone={matchTone}>{forecast.confidence.label}</Badge>
          </div>
        </div>
      </Card>

      <Card title={`Where price ends after ${dur}`}>
        <table className="w-full">
          <thead>
            <tr>
              <Th>Probability</Th>
              <Th right>Low</Th>
              <Th right>High</Th>
              <Th right>Range</Th>
            </tr>
          </thead>
          <tbody>
            {forecast.bands.map((b) => (
              <tr key={b.confidence} className="border-t border-line">
                <Td className="text-ink">{fmtProb(b.confidence)} of outcomes</Td>
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
          <div className="rounded-md bg-raised px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-mute">P(higher)</div>
            <div className="font-semibold text-ink">
              {fmtProb(forecast.terminal.probUp)} <span className="font-normal text-mute">vs {fmtProb(forecast.base.probUp)}</span>
            </div>
          </div>
          <div className="rounded-md bg-raised px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-mute">Median</div>
            <div className="font-semibold text-ink">
              {fmtPct(forecast.terminal.p50)} <span className="font-normal text-mute">vs {fmtPct(forecast.base.p50)}</span>
            </div>
          </div>
          <div className="rounded-md bg-raised px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-mute">Mean</div>
            <div className="font-semibold text-ink">
              {fmtPct(forecast.terminal.mean)} <span className="font-normal text-mute">vs {fmtPct(forecast.base.mean)}</span>
            </div>
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-mute">"vs" figures are the base rate.</p>
      </Card>

      <Card title="Today's readings used by the model">
        {forecast.featuresDropped.length > 0 && (
          <div className="mb-2">
            <Note tone="warn">
              Ignored: {forecast.featuresDropped.map((d) => `${d.id} (${d.reason})`).join('; ')}
            </Note>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {forecast.featuresUsed.map((f) => {
            const z = Math.max(-3, Math.min(3, f.z));
            return (
              <div key={f.id} className="flex items-center gap-2 text-xs" title={`${f.z.toFixed(2)} standard deviations from its historical average`}>
                <span className="w-28 shrink-0 truncate text-ink2">{f.name}</span>
                <div className="relative h-1.5 flex-1 rounded-full bg-raised">
                  <div className="absolute left-1/2 top-[-2px] h-2.5 w-px bg-mute" />
                  <div
                    className="absolute top-0 h-full rounded-full bg-accent"
                    style={z >= 0 ? { left: '50%', width: `${(z / 3) * 50}%` } : { right: '50%', width: `${(-z / 3) * 50}%` }}
                  />
                </div>
                <span className="num w-14 shrink-0 text-right text-mute">{f.z >= 0 ? '+' : ''}{f.z.toFixed(1)}σ</span>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          Bars show how unusual each reading is versus its own history. The model searches {forecast.sample.candidates.toLocaleString('en-US')} past bars for the {forecast.sample.neighbors} most similar combinations.
        </p>
        <button
          onClick={() => setShowAnalogs(!showAnalogs)}
          aria-expanded={showAnalogs}
          className="mt-2 flex items-center gap-1 text-[11px] text-[#7fb2f0] underline-offset-2 hover:underline"
        >
          <ChevronDown size={12} className={clsx('transition-transform', showAnalogs && 'rotate-180')} />
          {showAnalogs ? 'Hide' : 'Show'} the {forecast.analogs.length} closest historical analogs
        </button>
        {showAnalogs && (
          <div className="thin-scroll mt-2 max-h-72 overflow-auto rounded-md border border-line">
            <table className="w-full">
              <thead className="sticky top-0 bg-panel">
                <tr>
                  <Th>Date</Th>
                  <Th right>Price</Th>
                  <Th right title="Distance in standard deviations per input; lower is more similar">Dist.</Th>
                  <Th right title={`What price actually did over the next ${dur}`}>Next {dur}</Th>
                  <Th right title="Best and worst excursion inside the window, rescaled to today's volatility">Max up / down</Th>
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
