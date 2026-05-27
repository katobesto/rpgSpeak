import type { FastifyPluginAsync } from 'fastify';
import { SettingsService } from './settings.service.js';
import type { AppSettings } from '@rpgspeak/shared';

const service = new SettingsService();

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => ({ success: true, data: service.getAll() }));

  app.patch('/', async (req) => {
    const updated = service.setMany(req.body as Record<string, unknown>);
    return { success: true, data: updated };
  });

  app.post('/reset', async () => ({ success: true, data: service.reset() }));

  // GET /api/settings/defaults/:key — returns the compiled-in default for one key
  app.get<{ Params: { key: string } }>('/defaults/:key', async (req, reply) => {
    const { key } = req.params;
    const defaults = service.getDefaults();
    if (!(key in defaults)) {
      return reply.status(404).send({ success: false, error: 'Unknown key' });
    }
    return { success: true, data: { key, value: defaults[key as keyof AppSettings] } };
  });
};
