import type { FastifyPluginAsync } from 'fastify';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SettingsService } from './settings.service.js';
import type { AppSettings, BzWorkflow } from '@rpgspeak/shared';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const WORKFLOWS_DIR = path.join(PROJECT_ROOT, 'data', 'comfy-workflows');

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

  // GET /api/settings/comfyui-workflows — reads local data/comfy-workflows/ directory
  app.get('/comfyui-workflows', async (_req, reply) => {
    try {
      const files = await readdir(WORKFLOWS_DIR);
      const workflows: BzWorkflow[] = [];
      for (const f of files.filter((f) => f.endsWith('_api.json'))) {
        const id = f.replace('_api.json', '');
        let label = id.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        let hasImageInput = false;
        let imageInputLabel: string | null = null;
        try {
          const meta = JSON.parse(await readFile(path.join(WORKFLOWS_DIR, `${id}_meta.json`), 'utf-8'));
          if (meta.label) label = meta.label;
        } catch { /* no meta file */ }
        try {
          const wf = JSON.parse(await readFile(path.join(WORKFLOWS_DIR, f), 'utf-8'));
          const loadNode = Object.values(wf as Record<string, { class_type?: string; _meta?: { title?: string } }>)
            .find((n) => n.class_type === 'LoadImage');
          if (loadNode) { hasImageInput = true; imageInputLabel = loadNode._meta?.title ?? 'Reference Image'; }
        } catch { /* skip */ }
        workflows.push({ id, label, hasImageInput, imageInputLabel });
      }
      return reply.send({ data: workflows });
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'Error leyendo workflows' });
    }
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
      const workflows = await res.json();
      return reply.send({ data: workflows });
    } catch (err) {
      return reply.status(503).send({ error: err instanceof Error ? err.message : 'No se pudo conectar a bzComfy' });
    }
  });
};
