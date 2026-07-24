import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { NoteRepository } from './note.repository.js';
import { ConversationRepository } from '../conversations/conversation.repository.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';

const repo     = new NoteRepository();
const convRepo = new ConversationRepository();

export const noteRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/notes/:conversationId — todas las notas, en orden de inyección.
  app.get<{ Params: { conversationId: string } }>('/:conversationId', async (req, reply) => {
    const { conversationId } = req.params;
    if (!convRepo.findById(conversationId)) {
      throw new NotFoundError('Conversation', conversationId);
    }
    return reply.send({ success: true, data: repo.findByConversation(conversationId) });
  });

  // POST /api/notes — crear una nota (se añade al final de la lista).
  app.post<{ Body: { conversationId: string; content: string } }>('/', async (req, reply) => {
    const schema = z.object({
      conversationId: z.string().min(1),
      content:        z.string().min(1).max(1000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
    if (!convRepo.findById(parsed.data.conversationId)) {
      throw new NotFoundError('Conversation', parsed.data.conversationId);
    }
    const note = repo.create(parsed.data.conversationId, parsed.data.content.trim());
    return reply.status(201).send({ success: true, data: note });
  });

  // PATCH /api/notes/reorder — nuevo orden completo tras arrastrar en la UI.
  // Va ANTES de /:id para que Fastify no intente matchear "reorder" como id.
  app.patch<{ Body: { conversationId: string; orderedIds: string[] } }>('/reorder', async (req, reply) => {
    const schema = z.object({
      conversationId: z.string().min(1),
      orderedIds:     z.array(z.string()).min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
    const notes = repo.reorder(parsed.data.conversationId, parsed.data.orderedIds);
    return reply.send({ success: true, data: notes });
  });

  // PATCH /api/notes/:id — editar el contenido de una nota.
  app.patch<{ Params: { id: string }; Body: { content?: string } }>('/:id', async (req, reply) => {
    const schema = z.object({ content: z.string().min(1).max(1000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);

    const updated = repo.update(req.params.id, parsed.data.content.trim());
    if (!updated) throw new NotFoundError('ConversationNote', req.params.id);
    return reply.send({ success: true, data: updated });
  });

  // DELETE /api/notes/:id
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    repo.delete(req.params.id);
    return reply.status(204).send();
  });
};
