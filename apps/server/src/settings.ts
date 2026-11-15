import type { AppSettings, AppSettingsPatch, AppSettingsView, SecretView } from '@smart-btc/shared';
import { CHANNELS } from './notify/channels.js';
import type { Store } from './store/store.js';

const KEY = 'app';

export const DEFAULT_SETTINGS: AppSettings = {
  notifications: {
    telegram: { enabled: false, botToken: '', chatId: '' },
    whatsapp: { enabled: false, phoneNumberId: '', accessToken: '', to: '', template: '', templateLang: 'en' },
  },
};

const secret = (value: string): SecretView => ({ set: value.length > 0, hint: value.length >= 8 ? `…${value.slice(-4)}` : '' });

/** What the interface may see: everything except the secrets themselves. */
export function viewOf(s: AppSettings): AppSettingsView {
  const { telegram, whatsapp } = s.notifications;
  return {
    notifications: {
      telegram: { ...telegram, botToken: secret(telegram.botToken), ready: CHANNELS.telegram.missing(telegram).length === 0 },
      whatsapp: { ...whatsapp, accessToken: secret(whatsapp.accessToken), ready: CHANNELS.whatsapp.missing(whatsapp).length === 0 },
    },
  };
}

/** Applies a change section by section; fields that are left out keep their saved value. */
export function applyPatch(s: AppSettings, p: AppSettingsPatch): AppSettings {
  const trimmed = <T extends object>(o: Partial<T> | undefined): Partial<T> =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])) as Partial<T>;
  return {
    notifications: {
      telegram: { ...s.notifications.telegram, ...trimmed(p.notifications?.telegram) },
      whatsapp: { ...s.notifications.whatsapp, ...trimmed(p.notifications?.whatsapp) },
    },
  };
}

/**
 * Preferences that have to work with no browser open (where to send alerts). They live in the local
 * database; secrets are stored as entered, so the database file is as private as the tokens in it.
 */
export class SettingsService {
  private cached: AppSettings | null = null;

  constructor(private store: Store) {}

  async get(): Promise<AppSettings> {
    if (this.cached) return this.cached;
    let saved: AppSettingsPatch = {};
    try {
      saved = JSON.parse((await this.store.getSetting(KEY)) ?? '{}') as AppSettingsPatch;
    } catch {
      /* unreadable settings fall back to the defaults */
    }
    // Merged over the defaults so settings added in later versions get their default.
    this.cached = applyPatch(DEFAULT_SETTINGS, saved);
    return this.cached;
  }

  async update(patch: AppSettingsPatch): Promise<AppSettings> {
    const next = applyPatch(await this.get(), patch);
    await this.store.setSetting(KEY, JSON.stringify(next));
    this.cached = next;
    return next;
  }
}
