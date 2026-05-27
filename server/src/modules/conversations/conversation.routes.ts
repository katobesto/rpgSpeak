import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ConversationService } from './conversation.service.js';
import { ConversationRepository } from './conversation.repository.js';
import { MessageRepository } from '../messages/message.repository.js';
import { createConversationSchema, updateConversationSchema } from './conversation.schema.js';
import { ValidationError, NotFoundError } from '../../shared/errors.js';

const service = new ConversationService();
const convRepo = new ConversationRepository();
const msgRepo  = new MessageRepository();

export const conversationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { archived } = req.query as { archived?: string };
    const { userId, role } = (req as any).authUser ?? {};
    return { success: true, data: service.list(archived === 'true', userId, role === 'admin') };
  });

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    return { success: true, data: service.get(req.params.id) };
  });

  app.post('/', async (req, reply) => {
    const result = createConversationSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const { userId } = (req as any).authUser ?? {};
    return reply.status(201).send({ success: true, data: service.create(result.data, userId) });
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const result = updateConversationSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    return { success: true, data: service.update(req.params.id, result.data) };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    service.delete(req.params.id);
    return reply.status(204).send();
  });

  // POST /api/conversations/:id/summarize — fuerza actualización manual del resumen
  app.post<{ Params: { id: string } }>('/:id/summarize', async (req, reply) => {
    const updated = await service.triggerSummaryUpdate(req.params.id);
    return reply.send({ success: true, data: updated });
  });

  // PATCH /api/conversations/:id/characters/:charId/affinity
  app.patch<{ Params: { id: string; charId: string } }>(
    '/:id/characters/:charId/affinity',
    async (req, reply) => {
      const { id, charId } = req.params;
      const result = z.object({ affinity: z.number().int().min(1).max(100) }).safeParse(req.body);
      if (!result.success) throw new ValidationError(result.error.issues[0].message);
      const conv = convRepo.findById(id);
      if (!conv) throw new NotFoundError('Conversation', id);
      convRepo.updateCharacterAffinity(id, charId, result.data.affinity);
      return reply.send({ success: true, data: { affinity: result.data.affinity } });
    }
  );

  // GET /api/conversations/stats — global + per-conversation token stats
  app.get('/stats', async (req, reply) => {
    const { userId, role } = (req as any).authUser ?? {};
    const isAdmin = role === 'admin';

    // All conversations this user can see
    const conversations = service.list(true, userId, isAdmin); // include archived

    // Build per-conversation rows; enrich with cached token sum from messages
    const rows = conversations.map((conv) => {
      const messages = msgRepo.findByConversation(conv.id);
      const assistantMsgs = messages.filter((m) => m.role === 'assistant');

      let cachedTokens = 0;
      for (const m of assistantMsgs) {
        const meta = m.metadata as Record<string, unknown> | null;
        if (meta?.cachedTokens && typeof meta.cachedTokens === 'number') {
          cachedTokens += meta.cachedTokens;
        }
      }

      return {
        id:           conv.id,
        title:        conv.title,
        tokens:       conv.tokenCount,
        messages:     conv.messageCount,
        cachedTokens,
        updatedAt:    conv.updatedAt,
        isArchived:   conv.isArchived ?? false,
      };
    });

    // Global totals
    const global = {
      totalTokens:  rows.reduce((s, r) => s + r.tokens,       0),
      totalMessages: rows.reduce((s, r) => s + r.messages,    0),
      totalConversations: rows.length,
      cachedTokens: rows.reduce((s, r) => s + r.cachedTokens, 0),
    };

    return reply.send({ success: true, data: { global, conversations: rows } });
  });
};
