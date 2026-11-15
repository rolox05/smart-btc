import type { AlertRule } from '@smart-btc/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { langOf } from '../i18n/index.js';
import { isLocalOrigin } from '../settingsRoutes.js';
import { type AlertEngine, MAX_WINDOW_MIN } from './engine.js';

export function registerAlertRoutes(app: FastifyInstance, engine: AlertEngine, settingsSchema: z.ZodType) {
  const inputSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('price'), direction: z.enum(['above', 'below']), price: z.number().positive().max(1e8), once: z.boolean() }),
    z.object({ type: z.literal('liquidations'), side: z.enum(['any', 'long', 'short']), minUsd: z.number().min(10_000).max(1e11), windowMin: z.number().int().min(1).max(MAX_WINDOW_MIN), once: z.boolean() }),
    z.object({ type: z.literal('reading'), settings: settingsSchema, once: z.boolean() }),
  ]);
  const guard = (req: FastifyRequest) => {
    if (!isLocalOrigin(req.headers.origin)) throw Object.assign(new Error('Alerts are only available from this computer.'), { statusCode: 403 });
  };
  const id = (req: FastifyRequest) => z.object({ id: z.string().uuid() }).parse(req.params).id;
  const missing = () => Object.assign(new Error('Unknown alert.'), { statusCode: 404 });

  app.get('/api/alerts', async (req): Promise<AlertRule[]> => {
    guard(req);
    return engine.list();
  });

  app.post('/api/alerts', async (req): Promise<AlertRule> => {
    guard(req);
    const rule = await engine.create(inputSchema.parse(req.body) as Parameters<AlertEngine['create']>[0], langOf(req));
    // A reading rule takes its starting point right away instead of at the next scheduled check.
    if (rule.type === 'reading') void engine.checkReadings();
    return rule;
  });

  app.put('/api/alerts/:id', async (req): Promise<AlertRule> => {
    guard(req);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const rule = await engine.setEnabled(id(req), enabled);
    if (!rule) throw missing();
    if (rule.type === 'reading' && enabled) void engine.checkReadings();
    return rule;
  });

  app.delete('/api/alerts/:id', async (req): Promise<{ ok: true }> => {
    guard(req);
    if (!(await engine.remove(id(req)))) throw missing();
    return { ok: true };
  });
}
