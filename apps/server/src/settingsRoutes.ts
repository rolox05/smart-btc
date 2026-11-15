import { CHANNEL_IDS, type AppSettingsView, type NotificationDelivery } from '@smart-btc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { langOf, makeT } from './i18n/index.js';
import type { Notifier } from './notify/notifier.js';
import { type SettingsService, viewOf } from './settings.js';
import type { Store } from './store/store.js';

const short = z.string().max(400);
const patchSchema = z.object({
  notifications: z
    .object({
      telegram: z.object({ enabled: z.boolean(), botToken: short, chatId: short }).partial(),
      whatsapp: z.object({ enabled: z.boolean(), phoneNumberId: short, accessToken: z.string().max(1000), to: short, template: short, templateLang: z.string().max(12) }).partial(),
    })
    .partial(),
});

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * These routes hold credentials and can send messages, so a page from another site open in the same
 * browser must not be able to call them: browsers attach an Origin to such requests, and only local
 * origins are let through.
 */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // not a cross-site browser request (same-origin GET, curl, the dev proxy)
  try {
    return LOCAL.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function registerSettingsRoutes(app: FastifyInstance, deps: { settings: SettingsService; notifier: Notifier; store: Store }) {
  const guard = (req: FastifyRequest) => {
    if (!isLocalOrigin(req.headers.origin)) throw Object.assign(new Error('Settings are only available from this computer.'), { statusCode: 403 });
  };

  app.get('/api/settings', async (req): Promise<AppSettingsView> => {
    guard(req);
    return viewOf(await deps.settings.get());
  });

  app.put('/api/settings', async (req): Promise<AppSettingsView> => {
    guard(req);
    return viewOf(await deps.settings.update(patchSchema.parse(req.body)));
  });

  app.get('/api/notifications', async (req): Promise<NotificationDelivery[]> => {
    guard(req);
    return deps.store.getNotifications(20);
  });

  // Sends one message to a channel with the saved settings, so the configuration can be checked.
  app.post('/api/notifications/test', async (req): Promise<NotificationDelivery> => {
    guard(req);
    const { channel } = z.object({ channel: z.enum(CHANNEL_IDS) }).parse(req.body);
    const t = makeT(langOf(req));
    const [delivery] = await deps.notifier.notify(
      { kind: 'test', title: t('Smart BTC test message'), body: t('Notifications are set up correctly. Alerts will arrive here.') },
      channel,
    );
    return delivery;
  });
}
