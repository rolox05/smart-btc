import { durationLabel, type ForecastResult } from '@smart-btc/shared';
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtBars, fmtPctAuto, fmtProb, fmtUsd } from '../lib/format';
import { SERIES, UI } from '../lib/palette';
import { Card, ChartTip, Legend, ProbBar, Td, Th } from './ui';

/** Probability of reaching ±X% at any point inside the horizon, plus the outcome distribution. */
export function OddsPanel({ forecast }: { forecast: ForecastResult }) {
  const tf = forecast.settings.timeframe;
  const dur = durationLabel(tf, forecast.settings.horizon);
  const hist = forecast.histogram.map((b) => ({
    label: `${b.from}`,
    range: `${fmtPctAuto(b.from, true)} to ${fmtPctAuto(b.to, true)}`,
    mid: (b.from + b.to) / 2,
    model: b.model * 100,
    base: b.base * 100,
  }));

  return (
    <div className="flex flex-col gap-3">
      <Card title={`Odds of touching a level within ${dur}`}>
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full min-w-[420px]">
            <thead>
              <tr>
                <Th>Move</Th>
                <Th>Up: price · probability</Th>
                <Th right title="Median time until the level was first touched, when it was touched">When</Th>
                <Th>Down: price · probability</Th>
                <Th right title="Median time until the level was first touched, when it was touched">When</Th>
                <Th right title="Of the paths that touched either level, the share that hit the upside one first">Up first</Th>
              </tr>
            </thead>
            <tbody>
              {forecast.touch.map((t) => (
                <tr key={t.pct} className="border-t border-line align-middle">
                  <Td className="font-medium text-ink">±{fmtPctAuto(t.pct)}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <span className="w-16 text-ink2">{fmtUsd(t.upPrice)}</span>
                      <div className="w-16"><ProbBar value={t.up} base={t.baseUp} color={UI.up} /></div>
                      <span className="w-8 text-right font-medium text-ink">{fmtProb(t.up)}</span>
                    </div>
                  </Td>
                  <Td right className="text-mute">{fmtBars(tf, t.upDays)}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <span className="w-16 text-ink2">{fmtUsd(t.downPrice)}</span>
                      <div className="w-16"><ProbBar value={t.down} base={t.baseDown} color={UI.down} /></div>
                      <span className="w-8 text-right font-medium text-ink">{fmtProb(t.down)}</span>
                    </div>
                  </Td>
                  <Td right className="text-mute">{fmtBars(tf, t.downDays)}</Td>
                  <Td right className="text-ink2">{fmtProb(t.upFirst)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          "Touch" means a bar's high (or low) reached the level at least once: the question that matters for a take-profit or stop order. White ticks mark the base rate. Both sides can be touched in the same window, so the two columns do not add up to 100%.
        </p>
      </Card>

      <Card title={`Distribution of returns over ${dur}`} right={<Legend items={[{ label: 'Model', color: SERIES[0] }, { label: 'Base rate', color: UI.mute }]} />}>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={hist} margin={{ top: 6, right: 4, left: -18, bottom: 0 }} barGap={2} barCategoryGap="18%">
              <CartesianGrid stroke={UI.grid} vertical={false} />
              <XAxis dataKey="label" tick={{ fill: UI.mute, fontSize: 10 }} tickLine={false} axisLine={{ stroke: UI.line }} tickFormatter={(v) => `${v}%`} interval="preserveStartEnd" />
              <YAxis tick={{ fill: UI.mute, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as (typeof hist)[number];
                  return (
                    <ChartTip
                      title={`Return ${d.range}`}
                      rows={[
                        { label: 'Model', value: `${d.model.toFixed(1)}%`, color: SERIES[0] },
                        { label: 'Base rate', value: `${d.base.toFixed(1)}%`, color: UI.mute },
                      ]}
                    />
                  );
                }}
              />
              <ReferenceLine x={hist.find((h) => h.mid > 0)?.label} stroke={UI.line} />
              <Bar dataKey="model" fill={SERIES[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="base" fill={UI.mute} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-mute">
          Share of outcomes per return bucket (x-axis: bucket start). Where the blue bars stand taller than the grey ones, today's readings shift the odds away from BTC's usual behaviour.
        </p>
      </Card>
    </div>
  );
}
