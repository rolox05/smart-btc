import { durationLabel, type BacktestResult } from '@smart-btc/shared';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { fmtDate, fmtPct, fmtProb } from '../lib/format';
import { SERIES, UI } from '../lib/palette';
import { Async, Badge, Card, ChartTip, Legend, Note, NumberField, Stat, Td, Th } from './ui';

interface Props {
  query: { data: BacktestResult | undefined; error: Error | null; isPending: boolean; isFetching: boolean };
  params: { stepBars: number; touchPct: number };
  onParams: (p: { stepBars: number; touchPct: number }) => void;
}

export function BacktestPanel({ query, params, onParams }: Props) {
  return (
    <div className="flex flex-col gap-3">
      <Card title="Walk-forward backtest" right={query.isFetching ? <span className="text-[11px] text-mute">running…</span> : null}>
        <p className="text-xs leading-relaxed text-ink2">
          For each past bar the forecast is rebuilt with only the data that existed then, and scored against what happened next and against the plain base rate. It tests the exact inputs and settings currently selected.
        </p>
        <div className="mt-2.5 grid grid-cols-2 gap-2.5">
          <NumberField label="Evaluate every" value={params.stepBars} min={1} max={500} suffix="bars" onChange={(v) => onParams({ ...params, stepBars: Math.round(v) })} hint="Spacing between scored forecasts. Long intraday histories are thinned automatically to about 1,500 forecasts." />
          <NumberField label="Touch level scored" value={params.touchPct} min={0} max={50} step={0.5} suffix="%" onChange={(v) => onParams({ ...params, touchPct: v })} hint="0 = automatic: about one expected move over the horizon." />
        </div>
      </Card>

      <Async query={query} loadingLabel="Replaying history…">
        {(r) => {
          const dur = durationLabel(r.settings.timeframe, r.settings.horizon);
          const tone = r.verdict.label === 'measurable edge' ? 'good' : r.verdict.label === 'weak edge' ? 'warn' : 'crit';
          const calib = r.calibration.filter((c) => c.n >= 15).map((c) => ({ x: c.predicted * 100, y: c.observed * 100, n: c.n }));
          const equity = r.equity.map((e) => ({ t: e.t, strategy: e.strategy, buyHold: e.buyHold }));
          return (
            <>
              <Card title="Verdict" right={<Badge tone={tone}>{r.verdict.label}</Badge>}>
                <p className="text-xs leading-relaxed text-ink">{r.verdict.text}</p>
                <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Forecasts scored" value={r.evaluations.toLocaleString('en-US')} sub={`${fmtDate(r.from)} → ${fmtDate(r.to)}`} />
                  <Stat label="Independent windows" value={`≈ ${r.independentSamples}`} sub={`${dur}, non-overlapping`} />
                  <Stat label="Direction called right" value={fmtProb(r.directional.accuracy)} sub={`always-long: ${fmtProb(r.directional.alwaysLong)}`} />
                  <Stat label="80% band contained" value={fmtProb(r.coverage[0].observed)} sub={`50% band: ${fmtProb(r.coverage[1].observed)}`} />
                </div>
              </Card>

              <Card title="Skill by question">
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Event</Th>
                      <Th right title="How often it actually happened">Happened</Th>
                      <Th right title="Brier skill score versus the base rate. Positive = the inputs added information.">Skill vs base rate</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.scores.map((s) => {
                      const w = Math.min(1, Math.abs(s.skill) / 0.1) * 50;
                      return (
                        <tr key={s.event} className="border-t border-line">
                          <Td className="whitespace-normal text-ink2">{s.label}</Td>
                          <Td right>{fmtProb(s.frequency)}</Td>
                          <Td right>
                            <div className="flex items-center justify-end gap-2">
                              <div className="relative h-1.5 w-20 rounded-full bg-raised">
                                <div className="absolute left-1/2 top-[-2px] h-2.5 w-px bg-mute" />
                                <div
                                  className="absolute top-0 h-full rounded-full"
                                  style={s.skill >= 0 ? { left: '50%', width: `${w}%`, background: SERIES[0] } : { right: '50%', width: `${w}%`, background: SERIES[7] }}
                                />
                              </div>
                              <span className="w-12 text-right text-ink">{fmtPct(s.skill * 100)}</span>
                            </div>
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="mt-2 text-[11px] leading-relaxed text-mute">
                  0% = no better than quoting BTC's long-run frequency. In liquid markets a few percent is already meaningful; double digits should make you suspicious of over-fitting. Median forecast error: {r.medianError.model.toFixed(1)} pts vs {r.medianError.base.toFixed(1)} pts for "no change".
                </p>
              </Card>

              <Card title="Calibration: when the model said X%, how often did it happen?">
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid stroke={UI.grid} />
                      <XAxis type="number" dataKey="x" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fill: UI.mute, fontSize: 10 }} tickLine={false} axisLine={{ stroke: UI.line }} tickFormatter={(v) => `${v}%`} />
                      <YAxis type="number" dataKey="y" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fill: UI.mute, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
                      <ZAxis type="number" dataKey="n" range={[40, 260]} />
                      <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]} stroke={UI.mute} strokeDasharray="4 4" />
                      <Tooltip
                        cursor={false}
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload as (typeof calib)[number];
                          return (
                            <ChartTip
                              title={`Model said ~${d.x.toFixed(0)}%`}
                              rows={[
                                { label: 'It happened', value: `${d.y.toFixed(0)}%` },
                                { label: 'Forecasts', value: d.n.toLocaleString('en-US') },
                              ]}
                            />
                          );
                        }}
                      />
                      <Scatter data={calib} fill={SERIES[0]} stroke={UI.panel} strokeWidth={2} isAnimationActive={false} />
                    </ScatterChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-mute">
                  x: predicted probability, y: observed frequency, pooled over the five events; dot size = number of forecasts. Dots on the dashed diagonal mean the probabilities can be taken at face value.
                </p>
              </Card>

              <Card title={`What followed each P(up) reading (return over ${dur})`}>
                <table className="w-full">
                  <thead>
                    <tr>
                      <Th>Model reading</Th>
                      <Th right>Count</Th>
                      <Th right>Ended higher</Th>
                      <Th right>Avg</Th>
                      <Th right>Median</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.signals.map((s) => (
                      <tr key={s.label} className="border-t border-line">
                        <Td className="text-ink2">{s.label}</Td>
                        <Td right>{s.n}</Td>
                        <Td right>{s.n ? fmtProb(s.winRate) : '–'}</Td>
                        <Td right className={s.n ? (s.avgReturnPct >= 0 ? 'text-up' : 'text-down') : 'text-mute'}>{s.n ? fmtPct(s.avgReturnPct) : '–'}</Td>
                        <Td right className={s.n ? (s.medianReturnPct >= 0 ? 'text-up' : 'text-down') : 'text-mute'}>{s.n ? fmtPct(s.medianReturnPct) : '–'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[11px] leading-relaxed text-mute">
                  If the inputs carry information, higher readings should be followed by better returns, row by row.
                </p>
              </Card>

              <Card title="Simple rule vs buy & hold" right={<Legend items={[{ label: 'Rule', color: SERIES[0] }, { label: 'Buy & hold', color: UI.mute }]} />}>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={equity} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
                      <CartesianGrid stroke={UI.grid} vertical={false} />
                      <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tick={{ fill: UI.mute, fontSize: 10 }} tickLine={false} axisLine={{ stroke: UI.line }} tickFormatter={(t) => String(new Date(t * 1000).getUTCFullYear())} minTickGap={40} />
                      <YAxis scale="log" domain={['auto', 'auto']} tick={{ fill: UI.mute, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${Number(v) >= 10 ? Number(v).toFixed(0) : Number(v).toFixed(1)}×`} allowDataOverflow />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload as (typeof equity)[number];
                          return (
                            <ChartTip
                              title={fmtDate(d.t)}
                              rows={[
                                { label: 'Rule', value: `${d.strategy.toFixed(2)}×`, color: SERIES[0] },
                                { label: 'Buy & hold', value: `${d.buyHold.toFixed(2)}×`, color: UI.mute },
                              ]}
                            />
                          );
                        }}
                      />
                      <Line dataKey="buyHold" stroke={UI.mute} strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line dataKey="strategy" stroke={SERIES[0]} strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Rule return" value={fmtPct(r.strategy.totalReturnPct, 0)} sub={`${r.strategy.trades} trades`} />
                  <Stat label="Buy & hold" value={fmtPct(r.strategy.buyHoldReturnPct, 0)} />
                  <Stat label="Rule max drawdown" value={fmtPct(r.strategy.maxDrawdownPct, 0)} />
                  <Stat label="B&H max drawdown" value={fmtPct(r.strategy.buyHoldMaxDrawdownPct, 0)} />
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-mute">
                  {r.strategy.rule} Growth of 1 unit, log scale; drawdowns measured at trade ends. This is an illustration of the signal, not a tradable system: one path, few trades, no slippage.
                </p>
              </Card>

              <Note>
                A backtest is the best evidence available, not a guarantee: Bitcoin has completed only a handful of market cycles, and the more settings you try, the more likely one of them looks good by chance.
              </Note>
            </>
          );
        }}
      </Async>
    </div>
  );
}
