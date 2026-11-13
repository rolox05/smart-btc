import { TF_INFO, durationLabel, type TradeOutcome, type TradeSetupResult } from '@smart-btc/shared';
import clsx from 'clsx';
import { fmtBars, fmtPct, fmtPctAuto, fmtProb, fmtUsd } from '../lib/format';
import { UI, diverging } from '../lib/palette';
import type { TradeForm } from '../lib/state';
import { Async, Card, Note, NumberField, Stat, Td, Th } from './ui';

const fmtR = (r: number) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;

function OutcomeBar({ o }: { o: TradeOutcome }) {
  const parts = [
    { key: 'take', label: 'Take-profit first', p: o.pTake, color: UI.up },
    { key: 'none', label: 'Neither (closed at horizon)', p: o.pTimeout, color: UI.mute },
    { key: 'stop', label: 'Stop-loss first', p: o.pStop, color: UI.down },
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
  const set = <K extends keyof TradeForm>(k: K, v: TradeForm[K]) => onChange({ ...form, [k]: v });

  return (
    <div className="flex flex-col gap-3">
      <Card title="Bracket to evaluate">
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
              {side}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <NumberField label="Stop-loss" value={form.stopPct} min={0.05} max={50} step={form.stopPct < 2 ? 0.1 : 0.5} suffix="%" onChange={(v) => set('stopPct', v)} />
          <NumberField label="Take-profit" value={form.takePct} min={0.05} max={200} step={form.takePct < 2 ? 0.1 : 0.5} suffix="%" onChange={(v) => set('takePct', v)} />
          <NumberField label="Leverage" value={form.leverage} min={1} max={125} step={1} suffix="×" onChange={(v) => set('leverage', v)} />
          <NumberField label="Account" value={form.accountUsd} min={1} step={500} suffix="$" onChange={(v) => set('accountUsd', v)} />
          <NumberField label="Risk per trade" value={form.riskPct} min={0.05} max={100} step={0.25} suffix="%" onChange={(v) => set('riskPct', v)} hint="Share of the account you lose if the stop is hit." />
          <NumberField label="Taker fee / side" value={form.feeBps} min={0} max={50} step={0.5} suffix="bps" onChange={(v) => set('feeBps', v)} />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          Entry is the current price ({fmtUsd(price)}). The bracket is replayed over the same modelled paths as the forecast, for the selected horizon.
        </p>
      </Card>

      <Async query={query} loadingLabel="Replaying the bracket over historical paths…">
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

              <Card title={`What happened to this ${r.side} within ${durationLabel(r.timeframe, r.horizon)}`}>
                <OutcomeBar o={r.model} />
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Expected value" value={fmtR(r.model.evR)} sub="per trade, after costs" tone={r.model.evR > 0 ? 'up' : 'down'} />
                  <Stat label="Break-even win rate" value={fmtProb(r.breakevenWinRate)} sub={`reward : risk ${r.rewardRisk.toFixed(2)}`} />
                  <Stat label="vs base rate" value={`${edge >= 0 ? '+' : ''}${edge.toFixed(0)} pts`} sub={`TP first: ${fmtProb(r.base.pTake)} usually`} />
                  <Stat label="Same bracket, other side" value={fmtR(r.opposite.evR)} sub={`TP first ${fmtProb(r.opposite.pTake)}`} />
                </div>
                <dl className="num mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <dt className="text-mute">Typical time to take-profit</dt>
                  <dd className="text-right text-ink2">{fmtBars(r.timeframe, r.model.daysToTake)}</dd>
                  <dt className="text-mute">Typical time to stop-loss</dt>
                  <dd className="text-right text-ink2">{fmtBars(r.timeframe, r.model.daysToStop)}</dd>
                  <dt className="text-mute">If neither hits: average result</dt>
                  <dd className="text-right text-ink2">{fmtPct(r.model.avgTimeoutPct)}</dd>
                  <dt className="text-mute">Costs: fees round trip · funding per day</dt>
                  <dd className="text-right text-ink2">
                    {r.costPct.toFixed(2)}% · {fmtPct(r.fundingPctPerDay, 3)}
                  </dd>
                </dl>
                <p className="mt-2 text-[11px] leading-relaxed text-mute">
                  1R = the amount risked. When the stop and the target trade inside the same bar the stop is assumed to hit first. Effective sample ≈ {Math.round(r.effectiveN)} analogs, so read these as rough odds, not precise ones.
                </p>
              </Card>

              <Card title="Levels and position size">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Entry" value={fmtUsd(r.entry)} />
                  <Stat label="Stop-loss" value={fmtUsd(r.stopPrice)} sub={`−${form.stopPct}%`} tone="down" />
                  <Stat label="Take-profit" value={fmtUsd(r.takePrice)} sub={`+${form.takePct}%`} tone="up" />
                  <Stat label={`Liquidation at ${form.leverage}×`} value={fmtUsd(r.liquidationPrice)} sub={`max safe ${r.maxSafeLeverage}×`} />
                  <Stat label="Position size" value={fmtUsd(r.positionNotionalUsd)} sub={`${r.positionBtc.toFixed(4)} BTC`} />
                  <Stat label="Margin posted" value={fmtUsd(r.marginUsd)} sub={`${((r.marginUsd / form.accountUsd) * 100).toFixed(0)}% of account`} />
                  <Stat label="Loss at stop" value={fmtUsd(r.riskUsd)} sub={`${form.riskPct}% of account`} tone="down" />
                  <Stat label="Gain at target" value={fmtUsd(r.rewardUsd)} sub={`${(form.riskPct * r.rewardRisk).toFixed(2)}% of account`} tone="up" />
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-mute">
                  Size is set so the stop costs exactly your chosen risk. Leverage then only changes how much margin you post and where liquidation sits: it must stay beyond the stop. Average range of one {TF_INFO[r.timeframe].label} bar (ATR) is currently {r.atrPct.toFixed(1)}%.
                </p>
              </Card>

              <Card title={`Other brackets for a ${r.side} (expected value in R)`}>
                <div className="thin-scroll overflow-x-auto">
                  <table className="w-full border-separate border-spacing-0.5">
                    <thead>
                      <tr>
                        <Th>Stop ↓ / Target →</Th>
                        {[...new Set(r.grid.map((g) => g.takePct))].map((t) => (
                          <Th key={t} right>+{fmtPctAuto(t)}</Th>
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
                                title={`Stop −${fmtPctAuto(g.stopPct)} / target +${fmtPctAuto(g.takePct)}: target first ${fmtProb(g.pTake)}, stop first ${fmtProb(g.pStop)}. Click to load.`}
                                onClick={() => onChange({ ...form, stopPct: g.stopPct, takePct: g.takePct })}
                              >
                                {fmtR(g.evR)}
                                <div className="text-[10px] text-ink/70">{fmtProb(g.pTake)} win</div>
                              </td>
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-mute">
                  Blue = positive expected value in the modelled sample, red = negative. Picking the best cell after the fact overstates the edge: prefer brackets that stay blue across neighbouring cells. Click a cell to load it.
                </p>
              </Card>
            </>
          );
        }}
      </Async>

      <Note>
        This is a statistics tool, not financial advice. The odds describe how similar past situations played out; they do not know about news, and leverage can lose the full margin posted.
      </Note>
    </div>
  );
}
