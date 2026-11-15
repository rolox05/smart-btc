import type { AppSettings, ChannelId, NotificationMessage, TelegramConfig, WhatsAppConfig } from '@smart-btc/shared';

/**
 * A way of reaching the user. Adding one (email, Discord, a webhook) means writing one of these,
 * giving it a config block in AppSettings and listing it in CHANNELS; nothing else changes.
 */
export interface Channel<C> {
  id: ChannelId;
  /** Its block of the settings. */
  config(settings: AppSettings): C & { enabled: boolean };
  /** Names of the settings still missing; empty when the channel can send. */
  missing(config: C): string[];
  /** Delivers one message; throws with a readable reason when the service refuses it. */
  send(config: C, message: NotificationMessage, http: Http): Promise<void>;
}

/** The part of fetch the channels use, so tests can stand in for the network. */
export type Http = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const TIMEOUT_MS = 10_000;

const text = (m: NotificationMessage) => `${m.title}\n\n${m.body}`;

async function post(http: Http, url: string, headers: Record<string, string>, body: unknown, reason: (payload: unknown) => string | undefined) {
  const res = await http(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.ok) return;
  const raw = await res.text().catch(() => '');
  let why: string | undefined;
  try {
    why = reason(JSON.parse(raw));
  } catch {
    /* not JSON: fall back to the status */
  }
  throw new Error(why ? `${why} (HTTP ${res.status})` : `HTTP ${res.status}`);
}

/** Telegram Bot API: a bot created with @BotFather writes to a chat it has been added to. */
export const telegram: Channel<TelegramConfig> = {
  id: 'telegram',
  config: (s) => s.notifications.telegram,
  missing: (c) => [...(c.botToken ? [] : ['botToken']), ...(c.chatId ? [] : ['chatId'])],
  async send(c, message, http) {
    await post(
      http,
      `https://api.telegram.org/bot${c.botToken}/sendMessage`,
      {},
      { chat_id: c.chatId, text: text(message), disable_web_page_preview: true },
      (p) => (p as { description?: string }).description,
    );
  },
};

const GRAPH_VERSION = 'v21.0';

/**
 * WhatsApp Cloud API (Meta). Free text only reaches a number that wrote to the business number in
 * the last 24 hours; anything else has to be an approved template, so alerts normally use one. The
 * template is expected to have a single body variable, which receives the message.
 */
export const whatsapp: Channel<WhatsAppConfig> = {
  id: 'whatsapp',
  config: (s) => s.notifications.whatsapp,
  missing: (c) => [...(c.phoneNumberId ? [] : ['phoneNumberId']), ...(c.accessToken ? [] : ['accessToken']), ...(c.to ? [] : ['to'])],
  async send(c, message, http) {
    const to = c.to.replace(/\D/g, '');
    const content = c.template
      ? {
          type: 'template',
          template: {
            name: c.template,
            language: { code: c.templateLang || 'en' },
            // Template variables cannot hold line breaks or long runs of spaces.
            components: [{ type: 'body', parameters: [{ type: 'text', text: text(message).replace(/\s*\n+\s*/g, ' · ').slice(0, 1000) }] }],
          },
        }
      : { type: 'text', text: { body: text(message) } };
    await post(
      http,
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(c.phoneNumberId)}/messages`,
      { authorization: `Bearer ${c.accessToken}` },
      { messaging_product: 'whatsapp', to, ...content },
      (p) => (p as { error?: { message?: string } }).error?.message,
    );
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CHANNELS: Record<ChannelId, Channel<any>> = { telegram, whatsapp };
