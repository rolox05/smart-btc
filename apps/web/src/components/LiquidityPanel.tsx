import type { LiquidityLevel, LiquidityReport } from '@smart-btc/shared';
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtCompactUsd, fmtPct, fmtProb, fmtUsd } from '../lib/format';
import { SERIES, UI } from '../lib/palette';
import { Badge, Card, ChartTip, Legend, Note, Stat, Td, Th } from './ui';

const KIND_LABEL: Record<LiquidityLevel['kind'], string> = { swing: 'Stops', liquidation: 'Liquidations', orderbook: 'Order book' };

function LevelTable({ levels, empty }: { levels: LiquidityLevel[]; empty: string }) {
  if (!levels.length) return <p className="py-2 text-xs text-mute">{empty}</p>;
  return (
    <table className="w-full">
      <thead>
        <tr>
          <Th>Price</Th>
          <Th right>Away</Th>
          <Th>Type</Th>
          <Th>What sits there</Th>
          <Th right title="Relative size within its own type">Size</Th>
        </tr>
      </thead>
      <tbody>
        {levels.map((l, i) => (
          <tr key={`${l.kind}-${l.price}-${i}`} className="border-t border-line" title={l.detail}>
            <Td className="font-medium text-ink">{fmtUsd(l.price)}</Td>
            <Td right className={l.distancePct >= 0 ? 'text-up' : 'text-down'}>{fmtPct(l.distancePct)}</Td>
            <Td><Badge>{KIND_LABEL[l.kind]}</Badge></Td>
            <Td className="max-w-[9rem] truncate whitespace-normal text-ink2">
              {l.label}
              {l.notionalUsd != null ? ` · ${fmtCompactUsd(l.notionalUsd)}` : ''}
            </Td>
            <Td right>
              <div className="ml-auto h-1.5 w-12 rounded-full bg-raised">
                <div className="h-full rounded-full bg-ink2" style={{ width: `${Math.round(l.strength * 100)}%` }} />
              </div>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function LiquidityPanel({ report }: { report: LiquidityReport }) {
  const all = [...report.swings, ...report.liquidations, ...report.walls];
  const above = all.filter((l) => l.side === 'buy-side').sort((a, b) => a.distancePct - b.distancePct).slice(0, 12);
  const below = all.filter((l) => l.side === 'sell-side').sort((a, b) => b.distancePct - a.distancePct).slice(0, 12);
  const s = report.summary;

  // Re-bucket the liquidation estimate to 1% steps for a readable profile.
  const liq = new Map<number, { d: number; long: number; short: number }>();
  for (const b of report.liqProfile) {
    const d = Math.floor(b.distancePct);
    const cur = liq.get(d) ?? { d, long: 0, short: 0 };
    cur.long += b.longUsd / 1e6;
    cur.short += b.shortUsd / 1e6;
    liq.set(d, cur);
  }
  const liqData = [...liq.values()].filter((x) => Math.abs(x.d + 0.5) <= 20).sort((a, b) => a.d - b.d);

  const depth = new Map<number, { d: number; bid: number; ask: number }>();
  for (const b of report.depth) {
    const d = Math.floor(b.distancePct * 2) / 2;
    const cur = depth.get(d) ?? { d, bid: 0, ask: 0 };
    cur.bid += b.bidUsd / 1e6;
    cur.ask += b.askUsd / 1e6;
    depth.set(d, cur);
  }
  const depthData = [...depth.values()].filter((x) => Math.abs(x.d) <= 10).sort((a, b) => a.d - b.d);

  const axis = { tick: { fill: UI.mute, fontSize: 10 }, tickLine: false } as const;

  return (
    <div className="flex flex-col gap-3">
      <Card title="Liquidity at a glance" right={<span className="num text-[11px] text-mute">mid {fmtUsd(report.price)}</span>}>
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Nearest pool above"
            value={s.nearestAbove ? fmtUsd(s.nearestAbove.price) : '–'}
            sub={s.nearestAbove ? `${fmtPct(s.nearestAbove.distancePct)} · ${s.nearestAbove.label}` : 'none within range'}
          />
          <Stat
            label="Nearest pool below"
            value={s.nearestBelow ? fmtUsd(s.nearestBelow.price) : '–'}
            sub={s.nearestBelow ? `${fmtPct(s.nearestBelow.distancePct)} · ${s.nearestBelow.label}` : 'none within range'}
          />
          <Stat
            label="Order book within 2%"
            value={`${fmtCompactUsd(s.bidDepthUsd['2'])} / ${fmtCompactUsd(s.askDepthUsd['2'])}`}
            sub={s.bookImbalance2Pct != null ? `bids / asks · imbalance ${fmtPct(s.bookImbalance2Pct * 100, 0)}` : 'bids / asks'}
          />
          <Stat
            label="Est. liquidations within 15%"
            value={s.liqSkewAbove != null ? `${fmtProb(s.liqSkewAbove)} above` : '–'}
            sub={s.liqSkewAbove != null ? `${fmtProb(1 - s.liqSkewAbove)} below price` : 'estimate unavailable'}
          />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          Price tends to travel toward clusters of resting orders: stops above swing highs and short liquidations pull it up, stops below swing lows and long liquidations pull it down. Venues: {s.venues.join(', ') || 'none'}.
        </p>
      </Card>

      <Card title="Above price (buy-side liquidity)">
        <LevelTable levels={above} empty="No notable pools above price." />
      </Card>
      <Card title="Below price (sell-side liquidity)">
        <LevelTable levels={below} empty="No notable pools below price." />
      </Card>

      {liqData.length > 0 && (
        <Card title="Estimated liquidation profile" right={<Legend items={[{ label: 'Longs liquidated', color: SERIES[1] }, { label: 'Shorts liquidated', color: SERIES[0] }]} />}>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={liqData} margin={{ top: 6, right: 4, left: -14, bottom: 0 }} barCategoryGap="15%">
                <CartesianGrid stroke={UI.grid} vertical={false} />
                <XAxis dataKey="d" {...axis} axisLine={{ stroke: UI.line }} tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`} interval={4} />
                <YAxis {...axis} axisLine={false} tickFormatter={(v) => `$${v}M`} />
                <ReferenceLine x={0} stroke={UI.mute} strokeDasharray="3 3" />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as (typeof liqData)[number];
                    return (
                      <ChartTip
                        title={`${fmtPct(d.d, 0)} to ${fmtPct(d.d + 1, 0)} · ${fmtUsd(report.price * (1 + d.d / 100))}`}
                        rows={[
                          { label: 'Longs liquidated', value: `$${d.long.toFixed(1)}M`, color: SERIES[1] },
                          { label: 'Shorts liquidated', value: `$${d.short.toFixed(1)}M`, color: SERIES[0] },
                        ]}
                      />
                    );
                  }}
                />
                <Bar dataKey="long" stackId="a" fill={SERIES[1]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="short" stackId="a" fill={SERIES[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-mute">x: distance from the current price. Bars estimate the notional that would be force-closed if price reached that zone.</p>
        </Card>
      )}

      {depthData.length > 0 && (
        <Card title="Resting orders (combined spot books)" right={<Legend items={[{ label: 'Bids', color: SERIES[2] }, { label: 'Asks', color: SERIES[7] }]} />}>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={depthData} margin={{ top: 6, right: 4, left: -14, bottom: 0 }} barCategoryGap="15%">
                <CartesianGrid stroke={UI.grid} vertical={false} />
                <XAxis dataKey="d" {...axis} axisLine={{ stroke: UI.line }} tickFormatter={(v) => `${v > 0 ? '+' : ''}${v}%`} interval={7} />
                <YAxis {...axis} axisLine={false} tickFormatter={(v) => `$${v}M`} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as (typeof depthData)[number];
                    return (
                      <ChartTip
                        title={`${fmtPct(d.d)} to ${fmtPct(d.d + 0.5)} · ${fmtUsd(report.price * (1 + d.d / 100))}`}
                        rows={[
                          { label: 'Bids', value: `$${d.bid.toFixed(1)}M`, color: SERIES[2] },
                          { label: 'Asks', value: `$${d.ask.toFixed(1)}M`, color: SERIES[7] },
                        ]}
                      />
                    );
                  }}
                />
                <Bar dataKey="bid" stackId="a" fill={SERIES[2]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="ask" stackId="a" fill={SERIES[7]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <div className="flex flex-col gap-1.5">
        {s.notes.map((n) => (
          <Note key={n}>{n}</Note>
        ))}
        <Note>Liquidity has no free historical archive, so it is shown as context for targets and stops and is not an input of the forecast model.</Note>
      </div>
    </div>
  );
}
