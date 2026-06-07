import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { TtsVoice } from '@rpgspeak/shared';

// ─── Voice catalog (Microsoft Edge TTS neural voices) ────────────────────────

interface VoiceMeta {
  id: string;
  name: string;
  gender: 'male' | 'female';
  description: string;
  edgeVoiceId: string;
}

const VOICE_CATALOG: VoiceMeta[] = [
  // ── España ──────────────────────────────────────────────────────────────────
  { id: 'edge_elvira',   name: 'Elvira',   gender: 'female', edgeVoiceId: 'es-ES-ElviraNeural',                  description: 'Voz neural femenina, acento español (Microsoft)' },
  { id: 'edge_irene',    name: 'Irene',    gender: 'female', edgeVoiceId: 'es-ES-IreneNeural',                   description: 'Voz neural femenina cálida, acento español (Microsoft)' },
  { id: 'edge_triana',   name: 'Triana',   gender: 'female', edgeVoiceId: 'es-ES-TrianaNeural',                  description: 'Voz neural femenina expresiva, acento español (Microsoft)' },
  { id: 'edge_abril',    name: 'Abril',    gender: 'female', edgeVoiceId: 'es-ES-AbrilNeural',                   description: 'Voz neural femenina amigable, acento español (Microsoft)' },
  { id: 'edge_estrella', name: 'Estrella', gender: 'female', edgeVoiceId: 'es-ES-EstrellaNeural',                description: 'Voz neural femenina positiva, acento español (Microsoft)' },
  { id: 'edge_laia',     name: 'Laia',     gender: 'female', edgeVoiceId: 'es-ES-LaiaNeural',                    description: 'Voz neural femenina cálida, acento español (Microsoft)' },
  { id: 'edge_vera',     name: 'Vera',     gender: 'female', edgeVoiceId: 'es-ES-VeraNeural',                    description: 'Voz neural femenina clara, acento español (Microsoft)' },
  { id: 'edge_ximena',   name: 'Ximena',   gender: 'female', edgeVoiceId: 'es-ES-XimenaMultilingualNeural',      description: 'Voz neural femenina multilingüe, acento español (Microsoft)' },
  { id: 'edge_arabella', name: 'Arabella', gender: 'female', edgeVoiceId: 'es-ES-ArabellaMultilingualNeural',    description: 'Voz neural femenina multilingüe expresiva, acento español (Microsoft)' },
  { id: 'edge_isidora',  name: 'Isidora',  gender: 'female', edgeVoiceId: 'es-ES-IsidoraMultilingualNeural',     description: 'Voz neural femenina multilingüe serena, acento español (Microsoft)' },
  { id: 'edge_alvaro',   name: 'Álvaro',   gender: 'male',   edgeVoiceId: 'es-ES-AlvaroNeural',                  description: 'Voz neural masculina, acento español (Microsoft)' },
  { id: 'edge_saul',     name: 'Saúl',     gender: 'male',   edgeVoiceId: 'es-ES-SaulNeural',                    description: 'Voz neural masculina natural, acento español (Microsoft)' },
  // ── México ──────────────────────────────────────────────────────────────────
  { id: 'edge_dalia',     name: 'Dalia',   gender: 'female', edgeVoiceId: 'es-MX-DaliaNeural',   description: 'Voz neural femenina, acento mexicano (Microsoft)' },
  { id: 'edge_candela',   name: 'Candela', gender: 'female', edgeVoiceId: 'es-MX-CandelaNeural', description: 'Voz neural femenina expresiva, acento mexicano (Microsoft)' },
  { id: 'edge_jorge_mx',  name: 'Jorge',   gender: 'male',   edgeVoiceId: 'es-MX-JorgeNeural',   description: 'Voz neural masculina, acento mexicano (Microsoft)' },
  // ── Argentina ───────────────────────────────────────────────────────────────
  { id: 'edge_elena_ar', name: 'Elena AR', gender: 'female', edgeVoiceId: 'es-AR-ElenaNeural',  description: 'Voz neural femenina, acento argentino (Microsoft)' },
  { id: 'edge_tomas_ar', name: 'Tomás AR', gender: 'male',   edgeVoiceId: 'es-AR-TomasNeural',  description: 'Voz neural masculina, acento argentino (Microsoft)' },
  // ── Colombia ────────────────────────────────────────────────────────────────
  { id: 'edge_salome',   name: 'Salomé',   gender: 'female', edgeVoiceId: 'es-CO-SalomeNeural',   description: 'Voz neural femenina, acento colombiano (Microsoft)' },
  { id: 'edge_gonzalo',  name: 'Gonzalo',  gender: 'male',   edgeVoiceId: 'es-CO-GonzaloNeural',  description: 'Voz neural masculina, acento colombiano (Microsoft)' },
  // ── Español americano (US) ──────────────────────────────────────────────────
  { id: 'edge_paloma',   name: 'Paloma',   gender: 'female', edgeVoiceId: 'es-US-PalomaNeural',   description: 'Voz neural femenina neutra, español americano (Microsoft)' },
];

