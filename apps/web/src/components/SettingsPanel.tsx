import { LANGS, LANG_NAME, type ForecastSettings, type AppSettingsPatch, type AppSettingsView, type ChannelId, type Lang, type NotificationDelivery, type Overview, type SecretView } from '@smart-btc/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Send } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useNotificationLog, useSettings } from '../hooks/useData';
import { api } from '../lib/api';
import { fmtAgo } from '../lib/format';
import { msg, useT } from '../lib/i18n';
import type { Layers } from '../lib/state';
import { AlertsCard } from './AlertsCard';
import { DataPanel } from './DataPanel';
import { Async, Badge, Card, Note, Segmented, Switch } from './ui';

interface Props {
  overview: Overview;
  onRefresh: () => void;
  refreshing: boolean;
  lang: Lang;
  onLang: (l: Lang) => void;
  explain: boolean;
  onExplain: (v: boolean) => void;
  layers: Layers;
  onLayers: (l: Layers) => void;
  /** The forecast settings on screen, which a reading alert is created for. */
  forecastSettings: ForecastSettings;
  price: number;
}

interface FieldDef {
  key: string;
  label: string;
  hint: string;
  secret?: boolean;
  placeholder?: string;
}

/** What each channel needs. A new channel is one more entry here plus its sender on the server. */
const CHANNELS: { id: ChannelId; name: string; intro: string; fields: FieldDef[] }[] = [
  {
    id: 'telegram',
    name: 'Telegram',
    intro: msg('Create a bot with @BotFather, open a chat with it (or add it to a group) and send it any message. Then paste the bot token and the chat id here.'),
    fields: [
      { key: 'botToken', label: 'Bot token', hint: 'Given by @BotFather when the bot is created.', secret: true, placeholder: '123456:ABC…' },
      { key: 'chatId', label: 'Chat id', hint: 'Numeric id of the chat or group, or @channelname for a channel.', placeholder: '123456789' },
    ],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    intro: msg('Uses the WhatsApp Cloud API from Meta (a free developer app with a WhatsApp number). Free text only arrives within 24 hours of your last message to that number; for alerts at any time, create a message template with one variable and enter its name.'),
    fields: [
      { key: 'phoneNumberId', label: 'Phone number id', hint: 'Id of the sending number, shown in the WhatsApp section of the Meta app.', placeholder: '1098…' },
      { key: 'accessToken', label: 'Access token', hint: 'A permanent system-user token; the temporary one expires after a day.', secret: true, placeholder: 'EAAG…' },
      { key: 'to', label: 'Your number', hint: 'Where alerts are sent, with country code.', placeholder: '+54 9 11 …' },
      { key: 'template', label: 'Template name (optional)', hint: 'An approved template whose body is a single variable, e.g. "{{1}}".', placeholder: 'btc_alert' },
      { key: 'templateLang', label: 'Template language', hint: 'Language code the template was approved in.', placeholder: 'en' },
    ],
  },
];

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-ink2">{label}</span>
      {children}
      <span className="mt-0.5 block text-[10.5px] leading-snug text-mute">{hint}</span>
    </label>
  );
}

