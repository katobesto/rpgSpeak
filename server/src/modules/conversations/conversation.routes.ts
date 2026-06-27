import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { ConversationService } from './conversation.service.js';
import { ConversationRepository } from './conversation.repository.js';
import { MessageRepository } from '../messages/message.repository.js';
import { createConversationSchema, updateConversationSchema, partyStateSchema } from './conversation.schema.js';
import { ValidationError, NotFoundError } from '../../shared/errors.js';
import { getDb } from '../../db/index.js';

const service = new ConversationService();
const convRepo = new ConversationRepository();
const msgRepo  = new MessageRepository();

export const conversationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { archived, search, characterId, storyId, filterUserId } =
      req.query as { archived?: string; search?: string; characterId?: string; storyId?: string; filterUserId?: string };
    const { userId, role } = (req as any).authUser ?? {};
    const isAdmin = role === 'admin';
    return {
      success: true,
      data: service.list({
        includeArchived: archived === 'true',
        userId,
        isAdmin,
        search,
        characterId,
        storyId,
        filterUserId: isAdmin ? filterUserId : undefined,
      }),
    };
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

  // PATCH /api/conversations/:id/location — set / clear the current scene location
  app.patch<{ Params: { id: string } }>('/:id/location', async (req, reply) => {
    const result = z.object({ location: z.string().max(300).nullable() }).safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const conv = convRepo.findById(req.params.id);
    if (!conv) throw new NotFoundError('Conversation', req.params.id);
    convRepo.updateLocation(req.params.id, result.data.location);
    return reply.send({ success: true, data: { location: result.data.location } });
  });

  // PATCH /api/conversations/:id/party-state — persist HP/energía/inventario del grupo (BattleModal)
  app.patch<{ Params: { id: string } }>('/:id/party-state', async (req, reply) => {
    const result = partyStateSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const conv = convRepo.findById(req.params.id);
    if (!conv) throw new NotFoundError('Conversation', req.params.id);

    const meta = (conv.metadata ?? {}) as Record<string, unknown>;
    const updated = convRepo.update(req.params.id, {
      metadata: { ...meta, partyState: result.data },
    });
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
  // Query params: filterUserId (admin only) — restrict results to a single user
  app.get('/stats', async (req, reply) => {
    const { userId, role } = (req as any).authUser ?? {};
    const isAdmin = role === 'admin';
    const { filterUserId } = req.query as { filterUserId?: string };

    // Single SQL query: conversations + user display name, filtered at DB level
    // Admin sees all (optionally filtered); non-admin sees only their own
    const db = getDb();
    type RawConvRow = {
      id: string; title: string; token_count: number; message_count: number;
      updated_at: string; is_archived: number; user_id: string | null; display_name: string | null;
    };

    const COLS = sql`c.id, c.title, c.token_count, c.message_count, c.updated_at, c.is_archived, c.user_id, u.display_name`;
    const FROM  = sql`FROM conversations c LEFT JOIN users u ON c.user_id = u.id`;

    let rawRows: RawConvRow[];
    if (isAdmin && filterUserId) {
      rawRows = db.all<RawConvRow>(sql`SELECT ${COLS} ${FROM} WHERE c.user_id = ${filterUserId} ORDER BY c.updated_at DESC`);
    } else if (isAdmin) {
      rawRows = db.all<RawConvRow>(sql`SELECT ${COLS} ${FROM} ORDER BY c.updated_at DESC`);
    } else {
      rawRows = db.all<RawConvRow>(sql`SELECT ${COLS} ${FROM} WHERE c.user_id = ${userId ?? ''} ORDER BY c.updated_at DESC`);
    }

    // Enrich with cached token sum from messages metadata
    const convRows = rawRows.map((row) => {
      const messages = msgRepo.findByConversation(row.id);
      let cachedTokens = 0;
      for (const m of messages) {
        if (m.role !== 'assistant') continue;
        const meta = m.metadata as Record<string, unknown> | null;
        if (meta?.cachedTokens && typeof meta.cachedTokens === 'number') {
          cachedTokens += meta.cachedTokens;
        }
      }
      return {
        id:           row.id,
        title:        row.title,
        tokens:       row.token_count,
        messages:     row.message_count,
        cachedTokens,
        updatedAt:    row.updated_at,
        isArchived:   Boolean(row.is_archived),
        userName:     row.display_name ?? null,
      };
    });

    // Global totals (reflect active filter)
    const global = {
      totalTokens:        convRows.reduce((s, r) => s + r.tokens,       0),
      totalMessages:      convRows.reduce((s, r) => s + r.messages,     0),
      totalConversations: convRows.length,
      cachedTokens:       convRows.reduce((s, r) => s + r.cachedTokens, 0),
    };

    return reply.send({ success: true, data: { global, conversations: convRows } });
  });
};
