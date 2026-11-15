import type { AlertInput, AlertRule, ForecastSettings } from '@smart-btc/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useAlerts } from '../hooks/useData';
import { api } from '../lib/api';
import { fmtAgo, fmtCompactUsd, fmtUsd } from '../lib/format';
import { useT } from '../lib/i18n';
import { Async, Card, Note, NumberField, Segmented, Switch } from './ui';

type Kind = AlertRule['type'];

interface Props {
  forecastSettings: ForecastSettings;
  price: number;
  /** At least one notification channel is switched on and configured. */
  channelOn: boolean;
}

/** Rules that send a message when price, liquidations or the reading do something worth knowing. */
export function AlertsCard({ forecastSettings, price, channelOn }: Props) {
  const { t, dur } = useT();
  const qc = useQueryClient();
  const alerts = useAlerts();
  const [kind, setKind] = useState<Kind>('price');
  const [level, setLevel] = useState(() => Math.round(price / 500) * 500);
  const [repeat, setRepeat] = useState(false);
  const [side, setSide] = useState<'any' | 'long' | 'short'>('any');
  const [minM, setMinM] = useState(20);
  const [windowMin, setWindowMin] = useState(15);
  const h = dur(forecastSettings.timeframe, forecastSettings.horizon);

  const refresh = () => qc.invalidateQueries({ queryKey: ['alerts'] });
  const create = useMutation({ mutationFn: api.createAlert, onSuccess: refresh });
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.setAlertEnabled(id, enabled), onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteAlert, onSuccess: refresh });
  const error = create.error ?? toggle.error ?? remove.error;

  const input = (): AlertInput =>
    kind === 'price'
      ? { type: 'price', direction: level >= price ? 'above' : 'below', price: level, once: !repeat }
      : kind === 'liquidations'
        ? { type: 'liquidations', side, minUsd: minM * 1e6, windowMin, once: false }
        : { type: 'reading', settings: forecastSettings, once: false };

  const describe = (r: AlertRule) =>
    r.type === 'price'
      ? t(r.direction === 'above' ? 'Price crosses above {price}' : 'Price crosses below {price}', { price: fmtUsd(r.price) })
      : r.type === 'liquidations'
        ? t(r.side === 'long' ? '{usd} of longs liquidated within {n} min' : r.side === 'short' ? '{usd} of shorts liquidated within {n} min' : '{usd} liquidated within {n} min', { usd: fmtCompactUsd(r.minUsd), n: r.windowMin })
        : t('The Today reading for the next {h} changes', { h: dur(r.settings.timeframe, r.settings.horizon) });

  return (
    <Card title={t('Alerts')}>
      {!channelOn && (
        <div className="mb-2.5">
          <Note tone="warn">{t('No notification channel is switched on yet, so alerts will only show inside the app while it is open. Connect Telegram or WhatsApp below.')}</Note>
        </div>
      )}
      <Async query={alerts} loadingLabel={t('Loading alerts…')}>
        {(rules) =>
          rules.length === 0 ? (
            <p className="text-[11.5px] text-mute">{t('No alerts yet. Add one below.')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {rules.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-1.5">
                  <div className="min-w-0">
                    <div className={`truncate text-xs ${r.enabled ? 'text-ink' : 'text-mute'}`}>{describe(r)}</div>
                    <div className="text-[10.5px] text-mute">
                      {t(r.once ? 'Once' : 'Every time')}
                      {r.lastFiredAt ? ` · ${t('last sent {ago}', { ago: fmtAgo(r.lastFiredAt) })}` : ''}
                      {!r.enabled && r.once && r.lastFiredAt ? ` · ${t('done')}` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Switch checked={r.enabled} onChange={(enabled) => toggle.mutate({ id: r.id, enabled })} label="" />
                    <button onClick={() => remove.mutate(r.id)} aria-label={t('Delete alert')} title={t('Delete alert')} className="rounded p-1 text-mute hover:bg-raised hover:text-[#f08a8a]">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Async>

      <div className="mt-3 border-t border-line pt-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-mute">{t('New alert')}</span>
          <Segmented
            label={t('Alert type')}
            size="sm"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'price', label: t('Price') },
              { value: 'liquidations', label: t('Liquidations') },
              { value: 'reading', label: t('Reading') },
            ]}
          />
        </div>

        {kind === 'price' && (
          <div className="mt-2">
            <div className="grid grid-cols-2 gap-2.5">
              <NumberField label={t('Price level')} value={level} min={1} max={10_000_000} step={100} suffix="$" onChange={setLevel} hint={t('Now {price}. A level above it alerts on the way up, a level below on the way down.', { price: fmtUsd(price) })} />
              <div className="self-end pb-1"><Switch checked={repeat} onChange={setRepeat} label={t('Repeat every time')} /></div>
            </div>
            <p className="mt-1 text-[10.5px] leading-snug text-mute">{t('Fires when price trades through the level, checked about once per second on Binance spot.')}</p>
          </div>
        )}
        {kind === 'liquidations' && (
          <div className="mt-2">
            <div className="grid grid-cols-2 gap-2.5">
              <NumberField label={t('At least')} value={minM} min={0.1} max={10_000} step={5} suffix={t('$ million')} onChange={setMinM} hint={t('Total size of forced liquidations.')} />
              <NumberField label={t('Within')} value={windowMin} min={1} max={240} step={5} suffix={t('min')} onChange={(v) => setWindowMin(Math.round(v))} hint={t('Rolling time window.')} />
            </div>
            <div className="mt-2">
              <Segmented
                label={t('Side')}
                size="sm"
                value={side}
                onChange={setSide}
                options={[
                  { value: 'any', label: t('Both sides') },
                  { value: 'long', label: t('Longs') },
                  { value: 'short', label: t('Shorts') },
                ]}
              />
            </div>
            <p className="mt-1 text-[10.5px] leading-snug text-mute">{t('Counts the prints Binance and Bybit publish, which are a sample: real totals are higher. At most one message per window.')}</p>
          </div>
        )}
        {kind === 'reading' && (
          <p className="mt-2 text-[11.5px] leading-relaxed text-ink2">
            {t('Sends a message when the Today reading for the next {h} changes its lean (up, down, none) or its edge (none, weak, clear). It uses the timeframe, horizon and model inputs selected right now and is checked when a bar closes.', { h })}
          </p>
        )}

        <button
          onClick={() => create.mutate(input())}
          disabled={create.isPending || (kind === 'price' && !(level > 0))}
          className="mt-2.5 flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-raised disabled:opacity-40"
        >
          <Plus size={12} /> {t('Add alert')}
        </button>
        {error && <div className="mt-2"><Note tone="error">{error.message}</Note></div>}
      </div>
    </Card>
  );
}
