import { durationLabel, type BacktestRequest, type BacktestSummary, type ForecastSettings, type MetricDef } from '@smart-btc/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { BrainCircuit, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { fmtPct } from '../lib/format';
import { SERIES } from '../lib/palette';
import { Card, DivergingBar, Note, Td, Th } from './ui';

interface Props {
  metrics: MetricDef[];
  model: string[];
  /** Current forecast settings, including the selected inputs. */
  settings: ForecastSettings;
  params: { stepBars: number; touchPct: number };
  dataVersion: number | undefined;
  /** Key of the configuration the user asked to rank; ranking only runs while it matches. */
  armedKey: string | null;
  onArm: (key: string) => void;
  onToggleModel: (id: string) => void;
}

interface Job {
  key: readonly unknown[];
  req: BacktestRequest;
}

const RANK_STEP_MIN = 5;

/** Blue = beats the base rate, red = worse. */
const SkillBar = ({ value }: { value: number }) => <DivergingBar value={value} scale={0.08} positive={SERIES[0]} negative={SERIES[7]} />;

export function RankingPanel({ metrics, model, settings, params, dataVersion, armedKey, onArm, onToggleModel }: Props) {
  const qc = useQueryClient();
  const [, setTick] = useState(0);
  const candidates = useMemo(() => metrics.filter((m) => m.forecastable), [metrics]);
  const stepBars = Math.max(RANK_STEP_MIN, params.stepBars);

  // Everything except the input selection identifies "a ranking run".
  const { features: _features, ...base } = settings;
  const configKey = JSON.stringify([base, stepBars, params.touchPct, dataVersion]);
  const armed = armedKey === configKey;

  const jobFor = (features: string[]): Job | null => {
    if (features.length === 0) return null;
    const sorted = [...features].sort();
    return {
      key: ['backtest-summary', configKey, sorted.join(',')],
      req: { settings: { ...base, features: sorted }, stepBars, touchPct: params.touchPct },
    };
  };

  const plan = useMemo(() => {
    const baseline = jobFor(model);
    const rows = candidates.map((m) => {
      const inModel = model.includes(m.id);
      return {
        metric: m,
        inModel,
        solo: jobFor([m.id])!,
        // The set with this input flipped: removed if it is in the model, added if it is not.
        variant: jobFor(inModel ? model.filter((id) => id !== m.id) : [...model, m.id]),
      };
    });
    // Solo runs first (they survive input changes), then the baseline, then the flipped sets.
    const ordered = [...rows.map((r) => r.solo), baseline, ...rows.map((r) => r.variant)].filter((j): j is Job => j !== null);
    const seen = new Set<string>();
    const jobs = ordered.filter((j) => {
      const k = JSON.stringify(j.key);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { baseline, rows, jobs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, model, configKey]);

  const jobsKey = JSON.stringify(plan.jobs.map((j) => j.key));
  useEffect(() => {
    if (!armed) return;
    let cancelled = false;
    // One backtest at a time: each takes about a second of server time, and the rest of the app keeps polling.
    void (async () => {
      for (const job of plan.jobs) {
        if (cancelled) return;
        try {
          await qc.fetchQuery({ queryKey: job.key, queryFn: () => api.backtestSummary(job.req), staleTime: 60 * 60_000, retry: false });
        } catch {
          /* kept in the query cache as an error and shown in the row */
        }
        if (!cancelled) setTick((t) => t + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, jobsKey]);

  const read = (job: Job | null) => {
    if (!job) return { data: undefined, error: null, settled: true };
    const s = qc.getQueryState<BacktestSummary, Error>(job.key);
    return { data: s?.data, error: s?.status === 'error' ? s.error : null, settled: s?.status === 'success' || s?.status === 'error' };
  };

  const done = plan.jobs.filter((j) => read(j).settled).length;
  const total = plan.jobs.length;
  const running = armed && done < total;
  const baseline = read(plan.baseline);
  const baseSkill = plan.baseline ? baseline.data?.avgSkill : 0;

  const rows = plan.rows
    .map((r) => {
      const solo = read(r.solo);
      const variant = read(r.variant);
      const variantSkill = r.variant ? variant.data?.avgSkill : 0;
      // Contribution of an input already in the set, or the change from adding one that is not.
      const effect = baseSkill == null || variantSkill == null ? null : r.inModel ? baseSkill - variantSkill : variantSkill - baseSkill;
      const refEvals = baseline.data?.evaluations;
      const cmpEvals = (r.inModel ? baseline.data : variant.data)?.evaluations;
      const shorter = !r.inModel && refEvals != null && cmpEvals != null && cmpEvals < refEvals * 0.85;
      return { ...r, soloData: solo.data, soloError: solo.error, effect, shorter };
    })
    .sort((a, b) => (b.soloData?.avgSkill ?? -Infinity) - (a.soloData?.avgSkill ?? -Infinity));

  const started = done > 0 || armed;

  return (
    <div className="flex flex-col gap-3">
      <Card
        title="Which inputs carry information?"
        right={
          <button
            onClick={() => onArm(configKey)}
            disabled={running || (armed && done === total)}
            className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-ink2 hover:bg-raised disabled:opacity-50"
          >
            <Play size={12} /> {running ? `Running ${done}/${total}` : armed ? 'Up to date' : 'Run ranking'}
          </button>
        }
      >
        <p className="text-xs leading-relaxed text-ink2">
          Backtests every metric on its own, then checks what each one adds to (or takes from) your current set of inputs, for the {durationLabel(settings.timeframe, settings.horizon)} horizon on {settings.timeframe} bars and the model settings above. Skill is the Brier skill against the base rate, averaged over the five scored events; 0% means no better than BTC's long-run frequencies.
        </p>
        {started && (
          <div className="mt-2.5">
            <div className="h-1.5 w-full rounded-full bg-raised">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
            </div>
            <div className="num mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-mute">
              <span>
                {done} of {total} backtests{running ? ' · about a second each' : ''} · evaluated every {stepBars}+ bars
              </span>
              {plan.baseline && (
                <span>
                  Your set ({model.length} input{model.length === 1 ? '' : 's'}):{' '}
                  <span className="text-ink">{baseline.data ? fmtPct(baseline.data.avgSkill * 100) : baseline.error ? 'not enough history' : '…'}</span>
                </span>
              )}
            </div>
          </div>
        )}
        {!started && <p className="mt-2 text-[11px] text-mute">Takes roughly {Math.round(total * 0.8)} seconds. Results are kept while the settings stay the same.</p>}
      </Card>

      {started && (
        <Card title="Ranking">
          <table className="w-full">
            <thead>
              <tr>
                <Th>Input</Th>
                <Th right title="Skill of a model that uses only this input">Alone</Th>
                <Th right title="For inputs in your set: how much skill is lost without it. For the others: how much skill changes when it is added.">In your set</Th>
                <Th right>Use</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const since = r.soloData ? new Date(r.soloData.from * 1000).getUTCFullYear() : null;
                return (
                  <tr key={r.metric.id} className="border-t border-line" title={r.metric.description}>
                    <Td className="whitespace-normal">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: SERIES[r.metric.colorSlot] }} />
                        <div className="min-w-0">
                          <div className="truncate text-ink">{r.metric.name}</div>
                          <div className="text-[10.5px] text-mute">
                            {r.soloError ? r.soloError.message : since ? `scored from ${since} · ${r.soloData!.evaluations.toLocaleString('en-US')} forecasts` : 'waiting…'}
                          </div>
                        </div>
                      </div>
                    </Td>
                    <Td right>
                      {r.soloData ? (
                        <div className="flex items-center justify-end gap-2">
                          <SkillBar value={r.soloData.avgSkill} />
                          <span className="w-12 text-right text-ink">{fmtPct(r.soloData.avgSkill * 100)}</span>
                        </div>
                      ) : (
                        <span className="text-mute">–</span>
                      )}
                    </Td>
                    <Td right>
                      {r.effect != null ? (
                        <span
                          className="text-ink2"
                          title={
                            r.inModel
                              ? 'Skill your set loses if this input is removed'
                              : r.shorter
                                ? 'Change in skill if added. This input has a shorter history, so the two backtests cover different periods and are not directly comparable.'
                                : 'Change in skill if this input is added to your set'
                          }
                        >
                          {r.inModel ? 'in set: ' : 'if added: '}
                          <span className="text-ink">{fmtPct(r.effect * 100)}</span>
                          {r.shorter && <span className="text-warn"> *</span>}
                        </span>
                      ) : (
                        <span className="text-mute">–</span>
                      )}
                    </Td>
                    <Td right>
                      <button
                        onClick={() => onToggleModel(r.metric.id)}
                        aria-pressed={r.inModel}
                        aria-label={`${r.inModel ? 'Remove' : 'Use'} ${r.metric.name} as a forecast input`}
                        title={r.inModel ? 'In your set: click to remove' : 'Click to add to your set'}
                        className={clsx('rounded p-1', r.inModel ? 'bg-accent/20 text-[#7fb2f0]' : 'text-mute hover:text-ink2')}
                      >
                        <BrainCircuit size={14} />
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] leading-relaxed text-mute">
            Sorted by skill alone. <span className="text-warn">*</span> marks inputs with a shorter history than your set: adding them changes the period being scored, so that figure is indicative only. Changing your set re-runs only the "in your set" column.
          </p>
        </Card>
      )}

      <Note>
        Ranking many inputs and keeping the winners is itself a form of over-fitting: with this many candidates, one or two will look good by luck. Prefer inputs that hold up across several horizons and that you have a reason to believe in, and treat differences of a percent or less as noise.
      </Note>
    </div>
  );
}
