import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ThreadRepository } from './thread.repository.js';
import { ConversationRepository } from '../conversations/conversation.repository.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';

const repo     = new ThreadRepository();
const convRepo = new ConversationRepository();

export const threadRoutes: FastifyPluginAsync = async (app) => {

  // GET /api/threads/:conversationId — todos los hilos, abiertos y cerrados.
  //
  // Devuelve también los cerrados porque el panel necesita ofrecer la reapertura:
  // el fallo más habitual del modelo no es dejar hilos colgados, es cerrarlos de
  // más al emitir [HILO_CERRADO] por un asunto que en realidad sigue vivo.
  app.get<{ Params: { conversationId: string } }>('/:conversationId', async (req, reply) => {
    const { conversationId } = req.params;
    if (!convRepo.findById(conversationId)) {
      throw new NotFoundError('Conversation', conversationId);
    }
    return reply.send({ success: true, data: repo.findByConversation(conversationId) });
  });

  // PATCH /api/threads/:id — editar redacción/importancia, cerrar o reabrir.
  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const schema = z.object({
      title:       z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      importance:  z.number().int().min(1).max(10).optional(),
      status:      z.enum(['open', 'closed']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0].message);
    if (Object.keys(parsed.data).length === 0) {
      throw new ValidationError('No hay nada que actualizar');
    }

    const existing = repo.findById(req.params.id);
    if (!existing) throw new NotFoundError('NarrativeThread', req.params.id);

    // Al cerrar a mano se sella con el mensaje actual de la conversación, igual
    // que hace el motor con la etiqueta del modelo. Sin esto el hilo quedaría
    // cerrado "en el mensaje en que se abrió" y el registro mentiría sobre
    // cuánto tiempo estuvo realmente pendiente.
    const closedAtIndex = convRepo.findById(existing.conversationId)?.messageCount;

    const updated = repo.update(req.params.id, { ...parsed.data, closedAtIndex });
    if (!updated) throw new NotFoundError('NarrativeThread', req.params.id);

    return reply.send({ success: true, data: updated });
  });

  // DELETE /api/threads/:id — borrar un hilo (duplicado, o abierto por error).
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    repo.delete(req.params.id);
    return reply.status(204).send();
  });
};
