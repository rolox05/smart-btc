import type { ModelOutlook, ModelsReport } from '@smart-btc/shared';
import clsx from 'clsx';
import { fmtPct, fmtProb, fmtUsd } from '../lib/format';
import { useT } from '../lib/i18n';
import { UI } from '../lib/palette';
import { Badge, Card, Note, Td, Th } from './ui';

const skillTone = (x: number) => (x > 0.02 ? 'good' : x < -0.02 ? 'crit' : 'neutral');
const fmtSkill = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

/** Rally / range / decline as one stacked bar. */
function ScenarioBar({ m }: { m: Pick<ModelOutlook, 'pRally' | 'pRange' | 'pDecline'> }) {
  const { t } = useT();
  const parts = [
    { key: 'rally', label: t('Rally'), p: m.pRally, color: UI.up },
    { key: 'range', label: t('Range'), p: m.pRange, color: UI.mute },
    { key: 'decline', label: t('Decline'), p: m.pDecline, color: UI.down },
  ];
  return (
    <div className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full" role="img" aria-label={parts.map((p) => `${p.label} ${fmtProb(p.p)}`).join(', ')}>
      {parts.map((p) => (
        <div key={p.key} title={`${p.label}: ${fmtProb(p.p)}`} style={{ width: `${p.p * 100}%`, background: p.color }} />
      ))}
    </div>
  );
}

function ModelRow({ m, price, highlight }: { m: ModelOutlook; price: number; highlight?: boolean }) {
  const { t } = useT();
  return (
    <div className={clsx('rounded-md border p-2.5', highlight ? 'border-accent/60 bg-raised' : 'border-line')}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-xs font-semibold text-ink">{m.name}</div>
        {m.available && m.skill && (
          <div className="flex items-center gap-1.5">
            <Badge tone={skillTone(m.skill.avg)} title={t('Walk-forward Brier skill against the base rate, averaged over up, rally and decline. Above 0 beats the base rate.')}>
              {t('odds {x}', { x: fmtSkill(m.skill.avg) })}
            </Badge>
            <Badge tone={skillTone(m.skill.quantile)} title={t('Walk-forward skill of the whole predicted range (pinball loss) against the base rate. The 80% band held {c} of outcomes.', { c: fmtProb(m.skill.coverage80) })}>
              {t('range {x}', { x: fmtSkill(m.skill.quantile) })}
            </Badge>
          </div>
        )}
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-mute">{m.description}</p>
      {m.available ? (
        <>
          <div className="mt-2">
            <ScenarioBar m={m} />
          </div>
          <div className="num mt-1.5 grid grid-cols-3 gap-2 text-[11px] text-ink2">
            <span>
              <span className="font-semibold text-up">{fmtProb(m.pRally)}</span> {t('Rally')}
            </span>
            <span className="text-center">
              <span className="font-semibold text-ink">{fmtProb(m.pRange)}</span> {t('Range')}
            </span>
            <span className="text-right">
              <span className="font-semibold text-down">{fmtProb(m.pDecline)}</span> {t('Decline')}
            </span>
          </div>
          <dl className="num mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[11px]">
            <dt className="text-mute">{t('Median outcome')}</dt>
            <dd className="text-right text-ink">
              {fmtUsd(price * (1 + m.q50 / 100))} <span className="text-mute">({fmtPct(m.q50)})</span>
            </dd>
            <dt className="text-mute">{t('80% of outcomes between')}</dt>
            <dd className="text-right text-ink2">
              {fmtPct(m.q10)} … {fmtPct(m.q90)}
            </dd>
            <dt className="text-mute">{t('Chance of ending higher')}</dt>
            <dd className="text-right text-ink2">{fmtProb(m.pUp)}</dd>
          </dl>
        </>
      ) : (
        <p className="mt-2 text-[11px] text-warn">{m.reason}</p>
      )}
    </div>
  );
}

