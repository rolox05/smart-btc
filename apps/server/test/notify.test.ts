import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NotificationDelivery } from '@smart-btc/shared';
import type { Http } from '../src/notify/channels.js';
import { Notifier } from '../src/notify/notifier.js';
import { SettingsService, viewOf } from '../src/settings.js';
import { isLocalOrigin } from '../src/settingsRoutes.js';
import type { Store } from '../src/store/store.js';

function memoryStore() {
  const kv = new Map<string, string>();
  const log: NotificationDelivery[] = [];
  const store = {
    getSetting: async (k: string) => kv.get(k) ?? null,
    setSetting: async (k: string, v: string) => void kv.set(k, v),
    addNotification: async (d: NotificationDelivery) => void log.push(d),
    getNotifications: async () => log,
  } as unknown as Store;
  return { store, log, kv };
}

function fakeHttp(status = 200, body = '{}') {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const http: Http = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: status < 300, status, text: async () => body };
  };
  return { http, calls };
}

const MSG = { kind: 'alert' as const, title: 'Price alert', body: 'BTC crossed 70,000' };
const TOKEN = '123456:ABCDEFGHIJKLMNOP';

test('settings: secrets are never returned, and a patch keeps what it does not mention', async () => {
  const { store } = memoryStore();
  const settings = new SettingsService(store);
  await settings.update({ notifications: { telegram: { enabled: true, botToken: ` ${TOKEN} `, chatId: '42' } } });
  await settings.update({ notifications: { telegram: { chatId: '43' } } });
  const saved = await new SettingsService(store).get();
  assert.equal(saved.notifications.telegram.botToken, TOKEN);
  assert.equal(saved.notifications.telegram.chatId, '43');
  const view = viewOf(saved);
  assert.deepEqual(view.notifications.telegram.botToken, { set: true, hint: '…MNOP' });
  assert.equal(view.notifications.telegram.ready, true);
  assert.equal(view.notifications.whatsapp.ready, false);
  assert.ok(!JSON.stringify(view).includes(TOKEN));
});

test('notifier: sends to enabled channels only, in each service\'s format', async () => {
  const { store, log } = memoryStore();
  const settings = new SettingsService(store);
  await settings.update({
    notifications: {
      telegram: { enabled: true, botToken: TOKEN, chatId: '42' },
      whatsapp: { enabled: false, phoneNumberId: '999', accessToken: 'EAAG-secret-token', to: '+54 9 11 5555-0000' },
    },
  });
  const { http, calls } = fakeHttp();
  const notifier = new Notifier(settings, store, http);
  const sent = await notifier.notify(MSG);
  assert.deepEqual(sent.map((d) => [d.channel, d.ok]), [['telegram', true]]);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].body.chat_id, '42');
  assert.equal(log.length, 1);

  // A test message goes to the named channel even when it is switched off.
  await notifier.notify({ ...MSG, kind: 'test' }, 'whatsapp');
  assert.match(calls[1].url, /graph\.facebook\.com\/v[\d.]+\/999\/messages$/);
  assert.equal(calls[1].headers.authorization, 'Bearer EAAG-secret-token');
  assert.equal(calls[1].body.to, '5491155550000');
  assert.equal(calls[1].body.type, 'text');

  await settings.update({ notifications: { whatsapp: { template: 'btc_alert' } } });
  await notifier.notify({ ...MSG, kind: 'test' }, 'whatsapp');
  const template = calls[2].body.template as { name: string; components: { parameters: { text: string }[] }[] };
  assert.equal(template.name, 'btc_alert');
  assert.ok(!template.components[0].parameters[0].text.includes('\n'));
});

test('notifier: a failure is a logged result with the service\'s reason and no secret in it', async () => {
  const { store, log } = memoryStore();
  const settings = new SettingsService(store);
  await settings.update({ notifications: { telegram: { enabled: true, botToken: TOKEN, chatId: '42' } } });
  const { http } = fakeHttp(400, JSON.stringify({ ok: false, description: `Bad Request: chat not found for ${TOKEN}` }));
  const [d] = await new Notifier(settings, store, http).notify(MSG);
  assert.equal(d.ok, false);
  assert.match(d.error!, /chat not found.*HTTP 400/);
  assert.ok(!d.error!.includes(TOKEN));
  assert.equal(log[0].ok, false);

  const [missing] = await new Notifier(settings, store, http).notify(MSG, 'whatsapp');
  assert.match(missing.error!, /Not configured: phoneNumberId, accessToken, to/);
});

test('notifier: the same alert is not repeated within the cooldown', async () => {
  const { store } = memoryStore();
  const settings = new SettingsService(store);
  await settings.update({ notifications: { telegram: { enabled: true, botToken: TOKEN, chatId: '42' } } });
  const { http, calls } = fakeHttp();
  const notifier = new Notifier(settings, store, http);
  await notifier.notify({ ...MSG, dedupeKey: 'price:70000' });
  await notifier.notify({ ...MSG, dedupeKey: 'price:70000' });
  await notifier.notify({ ...MSG, dedupeKey: 'price:71000' });
  assert.equal(calls.length, 2);
});

test('settings routes accept local origins only', () => {
  assert.equal(isLocalOrigin(undefined), true);
  assert.equal(isLocalOrigin('http://localhost:5173'), true);
  assert.equal(isLocalOrigin('http://127.0.0.1:4747'), true);
  assert.equal(isLocalOrigin('https://evil.example'), false);
  assert.equal(isLocalOrigin('http://localhost.evil.example'), false);
  assert.equal(isLocalOrigin('null'), false);
});