function ChannelForm({ def, saved }: { def: (typeof CHANNELS)[number]; saved: AppSettingsView['notifications'][ChannelId] }) {
  const { t } = useT();
  const qc = useQueryClient();
  // Only what the user typed since the last save; secrets are never sent back by the server.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [result, setResult] = useState<NotificationDelivery | null>(null);
  const values = saved as unknown as Record<string, string | boolean | SecretView>;
  const dirty = Object.keys(draft).length > 0;

  const save = useMutation({
    mutationFn: (patch: Record<string, string | boolean>) => api.saveSettings({ notifications: { [def.id]: patch } } as AppSettingsPatch),
    onSuccess: (view) => {
      qc.setQueryData(['settings'], view);
      setDraft({});
    },
  });
  const test = useMutation({
    mutationFn: async () => {
      if (dirty) await save.mutateAsync(draft);
      return api.testNotification(def.id);
    },
    onSuccess: setResult,
    onSettled: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const error = save.error ?? test.error;

  return (
    <div className="border-t border-line py-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink">{def.name}</span>
          <Badge tone={saved.ready ? (saved.enabled ? 'good' : 'neutral') : 'neutral'}>
            {t(!saved.ready ? 'Not set up' : saved.enabled ? 'On' : 'Off')}
          </Badge>
        </div>
        <div className="w-40">
          <Switch checked={saved.enabled} onChange={(enabled) => save.mutate({ ...draft, enabled })} label={t('Send alerts here')} />
        </div>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-mute">{t(def.intro)}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {def.fields.map((f) => {
          const current = values[f.key];
          const secret = f.secret ? (current as SecretView) : null;
          return (
            <Field key={f.key} label={t(f.label)} hint={t(f.hint)}>
              <input
                type={f.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={draft[f.key] ?? (secret ? '' : String(current ?? ''))}
                placeholder={secret?.set ? t('Saved ({hint}). Type to replace.', { hint: secret.hint || '•••' }) : f.placeholder}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                className="num mt-0.5 w-full rounded-md border border-line bg-bg px-2 py-1 text-xs text-ink placeholder:text-mute focus:border-accent focus:outline-none"
              />
            </Field>
          );
        })}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          onClick={() => save.mutate(draft)}
          disabled={!dirty || save.isPending}
          className="rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-raised disabled:opacity-40"
        >
          {t(save.isPending ? 'Saving…' : 'Save')}
        </button>
        <button
          onClick={() => test.mutate()}
          disabled={test.isPending || (!saved.ready && !dirty)}
          className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-raised disabled:opacity-40"
        >
          <Send size={12} /> {t(test.isPending ? 'Sending…' : 'Send a test message')}
        </button>
        {result && !test.isPending && (
          <span className={`flex items-center gap-1 text-[11px] ${result.ok ? 'text-[#5fd35f]' : 'text-[#f08a8a]'}`}>
            {result.ok ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
            {result.ok ? t('Delivered. Check {name}.', { name: def.name }) : result.error}
          </span>
        )}
      </div>
      {error && <div className="mt-2"><Note tone="error">{error.message}</Note></div>}
    </div>
  );
}

/** Preferences: where alerts go, how the interface behaves and where the data comes from. */
export function SettingsPanel({ overview, onRefresh, refreshing, lang, onLang, explain, onExplain, layers, onLayers, forecastSettings, price }: Props) {
  const { t } = useT();
  const settings = useSettings();
  const log = useNotificationLog();

  return (
    <div className="flex flex-col gap-3">
      <AlertsCard
        forecastSettings={forecastSettings}
        price={price}
        channelOn={settings.data ? Object.values(settings.data.notifications).some((c) => c.enabled && c.ready) : true}
      />
      <Card title={t('Notifications')}>
        <p className="mb-3 text-[11px] leading-relaxed text-mute">
          {t('Connect the channels alerts will be sent to. The messages leave from the server on this computer, so they keep arriving with the browser closed as long as the server runs. Use the test button to check each one.')}
        </p>
        <Async query={settings} loadingLabel={t('Loading settings…')}>
          {(view) => (
            <>
              {CHANNELS.map((def) => <ChannelForm key={def.id} def={def} saved={view.notifications[def.id]} />)}
            </>
          )}
        </Async>
        <p className="mt-1 border-t border-line pt-2 text-[10.5px] leading-relaxed text-mute">
          {t('Tokens are stored in the local database file (data/smart-btc.db) and are never shown again or sent anywhere except to the service they belong to.')}
        </p>
        {log.data && log.data.length > 0 && (
          <div className="mt-2 border-t border-line pt-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-mute">{t('Recent deliveries')}</div>
            <ul className="mt-1 space-y-0.5 text-[11px] text-ink2">
              {log.data.slice(0, 6).map((d, i) => (
                <li key={`${d.at}:${i}`} className="flex justify-between gap-2">
                  <span className="truncate">
                    <span className={d.ok ? 'text-[#5fd35f]' : 'text-[#f08a8a]'}>{d.ok ? '✓' : '✕'}</span> {d.channel} · {d.title}
                    {d.error ? <span className="text-mute"> · {d.error}</span> : null}
                  </span>
                  <span className="num shrink-0 text-mute">{fmtAgo(d.at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title={t('Preferences')}>
        <div className="flex items-center justify-between gap-3 py-1 text-xs text-ink2">
          <span>{t('Language')}</span>
          <Segmented label={t('Language')} size="sm" value={lang} onChange={onLang} options={LANGS.map((l) => ({ value: l, label: LANG_NAME[l] }))} />
        </div>
        <Switch checked={explain} onChange={onExplain} label={t('Explanations when hovering metrics and chart lines')} />
        <Switch checked={layers.levels} onChange={(levels) => onLayers({ ...layers, levels })} label={t('Key levels on the chart')} />
        <p className="mt-1 text-[10.5px] leading-relaxed text-mute">{t('These are kept in this browser. Notification settings are kept on the server.')}</p>
      </Card>

      <DataPanel overview={overview} onRefresh={onRefresh} refreshing={refreshing} />
    </div>
  );
}
