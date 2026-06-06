import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SettingsService } from '../settings/settings.service.js';

const settingsService = new SettingsService();

/** Resolve the Python TTS service base URL from stored settings. */
function ttsBaseUrl(): string {
  const s = settingsService.getAll();
  return (s.ttsSettings?.serviceUrl ?? 'http://localhost:8020').replace(/\/$/, '');
}

/** Fetch from the Python service with a timeout, adding auth header if configured. */
async function fetchTts(path: string, init?: RequestInit & { timeoutMs?: number }) {
  const { timeoutMs = 120_000, ...rest } = init ?? {};
  const token = settingsService.getAll().ttsSettings?.authToken;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> ?? {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${ttsBaseUrl()}${path}`, {
    ...rest,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export const ttsRoutes: FastifyPluginAsync = async (app) => {
  // ─── GET /api/tts/status ──────────────────────────────────────────────────
  app.get('/status', async (_req, reply) => {
    try {
      const resp = await fetchTts('/health', { timeoutMs: 3_000 });
      const data = await resp.json() as Record<string, unknown>;
      return reply.send({
        online:       true,
        modelLoaded:  Boolean(data.model_loaded),
        modelLoading: Boolean(data.model_loading),
        device:       data.device ?? 'cpu',
      });
    } catch {
      return reply.send({ online: false, modelLoaded: false, modelLoading: false });
    }
  });

  // ─── GET /api/tts/voices ─────────────────────────────────────────────────
  app.get('/voices', async (_req, reply) => {
    try {
      const resp = await fetchTts('/voices', { timeoutMs: 5_000 });
      if (!resp.ok) throw new Error('TTS service error');
      return reply.send(await resp.json());
    } catch {
      return reply.status(503).send({ success: false, error: 'Servicio TTS no disponible' });
    }
  });

  // ─── POST /api/tts/synthesize ─────────────────────────────────────────────
  app.post('/synthesize', async (req, reply) => {
    const schema = z.object({
      text:        z.string().min(1).max(12000),
      voiceId:     z.string().default('es_daniela'),
      speed:       z.number().min(0.5).max(2).default(1.0),
      temperature: z.number().min(0.1).max(1).default(0.7),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { text, voiceId, speed, temperature } = parsed.data;

    let resp: Response;
    try {
      resp = await fetchTts('/synthesize', {
        method:   'POST',
        headers:  { 'Content-Type': 'application/json' },
        body:     JSON.stringify({ text, voice_id: voiceId, speed, temperature }),
        timeoutMs: 180_000, // long: CPU synthesis can take >60s for a paragraph
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(503).send({ success: false, error: `Servicio TTS no disponible: ${msg}` });
    }

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ detail: 'Error de síntesis' })) as Record<string, unknown>;
      return reply.status(resp.status).send({ success: false, error: body.detail ?? 'Error de síntesis' });
    }

    const audio       = Buffer.from(await resp.arrayBuffer());
    const contentType = resp.headers.get('content-type') ?? 'audio/wav';
    return reply
      .header('Content-Type', contentType)
      .header('Content-Length', String(audio.length))
      .send(audio);
  });

  // ─── POST /api/tts/voices/download ───────────────────────────────────────
  app.post('/voices/download', async (req, reply) => {
    const schema = z.object({ voiceId: z.string() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    let resp: Response;
    try {
      resp = await fetchTts('/download-voice', {
        method:   'POST',
        headers:  { 'Content-Type': 'application/json' },
        body:     JSON.stringify({ voice_id: parsed.data.voiceId }),
        timeoutMs: 120_000,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(503).send({ success: false, error: `Servicio TTS no disponible: ${msg}` });
    }

    const data = await resp.json();
    return reply.status(resp.ok ? 200 : resp.status).send(data);
  });
};
