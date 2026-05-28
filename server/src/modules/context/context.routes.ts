import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ContextRepository } from './context.repository.js';
import { ValidationError } from '../../shared/errors.js';
import { MessageRepository } from '../messages/message.repository.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { SettingsService } from '../settings/settings.service.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import { CharacterRepository } from '../characters/character.repository.js';
import { ConversationRepository } from '../conversations/conversation.repository.js';
import { StoryRepository } from '../stories/story.repository.js';
import type { Message } from '@rpgspeak/shared';

const BATCH_SIZE = 100;
// Truncate each message to limit tokens per batch.
// 350 chars ≈ ~90 tokens/msg → 100 msgs ≈ 9 000 tokens + prompt overhead.
// If you still hit context limits, use a model with ≥ 8k context window.
const MAX_MSG_CHARS = 350;
// Max chars for known character/story descriptions injected into the prompt
const MAX_KNOWN_DESC_CHARS = 80;

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildExtractionPrompt(
  batch: Message[],
  batchStart: number,
  total: number,
  charNameMap: Map<string, string>,
  promptTemplate: string,
  knownChars: string,
  knownStories: string,
): string {
  const batchEnd = batchStart + batch.length;

  const lines = batch.map((m) => {
    let speaker = 'Usuario';
    if (m.role === 'assistant') {
      speaker = m.characterId ? (charNameMap.get(m.characterId) ?? 'Personaje') : 'Narrador';
    }
    // Strip affinity/analysis tags and truncate
    const content = m.content
      .replace(/\[AFINIDAD:[^\]]+\]/g, '')
      .replace(/\[MEMORIA:[^\]]+\]/g, '')
      .trim()
      .slice(0, MAX_MSG_CHARS);
    return `${speaker}: ${content}`;
  });

  return promptTemplate
    .replace('{{fragmento}}',           lines.join('\n\n'))
    .replace('{{desde}}',               String(batchStart + 1))
    .replace('{{hasta}}',               String(batchEnd))
    .replace('{{total}}',               String(total))
    .replace('{{personajes_conocidos}}', knownChars  || '(ninguno)')
    .replace('{{historias_conocidas}}', knownStories || '(ninguno)');
}

// ─── Response parser ──────────────────────────────────────────────────────────

type ParsedItem = {
  type: 'event' | 'character' | 'place' | 'quest';
  title: string;
  description: string;
  importance: number;
};

const TAG_RE = /\[(EVENTO|PERSONAJE|LUGAR|CONQUISTA):([^\]|]+)\|([^\]|]+)\|(\d+)\]/g;
const TYPE_MAP: Record<string, 'event' | 'character' | 'place' | 'quest'> = {
  EVENTO: 'event',
  PERSONAJE: 'character',
  LUGAR: 'place',
  CONQUISTA: 'quest',
};

