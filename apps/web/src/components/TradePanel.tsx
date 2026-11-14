import { TF_INFO, type TradeOutcome, type TradeSetupResult } from '@smart-btc/shared';
import clsx from 'clsx';
import { fmtBars, fmtPct, fmtPctAuto, fmtProb, fmtUsd } from '../lib/format';
import { useT } from '../lib/i18n';
import { UI, diverging } from '../lib/palette';
import type { TradeForm } from '../lib/state';
import { Async, Card, Note, NumberField, Stat, Td, Th } from './ui';

const fmtR = (r: number) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;

function OutcomeBar({ o }: { o: TradeOutcome }) {
  const { t } = useT();
  const parts = [
    { key: 'take', label: t('Take-profit first'), p: o.pTake, color: UI.up },
    { key: 'none', label: t('Neither (closed at horizon)'), p: o.pTimeout, color: UI.mute },
    { key: 'stop', label: t('Stop-loss first'), p: o.pStop, color: UI.down },
  ];
  return (
    <div>
      <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
        {parts.map((p) => (
          <div key={p.key} title={`${p.label}: ${fmtProb(p.p)}`} style={{ width: `${p.p * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="num mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
        {parts.map((p) => (
          <div key={p.key} className="flex items-start gap-1.5">
            <span className="mt-1 h-2 w-2 shrink-0 rounded-sm" style={{ background: p.color }} />
            <span className="text-ink2">
              <span className="font-semibold text-ink">{fmtProb(p.p)}</span> {p.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TradePanel({
  form,
  onChange,
  query,
  price,
}: {
  form: TradeForm;
  onChange: (f: TradeForm) => void;
  query: { data: TradeSetupResult | undefined; error: Error | null; isPending: boolean };
  price: number;
}) {
  const { t, dur } = useT();
  const set = <K extends keyof TradeForm>(k: K, v: TradeForm[K]) => onChange({ ...form, [k]: v });

  return (
    <div className="flex flex-col gap-3">
      <Card title={t('Bracket to evaluate')}>
        <div className="mb-2.5 grid grid-cols-2 gap-1 rounded-md border border-line bg-bg p-0.5">
          {(['long', 'short'] as const).map((side) => (
            <button
              key={side}
              onClick={() => set('side', side)}
              aria-pressed={form.side === side}
              className={clsx(
                'rounded py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors',
                form.side === side ? (side === 'long' ? 'bg-up/20 text-up' : 'bg-down/20 text-down') : 'text-mute hover:text-ink2',
              )}
            >
              {t(side)}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <NumberField label={t('Stop-loss')} value={form.stopPct} min={0.05} max={50} step={form.stopPct < 2 ? 0.1 : 0.5} suffix="%" onChange={(v) => set('stopPct', v)} />
          <NumberField label={t('Take-profit')} value={form.takePct} min={0.05} max={200} step={form.takePct < 2 ? 0.1 : 0.5} suffix="%" onChange={(v) => set('takePct', v)} />
          <NumberField label={t('Leverage')} value={form.leverage} min={1} max={125} step={1} suffix="×" onChange={(v) => set('leverage', v)} />
          <NumberField label={t('Account')} value={form.accountUsd} min={1} step={500} suffix="$" onChange={(v) => set('accountUsd', v)} />
          <NumberField label={t('Risk per trade')} value={form.riskPct} min={0.05} max={100} step={0.25} suffix="%" onChange={(v) => set('riskPct', v)} hint={t('Share of the account you lose if the stop is hit.')} />
          <NumberField label={t('Taker fee / side')} value={form.feeBps} min={0} max={50} step={0.5} suffix="bps" onChange={(v) => set('feeBps', v)} />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          {t('Entry is the current price ({price}). The bracket is replayed over the same modelled paths as the forecast, for the selected horizon.', { price: fmtUsd(price) })}
        </p>
      </Card>

      <Async query={query} loadingLabel={t('Replaying the bracket over historical paths…')}>
        {(r) => {
          const edge = (r.model.pTake - r.base.pTake) * 100;
          return (
            <>
              {r.warnings.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {r.warnings.map((w) => (
                    <Note key={w} tone="warn">{w}</Note>
                  ))}
                </div>
              )}

              <Card title={t(r.side === 'long' ? 'What happened to this long within {dur}' : 'What happened to this short within {dur}', { dur: dur(r.timeframe, r.horizon) })}>
                <OutcomeBar o={r.model} />
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label={t('Expected value')} value={fmtR(r.model.evR)} sub={t('per trade, after costs')} tone={r.model.evR > 0 ? 'up' : 'down'} />
                  <Stat label={t('Break-even win rate')} value={fmtProb(r.breakevenWinRate)} sub={t('reward : risk {x}', { x: r.rewardRisk.toFixed(2) })} />
                  <Stat label={t('vs base rate')} value={t('{x} pts', { x: `${edge >= 0 ? '+' : ''}${edge.toFixed(0)}` })} sub={t('TP first: {p} usually', { p: fmtProb(r.base.pTake) })} />
                  <Stat label={t('Same bracket, other side')} value={fmtR(r.opposite.evR)} sub={t('TP first {p}', { p: fmtProb(r.opposite.pTake) })} />
                </div>
                <dl className="num mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-mute">{t('Typical time to take-profit')}</dt>
                  <dd className="text-right text-ink2">{fmtBars(r.timeframe, r.model.daysToTake)}</dd>
                  <dt className="text-mute">{t('Typical time to stop-loss')}</dt>
                  <dd className="text-right text-ink2">{fmtBars(r.timeframe, r.model.daysToStop)}</dd>
                  <dt className="text-mute">{t('If neither hits: average result')}</dt>
                  <dd className="text-right text-ink2">{fmtPct(r.model.avgTimeoutPct)}</dd>
                  <dt className="text-mute">{t('Costs: fees round trip · funding per day')}</dt>
                  <dd className="text-right text-ink2">
                    {r.costPct.toFixed(2)}% · {fmtPct(r.fundingPctPerDay, 3)}
                  </dd>
                </dl>
                <p className="mt-2 text-[11px] leading-relaxed text-mute">
                  {t('1R = the amount risked. When the stop and the target trade inside the same bar the stop is assumed to hit first. Effective sample ≈ {n} analogs, so read these as rough odds, not precise ones.', { n: Math.round(r.effectiveN) })}
                </p>
              </Card>

              <Card title={t('Levels and position size')}>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label={t('Entry')} value={fmtUsd(r.entry)} />
                  <Stat label={t('Stop-loss')} value={fmtUsd(r.stopPrice)} sub={`−${form.stopPct}%`} tone="down" />
                  <Stat label={t('Take-profit')} value={fmtUsd(r.takePrice)} sub={`+${form.takePct}%`} tone="up" />
                  <Stat label={t('Liquidation at {lev}×', { lev: form.leverage })} value={fmtUsd(r.liquidationPrice)} sub={t('max safe {lev}×', { lev: r.maxSafeLeverage })} />
                  <Stat label={t('Position size')} value={fmtUsd(r.positionNotionalUsd)} sub={`${r.positionBtc.toFixed(4)} BTC`} />
                  <Stat label={t('Margin posted')} value={fmtUsd(r.marginUsd)} sub={t('{pct}% of account', { pct: ((r.marginUsd / form.accountUsd) * 100).toFixed(0) })} />
                  <Stat label={t('Loss at stop')} value={fmtUsd(r.riskUsd)} sub={t('{pct}% of account', { pct: form.riskPct })} tone="down" />
                  <Stat label={t('Gain at target')} value={fmtUsd(r.rewardUsd)} sub={t('{pct}% of account', { pct: (form.riskPct * r.rewardRisk).toFixed(2) })} tone="up" />
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-mute">
                  {t('Size is set so the stop costs exactly your chosen risk. Leverage then only changes how much margin you post and where liquidation sits: it must stay beyond the stop. Average range of one {tf} bar (ATR) is currently {atr}%.', { tf: TF_INFO[r.timeframe].label, atr: r.atrPct.toFixed(1) })}
                </p>
              </Card>

              <Card title={t(r.side === 'long' ? 'Other brackets for a long (expected value in R)' : 'Other brackets for a short (expected value in R)')}>
                <div className="thin-scroll overflow-x-auto">
                  <table className="w-full border-separate border-spacing-0.5">
                    <thead>
                      <tr>
                        <Th>{t('Stop ↓ / Target →')}</Th>
                        {[...new Set(r.grid.map((g) => g.takePct))].map((tp) => (
                          <Th key={tp} right>+{fmtPctAuto(tp)}</Th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...new Set(r.grid.map((g) => g.stopPct))].map((s) => (
                        <tr key={s}>
                          <Td className="text-ink2">−{fmtPctAuto(s)}</Td>
                          {r.grid
                            .filter((g) => g.stopPct === s)
                            .map((g) => (
                              <td
                                key={g.takePct}
                                className="num cursor-pointer rounded px-1.5 py-1 text-right text-xs text-ink hover:outline hover:outline-1 hover:outline-ink2"
                                style={{ background: diverging(g.evR, 0.6) }}
                                title={t('Stop −{stop} / target +{take}: target first {pt}, stop first {ps}. Click to load.', { stop: fmtPctAuto(g.stopPct), take: fmtPctAuto(g.takePct), pt: fmtProb(g.pTake), ps: fmtProb(g.pStop) })}
                                onClick={() => onChange({ ...form, stopPct: g.stopPct, takePct: g.takePct })}
                              >
                                {fmtR(g.evR)}
                                <div className="text-[10px] text-ink/70">{t('{p} win', { p: fmtProb(g.pTake) })}</div>
                              </td>
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-mute">
                  {t('Blue = positive expected value in the modelled sample, red = negative. Picking the best cell after the fact overstates the edge: prefer brackets that stay blue across neighbouring cells. Click a cell to load it.')}
                </p>
              </Card>
            </>
          );
        }}
      </Async>

      <Note>
        {t('This is a statistics tool, not financial advice. The odds describe how similar past situations played out; they do not know about news, and leverage can lose the full margin posted.')}
      </Note>
    </div>
  );
}
