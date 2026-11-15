import { CHANNEL_IDS, type ChannelId, type NotificationDelivery, type NotificationMessage } from '@smart-btc/shared';
import type { SettingsService } from '../settings.js';
import type { Store } from '../store/store.js';
import { CHANNELS, type Http } from './channels.js';

/** The same alert is not sent again within this time. */
const COOLDOWN_MS = 30 * 60_000;

/**
 * The one place messages leave from. Whatever raises an alert hands a message to `notify`; this
 * decides which channels are switched on, delivers to each, and logs every attempt. Callers never
 * know which channels exist.
 */
export class Notifier {
  private lastSent = new Map<string, number>();

  constructor(
    private settings: SettingsService,
    private store: Store,
    private http: Http = fetch as unknown as Http,
    private log: (msg: string) => void = () => {},
  ) {}

  /**
   * Sends to every enabled channel, or to `only` whether enabled or not (the "send test" button).
   * Never throws: a failed delivery is a logged result, not an error for the caller.
   */
  async notify(message: NotificationMessage, only?: ChannelId): Promise<NotificationDelivery[]> {
    const now = Date.now();
    if (message.dedupeKey) {
      const last = this.lastSent.get(message.dedupeKey);
      if (last != null && now - last < COOLDOWN_MS) return [];
      this.lastSent.set(message.dedupeKey, now);
    }
    const settings = await this.settings.get();
    const targets = only ? [only] : CHANNEL_IDS.filter((id) => CHANNELS[id].config(settings).enabled);
    const deliveries = await Promise.all(
      targets.map(async (id): Promise<NotificationDelivery> => {
        const channel = CHANNELS[id];
        const config = channel.config(settings);
        let error: string | null = null;
        const missing = channel.missing(config);
        if (missing.length) error = `Not configured: ${missing.join(', ')}`;
        else {
          try {
            await channel.send(config, message, this.http);
          } catch (err) {
            error = redact((err as Error).message || 'Delivery failed', config);
          }
        }
        return { at: Date.now(), channel: id, kind: message.kind, title: message.title, ok: error == null, error };
      }),
    );
    for (const d of deliveries) {
      if (!d.ok) this.log(`${d.channel}: ${d.error}`);
      await this.store.addNotification(d).catch(() => {});
    }
    return deliveries;
  }
}

/** Error texts can echo the request (Telegram puts the token in the URL); keep secrets out of logs. */
function redact(message: string, config: object): string {
  let out = message;
  for (const v of Object.values(config)) if (typeof v === 'string' && v.length >= 12) out = out.split(v).join('…');
  return out;
}
