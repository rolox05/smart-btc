import type { ForecastResult } from '@smart-btc/shared';
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import clsx from 'clsx';
import { fmtBars, fmtPct, fmtPctAuto, fmtProb, fmtUsd } from '../lib/format';
import { useT } from '../lib/i18n';
import { SERIES, UI } from '../lib/palette';
import { Card, ChartTip, Legend, ProbBar, Td, Th } from './ui';

/** Probability of reaching ±X% at any point inside the horizon, plus the outcome distribution. */
export function OddsPanel({ forecast }: { forecast: ForecastResult }) {
  const { t, dur: durOf } = useT();
  const tf = forecast.settings.timeframe;
  const dur = durOf(tf, forecast.settings.horizon);
  const hist = forecast.histogram.map((b) => ({
    label: `${b.from}`,
    range: t('{from} to {to}', { from: fmtPctAuto(b.from, true), to: fmtPctAuto(b.to, true) }),
    mid: (b.from + b.to) / 2,
    model: b.model * 100,
    base: b.base * 100,
  }));

  // The furthest level on each side that is more likely than not to trade at some point.
  const likely = (side: 'up' | 'down') => [...forecast.touch].reverse().find((x) => x[side] >= 0.5);
  const up = likely('up');
  const down = likely('down');
  const strong = (p: number) => clsx('text-right leading-tight', p >= 0.5 ? 'font-semibold text-ink' : p < 0.2 ? 'text-mute' : 'text-ink2');

  return (
    <div className="flex flex-col gap-3">
      <Card title={t('Odds of touching a level within {dur}', { dur })}>
        <p className="mb-2 text-[12.5px] leading-relaxed text-ink">
          {up || down
            ? t('Levels more likely than not to trade within {dur}: {up} and {down}.', {
                dur,
                up: up ? t('{pct} above ({price}, {p})', { pct: fmtPctAuto(up.pct), price: fmtUsd(up.upPrice), p: fmtProb(up.up) }) : t('nothing above'),
                down: down ? t('{pct} below ({price}, {p})', { pct: fmtPctAuto(down.pct), price: fmtUsd(down.downPrice), p: fmtProb(down.down) }) : t('nothing below'),
              })
            : t('No level in this table is more likely than not to be touched within {dur}.', { dur })}
        </p>
        <div className="thin-scroll overflow-x-auto">
          <table className="w-full min-w-[320px]">
            <thead>
              <tr>
                <Th>{t('Move')}</Th>
                <Th>{t('Up')}</Th>
                <Th>{t('Down')}</Th>
                <Th right title={t('Of the paths that touched either level, the share that hit the upside one first')}>{t('Up first')}</Th>
              </tr>
            </thead>
            <tbody>
              {forecast.touch.map((x) => (
                <tr key={x.pct} className="border-t border-line align-middle">
                  <Td className="font-medium text-ink">±{fmtPctAuto(x.pct)}</Td>
                  {(['up', 'down'] as const).map((side) => (
                    <Td key={side}>
                      <div className="flex items-center gap-1.5">
                        <div className="w-[3.75rem] leading-tight" title={t('Median time until the level was first touched, when it was touched')}>
                          <div className="text-ink2">{fmtUsd(side === 'up' ? x.upPrice : x.downPrice)}</div>
                          <div className="text-[10px] text-mute">{fmtBars(tf, side === 'up' ? x.upDays : x.downDays)}</div>
                        </div>
                        <div className="w-11">
                          <div className={strong(x[side])}>{fmtProb(x[side])}</div>
                          <ProbBar value={x[side]} base={side === 'up' ? x.baseUp : x.baseDown} color={side === 'up' ? UI.up : UI.down} />
                        </div>
                      </div>
                    </Td>
                  ))}
                  <Td right className="text-ink2">{fmtProb(x.upFirst)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          {t('"Touch" means a bar\'s high (or low) reached the level at least once: the question that matters for a take-profit or stop order. The small figure under each price is the median time it took to get there. White ticks mark the base rate. Both sides can be touched in the same window, so the two columns do not add up to 100%.')}
        </p>
      </Card>

      <Card title={t('Distribution of returns over {dur}', { dur })} right={<Legend items={[{ label: t('Model'), color: SERIES[0] }, { label: t('Base rate'), color: UI.mute }]} />}>
        <div className="num mb-2 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md bg-raised px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-mute">{t('Model')}</div>
            <div className="text-ink">{t('{p} end higher · median {m}', { p: fmtProb(forecast.terminal.probUp), m: fmtPct(forecast.terminal.p50) })}</div>
          </div>
          <div className="rounded-md bg-raised px-2 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-mute">{t('Usually')}</div>
            <div className="text-ink2">{t('{p} end higher · median {m}', { p: fmtProb(forecast.base.probUp), m: fmtPct(forecast.base.p50) })}</div>
          </div>
        </div>
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
                      title={t('Return {range}', { range: d.range })}
                      rows={[
                        { label: t('Model'), value: `${d.model.toFixed(1)}%`, color: SERIES[0] },
                        { label: t('Base rate'), value: `${d.base.toFixed(1)}%`, color: UI.mute },
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
          {t("Share of outcomes per return bucket (x-axis: bucket start). Where the blue bars stand taller than the grey ones, today's readings shift the odds away from BTC's usual behaviour.")}
        </p>
      </Card>
    </div>
  );
}