const VOICE_MAP = new Map(VOICE_CATALOG.map((v) => [v.id, v]));

// ─── Text preprocessing ───────────────────────────────────────────────────────

function cleanText(text: string): string {
  // Speaker labels: **Natasha:** text → "Natasha dice, text"
  text = text.replace(/\*\*([^*:\n]{1,50}):\*\*\s*\n?/g, '$1 dice, ');
  text = text.replace(/^([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{0,29}(?:\s+[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]{0,29}){0,3}):\s+/gm, '$1 dice, ');
  // Markdown removal
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/`[^`]+`/g, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/\*([^*]+)\*/g, '$1');
  text = text.replace(/_([^_]+)_/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/^[-*+]\s+/gm, '');
  text = text.replace(/^\d+\.\s+/gm, '');
  text = text.replace(/^[\s]*[-_*]{3,}[\s]*$/gm, '');
  text = text.replace(/^\s*\([^)]{1,300}\)\s*/gm, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

// ─── Synthesis ────────────────────────────────────────────────────────────────

async function synthesize(edgeVoiceId: string, text: string, speed: number): Promise<Buffer> {
  // Convert speed (0.5–2.0) to Edge TTS rate string ("+20%", "-30%", etc.)
  const ratePct = Math.round((speed - 1.0) * 100);
  const rateStr = ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`;

  const tts = new MsEdgeTTS();
  await tts.setMetadata(edgeVoiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const { audioStream } = tts.toStream(text, { rate: rateStr });
    audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    audioStream.on('end', () => {
      const result = Buffer.concat(chunks);
      if (result.length === 0) reject(new Error('Edge TTS no devolvió audio'));
      else resolve(result);
    });
    audioStream.on('error', reject);
  });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export const ttsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/tts/status
  app.get('/status', async (_req, reply) => {
    return reply.send({ online: true, modelLoaded: true, modelLoading: false, device: 'cloud' });
  });

  // GET /api/tts/voices
  app.get('/voices', async (_req, reply) => {
    const voices: (TtsVoice & { available: boolean })[] = VOICE_CATALOG.map((v) => ({
      id: v.id,
      name: v.name,
      gender: v.gender,
      description: v.description,
      type: 'cloud' as const,
      available: true,
    }));
    return reply.send({ success: true, data: voices });
  });

  // POST /api/tts/synthesize
  app.post('/synthesize', async (req, reply) => {
    const parsed = z.object({
      text:        z.string().min(1).max(12000),
      voiceId:     z.string().default('edge_elvira'),
      speed:       z.number().min(0.5).max(2.0).default(1.0),
      temperature: z.number().min(0.1).max(1.0).default(0.7),
    }).safeParse(req.body);

    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.message });
    }

    const { text, voiceId, speed } = parsed.data;
    const voice = VOICE_MAP.get(voiceId);
    if (!voice) {
      return reply.status(404).send({ success: false, error: `Voz '${voiceId}' no encontrada` });
    }

    const clean = cleanText(text);
    if (!clean) {
      return reply.status(400).send({ success: false, error: 'El texto está vacío después de limpiar' });
    }

    try {
      const audio = await synthesize(voice.edgeVoiceId, clean, speed);
      return reply
        .header('Content-Type', 'audio/mpeg')
        .header('Content-Length', String(audio.length))
        .send(audio);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error('[tts] synthesis error: %s', msg);
      return reply.status(500).send({ success: false, error: `Error en síntesis: ${msg}` });
    }
  });

  // POST /api/tts/voices/download — kept for API compatibility, no-op for cloud voices
  app.post('/voices/download', async (_req, reply) => {
    return reply.send({ success: true, message: 'Las voces Edge TTS son cloud — no requieren descarga.' });
  });
};
