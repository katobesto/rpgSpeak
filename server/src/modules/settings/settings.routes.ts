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

  // GET /api/settings/bzcomfy-workflows — proxy to the remote bzComfy /api/workflows endpoint
  app.get('/bzcomfy-workflows', async (_req, reply) => {
    const bzUrl   = service.get('bzComfyUrl')      as string | null;
    const bzToken = service.get('bzComfyApiToken') as string | null;
    if (!bzUrl) return reply.status(400).send({ error: 'bzComfyUrl no configurada' });
    try {
      const res = await fetch(`${bzUrl}/api/workflows`, {
        headers: bzToken ? { Authorization: `Bearer ${bzToken}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return reply.status(res.status).send({ error: `bzComfy respondió con ${res.status}` });
      return reply.send(await res.json());
    } catch (err) {
      return reply.status(503).send({ error: err instanceof Error ? err.message : 'No se pudo conectar a bzComfy' });
    }
  });
};
