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
        let hasResolutionControl = false;
        let defaultMegapixel: string | undefined;
        let defaultAspectRatio: string | undefined;
        try {
          const wf = JSON.parse(await readFile(path.join(WORKFLOWS_DIR, f), 'utf-8')) as Record<string, { class_type?: string; inputs?: Record<string, unknown>; _meta?: { title?: string } }>;
          const nodes = Object.values(wf);
          const loadNode = nodes.find((n) => n.class_type === 'LoadImage');
          if (loadNode) { hasImageInput = true; imageInputLabel = loadNode._meta?.title ?? 'Reference Image'; }
          const resNode = nodes.find((n) => n.class_type === 'FluxResolutionNode');
          if (resNode) {
            hasResolutionControl = true;
            defaultMegapixel = resNode.inputs?.megapixel as string | undefined;
            defaultAspectRatio = resNode.inputs?.aspect_ratio as string | undefined;
          }
        } catch { /* skip */ }
        workflows.push({ id, label, hasImageInput, imageInputLabel, hasResolutionControl, defaultMegapixel, defaultAspectRatio });
      }
      return reply.send({ data: workflows });
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : 'Error leyendo workflows' });
    }
  });

  // GET /api/settings/comfyui-resolution-options — queries ComfyUI object_info for FluxResolutionNode
  // combo values so the UI always shows the exact valid strings for the installed node version.
  app.get('/comfyui-resolution-options', async (_req, reply) => {
    const comfyUrl = service.get('comfyUiUrl') as string | null;
    if (!comfyUrl) return reply.status(400).send({ error: 'comfyUiUrl no configurada' });
    const cfId  = service.get('comfyUiCfClientId')     as string | null;
    const cfSec = service.get('comfyUiCfClientSecret') as string | null;
    const headers: Record<string, string> = {};
    if (cfId && cfSec) {
      headers['CF-Access-Client-Id']     = cfId;
      headers['CF-Access-Client-Secret'] = cfSec;
    }
    try {
      const res = await fetch(`${comfyUrl}/object_info/FluxResolutionNode`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return reply.status(res.status).send({ error: `ComfyUI respondió con ${res.status}` });
      const info = await res.json() as Record<string, { input?: { required?: Record<string, [unknown[]]> } }>;
      const required  = info?.FluxResolutionNode?.input?.required ?? {};
      const megapixels   = (required?.megapixel?.[0]    ?? []) as string[];
      const aspectRatios = (required?.aspect_ratio?.[0] ?? []) as string[];
      return reply.send({ data: { megapixels, aspectRatios } });
    } catch (err) {
      return reply.status(503).send({ error: err instanceof Error ? err.message : 'No se pudo conectar a ComfyUI' });
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

  // GET /api/settings/bzcomfy-loras — proxy to the remote bzComfy /api/loras endpoint
  app.get('/bzcomfy-loras', async (_req, reply) => {
    const bzUrl   = service.get('bzComfyUrl')      as string | null;
    const bzToken = service.get('bzComfyApiToken') as string | null;
    if (!bzUrl) return reply.status(400).send({ error: 'bzComfyUrl no configurada' });
    try {
      const res = await fetch(`${bzUrl}/api/loras`, {
        headers: bzToken ? { Authorization: `Bearer ${bzToken}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return reply.status(res.status).send({ error: `bzComfy respondió con ${res.status}` });
      const loras = await res.json();
      return reply.send({ data: loras });
    } catch (err) {
      return reply.status(503).send({ error: err instanceof Error ? err.message : 'No se pudo conectar a bzComfy' });
    }
  });
};