/** The three forecasting models side by side, their consensus, and what drives the regression. */
export function ModelsPanel({ report }: { report: ModelsReport }) {
  const { t, dur } = useT();
  const horizon = dur(report.timeframe, report.horizon);
  const ensemble = report.models.find((m) => m.id === 'ensemble');
  const singles = report.models.filter((m) => m.id !== 'ensemble');
  const a = report.adjusted;
  const widened = report.overlay.spreadMultiplier > 1.001;
  const verdict =
    report.agreement === 'bullish'
      ? t('All models lean up over the next {dur}.', { dur: horizon })
      : report.agreement === 'bearish'
        ? t('All models lean down over the next {dur}.', { dur: horizon })
        : t('The models disagree on direction over the next {dur}: treat it as a coin flip and size for the range.', { dur: horizon });

  return (
    <div className="flex flex-col gap-3">
      <Card title={t('Consensus of the models · next {dur}', { dur: horizon })}>
        <p className="text-xs leading-relaxed text-ink">{verdict}</p>
        {ensemble?.available && (
          <>
            <div className="mt-2.5">
              <ScenarioBar m={a} />
            </div>
            <div className="num mt-1.5 grid grid-cols-3 gap-2 text-[11px] text-ink2">
              <span>
                <span className="text-sm font-semibold text-up">{fmtProb(a.pRally)}</span> {t('Rally')} ≥ +{report.thresholdPct}%
              </span>
              <span className="text-center">
                <span className="text-sm font-semibold text-ink">{fmtProb(a.pRange)}</span> {t('Range')}
              </span>
              <span className="text-right">
                <span className="text-sm font-semibold text-down">{fmtProb(a.pDecline)}</span> {t('Decline')} ≤ −{report.thresholdPct}%
              </span>
            </div>
            <dl className="num mt-2.5 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-mute">{t('Median outcome')}</dt>
              <dd className="text-right text-ink">
                {fmtUsd(report.price * (1 + a.q50 / 100))} <span className="text-mute">({fmtPct(a.q50)})</span>
              </dd>
              <dt className="text-mute">{t('Half of outcomes between')}</dt>
              <dd className="text-right text-ink2">
                {fmtUsd(report.price * (1 + a.q25 / 100))} … {fmtUsd(report.price * (1 + a.q75 / 100))}
              </dd>
              <dt className="text-mute">{t('80% of outcomes between')}</dt>
              <dd className="text-right text-ink2">
                {fmtUsd(report.price * (1 + a.q10 / 100))} … {fmtUsd(report.price * (1 + a.q90 / 100))}
              </dd>
            </dl>
            <p className="mt-2 text-[11px] leading-relaxed text-mute">
              {widened
                ? t('Range widened by {pct}% for {n} scheduled events inside the horizon (see the Events tab).', { pct: Math.round((report.overlay.spreadMultiplier - 1) * 100), n: report.overlay.events.length })
                : report.overlay.events.length
                  ? t('{n} scheduled events fall inside the horizon; on past ones Bitcoin moved about as much as on ordinary days, so the range is not widened.', { n: report.overlay.events.length })
                  : t('No scheduled Fed, inflation or options-expiry event falls inside the horizon.')}
            </p>
          </>
        )}
      </Card>

      <Card title={t('Each model on its own')}>
        <div className="flex flex-col gap-2">
          {singles.map((m) => (
            <ModelRow key={m.id} m={m} price={report.price} />
          ))}
          {ensemble && <ModelRow m={ensemble} price={report.price} highlight />}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-mute">
          {t('Badges are each model\'s record on {n} past dates, tested with only the data available on each date. "Odds" scores the rally, decline and direction probabilities; "range" scores the whole predicted band.', { n: report.evaluations })}
        </p>
      </Card>

      {report.weights.length > 0 && (
        <Card title={t('What the quantile regression is weighing')}>
          <div className="thin-scroll overflow-x-auto">
            <table className="w-full min-w-[420px]">
              <thead>
                <tr>
                  <Th>{t('Input')}</Th>
                  <Th right title={t('Current reading in standard deviations from its own history')}>{t('Now')}</Th>
                  <Th right title={t('Effect of the current reading on the median forecast, in % of price')}>{t('Pushes median')}</Th>
                  <Th right title={t('Effect of one standard deviation of the input on the low (10%), middle and high (90%) end of the forecast')}>{t('Low · mid · high per 1σ')}</Th>
                </tr>
              </thead>
              <tbody>
                {report.weights.map((w) => (
                  <tr key={w.id} className="border-t border-line">
                    <Td className="text-ink2">{w.name}</Td>
                    <Td right className="text-ink2">{w.z == null ? '–' : `${w.z >= 0 ? '+' : ''}${w.z.toFixed(1)}σ`}</Td>
                    <Td right className={clsx('font-medium', w.contribution > 0.05 ? 'text-up' : w.contribution < -0.05 ? 'text-down' : 'text-mute')}>{fmtPct(w.contribution)}</Td>
                    <Td right className="text-mute">
                      {fmtPct(w.low)} · {fmtPct(w.median)} · {fmtPct(w.high)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-mute">
            {t('Sorted by how much each input moves the median right now. An input that lowers the low end and lifts the high end widens the range rather than picking a direction. The weights are refitted on all closed history and shrunk hard toward zero, because lightly shrunk fits were overconfident when tested.')}
          </p>
        </Card>
      )}

      {report.notes.map((n) => (
        <Note key={n}>{n}</Note>
      ))}
    </div>
  );
}
