import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ContextRepository } from './context.repository.js';
import { ValidationError } from '../../shared/errors.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { SettingsService } from '../settings/settings.service.js';
import { extractContextBatch } from '../../core/context/context-extractor.js';
import { createProvider } from '../../core/llm/provider.factory.js';

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

  // POST /context/extract — analyse one batch of 100 messages with LLM (manual)
  app.post('/extract', async (req, reply) => {
    const schema = z.object({
      conversationId: z.string(),
      batchStart:     z.number().int().min(0).default(0),
    });
    const { conversationId, batchStart } = schema.parse(req.body);

    const settings   = new SettingsService();
    const provRepo   = new ProviderRepository();

    // Manual extraction uses default provider (quality priority), falls back to fast LLM
    const defProviderId  = settings.get('defaultProviderId') as string | null;
    const defModelId     = settings.get('defaultModelId')    as string | null;
    const fastProviderId = settings.get('fastLlmProviderId') as string | null;
    const fastModelId    = settings.get('fastLlmModelId')    as string | null;

    const providerId = defProviderId ?? fastProviderId ?? null;
    const modelId    = defProviderId ? defModelId : (fastModelId ?? null);
    if (!providerId) throw new ValidationError('No hay ningún provider LLM configurado');

    const providerRecord = provRepo.findById(providerId);
    if (!providerRecord?.isEnabled) throw new ValidationError('El provider LLM no está disponible');

    const result = await extractContextBatch({
      conversationId,
      batchStart,
      batchSize:  100,   // manual extraction can handle a larger batch
      providerId,
      modelId,
    });

    return reply.send({
      success: true,
      data: {
        items:         [],    // items are persisted by extractContextBatch internally
        batchStart:    result.batchStart,
        batchEnd:      result.batchEnd,
        totalMessages: result.totalMessages,
        itemCount:     result.itemCount,
      },
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