function parseResponse(text: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  for (const m of text.matchAll(TAG_RE)) {
    const type = TYPE_MAP[m[1]];
    const title = m[2].trim();
    const description = m[3].trim();
    const importance = Math.min(10, Math.max(1, parseInt(m[4], 10)));
    if (!type || !title) continue;
    items.push({ type, title, description, importance });
  }
  return items;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export const contextRoutes: FastifyPluginAsync = async (app) => {

  // GET /context?conversationId=X
  app.get<{ Querystring: { conversationId?: string } }>('/', async (req) => {
    const { conversationId } = req.query;
    if (!conversationId) throw new ValidationError('conversationId is required');
    const repo = new ContextRepository();
    return { success: true, data: repo.findByConversation(conversationId) };
  });

  // DELETE /context?conversationId=X — delete ALL items for a conversation
  app.delete<{ Querystring: { conversationId?: string } }>('/', async (req, reply) => {
    const { conversationId } = req.query;
    if (!conversationId) throw new ValidationError('conversationId is required');
    const repo = new ContextRepository();
    repo.deleteByConversation(conversationId);
    return reply.status(204).send();
  });

  // POST /context/extract — analyse one batch of 100 messages with LLM
  app.post('/extract', async (req, reply) => {
    const schema = z.object({
      conversationId: z.string(),
      batchStart:     z.number().int().min(0).default(0),
    });
    const { conversationId, batchStart } = schema.parse(req.body);

    const repo      = new ContextRepository();
    const msgRepo   = new MessageRepository();
    const convRepo  = new ConversationRepository();
    const charRepo  = new CharacterRepository();
    const storyRepo = new StoryRepository();
    const provRepo  = new ProviderRepository();
    const settings  = new SettingsService();

    // All non-system messages, ordered chronologically
    const allMsgs = msgRepo
      .findByConversation(conversationId)
      .filter((m) => m.role !== 'system');
    const total = allMsgs.length;

    const batch = allMsgs.slice(batchStart, batchStart + BATCH_SIZE);
    if (batch.length === 0) {
      return reply.send({ success: true, data: { items: [], batchStart, batchEnd: batchStart, totalMessages: total } });
    }
    const batchEnd = batchStart + batch.length;

    // Build character name map (id → name) and known-chars list for the prompt
    const conversation = convRepo.findById(conversationId);
    const charMap = new Map<string, string>();
    const knownCharLines: string[] = [];
    const knownStoryLines: string[] = [];

    if (conversation) {
      for (const link of conversation.characters) {
        const char = charRepo.findById(link.characterId);
        if (!char) continue;
        charMap.set(char.id, char.name);
        const desc = (char.description || char.personality || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_KNOWN_DESC_CHARS);
        knownCharLines.push(`- ${char.name}${desc ? `: ${desc}` : ''}`);
      }

      for (const link of conversation.stories) {
        const story = storyRepo.findById(link.storyId);
        if (!story) continue;
        const desc = (story.description || story.globalContext || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_KNOWN_DESC_CHARS);
        knownStoryLines.push(`- ${story.name}${desc ? `: ${desc}` : ''}`);
      }
    }

    const knownChars   = knownCharLines.join('\n');
    const knownStories = knownStoryLines.join('\n');

    // Pick LLM: default provider first (needs quality & long context),
    // fall back to fast LLM only if no default is configured.
    const defProviderId  = settings.get('defaultProviderId') as string | null;
    const defModelId     = settings.get('defaultModelId')    as string | null;
    const fastProviderId = settings.get('fastLlmProviderId') as string | null;
    const fastModelId    = settings.get('fastLlmModelId')    as string | null;

    const providerId = defProviderId ?? fastProviderId ?? null;
    const modelId    = defProviderId ? defModelId : (fastModelId ?? null);

    if (!providerId) throw new ValidationError('No hay ningún provider LLM configurado');

    const providerRecord = provRepo.findById(providerId);
    if (!providerRecord?.isEnabled) throw new ValidationError('El provider LLM no está disponible');

    const llm = createProvider(providerRecord);

    // Load prompt template and context size from settings
    const promptTemplate    = settings.get('contextIndexPrompt') as string;
    const contextSize       = (settings.get('contextIndexContextSize') as number | null) ?? 8192;

    const prompt = buildExtractionPrompt(
      batch, batchStart, total, charMap, promptTemplate, knownChars, knownStories,
    );

    const llmResult = await llm.generate({
      messages: [
        {
          role: 'system',
          content: 'Eres un cronista de historias de rol. Responde SOLO con las etiquetas indicadas, sin texto adicional.',
        },
        { role: 'user', content: prompt },
      ],
      model:       modelId ?? '',
      temperature: 0.15,
      maxTokens:   1500,
      contextSize,
      stream:      false,
    });

    const parsed = parseResponse(llmResult.content);
    const items  = parsed.map((p) =>
      repo.create({ conversationId, ...p, messageIndexFrom: batchStart, messageIndexTo: batchEnd })
    );

    // ── Compute embeddings for newly created items (non-fatal if it fails) ──
    const embEnabled    = settings.get('embeddingEnabled') as boolean | null;
    const embProviderId = settings.get('embeddingProviderId') as string | null;
    const embModel      = settings.get('embeddingModel') as string | null;
    if (embEnabled && embProviderId && embModel && items.length > 0) {
      const embProvRecord = provRepo.findById(embProviderId);
      if (embProvRecord?.isEnabled) {
        const embLlm = createProvider(embProvRecord);
        if (embLlm.embed) {
          const texts = items.map((i) => `${i.title}: ${i.description}`);
          try {
            const vecs = await embLlm.embed(texts, embModel);
            for (let j = 0; j < items.length; j++) {
              if (vecs[j]?.length > 0) {
                repo.updateEmbedding(items[j].id, new Float32Array(vecs[j]), embModel);
              }
            }
            console.log(`[embed] Stored ${vecs.length} embeddings (${embModel})`);
          } catch (e) {
            console.warn('[embed] Failed to compute embeddings at extraction time:', e);
          }
        }
      }
    }

    return reply.send({
      success: true,
      data: { items, batchStart, batchEnd, totalMessages: total },
    });
  });

  // POST /context/embed-all — compute embeddings for all items that don't have one yet
  app.post('/embed-all', async (req, reply) => {
    const { conversationId } = z.object({ conversationId: z.string() }).parse(req.body);
    const settings  = new SettingsService();
    const embEnabled    = settings.get('embeddingEnabled') as boolean | null;
    const embProviderId = settings.get('embeddingProviderId') as string | null;
    const embModel      = settings.get('embeddingModel') as string | null;

    if (!embEnabled || !embProviderId || !embModel) {
      throw new ValidationError('Los embeddings no están configurados en Ajustes → Generación');
    }

    const provRepo     = new ProviderRepository();
    const embProvRecord = provRepo.findById(embProviderId);
    if (!embProvRecord?.isEnabled) throw new ValidationError('El provider de embeddings no está disponible');

    const embLlm = createProvider(embProvRecord);
    if (!embLlm.embed) throw new ValidationError('Este provider no soporta embeddings');

    const repo    = new ContextRepository();
    const pending = repo.findWithoutEmbedding(conversationId);

    if (pending.length === 0) {
      return reply.send({ success: true, data: { embedded: 0, total: 0 } });
    }

    const BATCH = 10;
    let embedded = 0;
    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      const texts = slice.map((item) => `${item.title}: ${item.description}`);
      const vecs  = await embLlm.embed(texts, embModel);
      for (let j = 0; j < slice.length; j++) {
        if (vecs[j]?.length > 0) {
          repo.updateEmbedding(slice[j].id, new Float32Array(vecs[j]), embModel);
          embedded++;
        }
      }
    }
    console.log(`[embed] Batch embedded ${embedded}/${pending.length} items for conv ${conversationId}`);
    return reply.send({ success: true, data: { embedded, total: pending.length } });
  });

  // PATCH /context/:id — edit title / description / importance
  app.patch<{ Params: { id: string } }>('/:id', async (req, _reply) => {
    const schema = z.object({
      title:       z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      importance:  z.number().int().min(1).max(10).optional(),
    });
    const data = schema.parse(req.body);
    const repo = new ContextRepository();
    const updated = repo.update(req.params.id, data);
    if (!updated) throw new ValidationError('Entrada no encontrada');
    return { success: true, data: updated };
  });

  // DELETE /context/:id — delete single item
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const repo = new ContextRepository();
    repo.delete(req.params.id);
    return reply.status(204).send();
  });
};
