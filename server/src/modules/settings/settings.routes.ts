import type { FastifyPluginAsync } from 'fastify';
import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { SettingsService } from './settings.service.js';
import type { AppSettings, BzWorkflow } from '@rpgspeak/shared';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const WORKFLOWS_DIR = path.join(PROJECT_ROOT, 'data', 'comfy-workflows');

const service = new SettingsService();

type WorkflowNode = { class_type?: string; inputs?: Record<string, unknown> };
type WorkflowGraph = Record<string, WorkflowNode>;

interface ModelControlInfo {
  label: string;
  nodeId: string;
  input: string;
  objectInfoClass: string;
  objectInfoInput: string;
  allowPattern: string | null;
  defaultModel: string | null;
}

// Detects a workflow's base-model selector from its _meta.json `modelControl` block
// (e.g. a UNETLoader's `unet_name`), mirroring bzComfy/server.js's detectModelControl.
function detectModelControl(workflow: WorkflowGraph, meta: Record<string, unknown> | null): ModelControlInfo | null {
  const control = meta?.modelControl as Record<string, unknown> | undefined;
  if (!control?.nodeId || !control?.input) return null;
  const node = workflow[control.nodeId as string];
  if (!node) return null;
  const defaultModel = (node.inputs?.[control.input as string] as string | undefined)
    ?? (control.default as string | undefined)
    ?? null;
  return {
    label: (control.label as string) || 'Modelo',
    nodeId: control.nodeId as string,
    input: control.input as string,
    objectInfoClass: (control.objectInfoClass as string) || node.class_type || '',
    objectInfoInput: (control.objectInfoInput as string) || (control.input as string),
    allowPattern: (control.allowPattern as string) || null,
    defaultModel,
  };
}

// Queries ComfyUI's object_info for the combo values of a modelControl, mirroring
// bzComfy/server.js's loadModelOptions.
async function loadModelOptions(control: ModelControlInfo, comfyUrl: string, headers: Record<string, string>): Promise<string[]> {
  if (!control.objectInfoClass || !control.objectInfoInput) return [];
  const r = await fetch(`${comfyUrl}/object_info/${encodeURIComponent(control.objectInfoClass)}`, {
    headers,
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`ComfyUI ${r.status}`);
  const info = await r.json() as Record<string, { input?: { required?: Record<string, [unknown[]]> } }>;
  const values = info?.[control.objectInfoClass]?.input?.required?.[control.objectInfoInput]?.[0];
  if (!Array.isArray(values)) return [];
  let options = values.filter((v): v is string => typeof v === 'string');
  if (control.allowPattern) {
    const re = new RegExp(control.allowPattern, 'i');
    options = options.filter((v) => re.test(v));
  }
  if (control.defaultModel && !options.includes(control.defaultModel)) {
    options.unshift(control.defaultModel);
  }
  return options;
}

// Detects a "Power Lora Loader (rgthree)" node and its lora_N slots, mirroring
// bzComfy/server.js's detectPowerLoraNode.
function detectPowerLoraNode(workflow: WorkflowGraph): NonNullable<BzWorkflow['powerLoras']> | null {
  for (const node of Object.values(workflow)) {
    if (node.class_type !== 'Power Lora Loader (rgthree)') continue;
    const loras: NonNullable<BzWorkflow['powerLoras']> = [];
    for (const [key, val] of Object.entries(node.inputs ?? {})) {
      if (!/^lora_\d+$/.test(key)) continue;
      if (typeof val !== 'object' || val === null) continue;
      const v = val as Record<string, unknown>;
      loras.push({
        key,
        name: (v.lora as string) ?? '',
        on: !!v.on,
        strength: typeof v.strength === 'number' ? v.strength : 1.0,
      });
    }
    if (loras.length > 0) return loras;
  }
  return null;
}

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
      const comfyUrl = service.get('comfyUiUrl') as string | null;
      const cfId  = service.get('comfyUiCfClientId')     as string | null;
      const cfSec = service.get('comfyUiCfClientSecret') as string | null;
      const comfyHeaders: Record<string, string> = {};
      if (cfId && cfSec) {
        comfyHeaders['CF-Access-Client-Id']     = cfId;
        comfyHeaders['CF-Access-Client-Secret'] = cfSec;
      }

      const files = await readdir(WORKFLOWS_DIR);
      const workflows: BzWorkflow[] = [];
      for (const f of files.filter((f) => f.endsWith('_api.json'))) {
        const id = f.replace('_api.json', '');
        let label = id.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        let meta: Record<string, unknown> | null = null;
        try {
          meta = JSON.parse(await readFile(path.join(WORKFLOWS_DIR, `${id}_meta.json`), 'utf-8'));
          if (meta?.label) label = meta.label as string;
        } catch { /* no meta file */ }

        let hasImageInput = false;
        let imageInputLabel: string | null = null;
        let hasResolutionControl = false;
        let defaultMegapixel: string | undefined;
        let defaultAspectRatio: string | undefined;
        let hasModelControl = false;
        let modelControl: BzWorkflow['modelControl'] = null;
        let hasPowerLora = false;
        let powerLoras: BzWorkflow['powerLoras'] = [];
        const hasLora = !!meta?.loraNodeId;

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

          const control = detectModelControl(wf, meta);
          if (control) {
            hasModelControl = true;
            let options: string[] = [];
            if (comfyUrl) {
              try {
                options = await loadModelOptions(control, comfyUrl, comfyHeaders);
              } catch { /* fall back below */ }
            }
            if (options.length === 0 && control.defaultModel) options = [control.defaultModel];
            modelControl = { label: control.label, defaultModel: control.defaultModel, options };
          }

          const loras = detectPowerLoraNode(wf);
          if (loras) { hasPowerLora = true; powerLoras = loras; }
        } catch { /* skip */ }

        workflows.push({
          id, label, hasImageInput, imageInputLabel, hasResolutionControl, defaultMegapixel, defaultAspectRatio,
          hasLora, hasModelControl, modelControl, hasPowerLora, powerLoras,
        });
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
