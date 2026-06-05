import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { MemoryRepository } from '../../core/memory/memory.repository.js';
import { ValidationError } from '../../shared/errors.js';

const repo = new MemoryRepository();

export const memoriesRoutes: FastifyPluginAsync = async (app) => {

  // GET /memories?conversationId=X[&characterId=Y]
  app.get<{ Querystring: { conversationId?: string; characterId?: string } }>('/', async (req) => {
    const { conversationId, characterId } = req.query;
    if (!conversationId) throw new ValidationError('conversationId is required');
    const entries = repo.findByConversation(conversationId, characterId);
    return { success: true, data: entries };
  });

  // POST /memories — create manually
  app.post('/', async (req, reply) => {
    const schema = z.object({
      conversationId: z.string(),
      characterId:    z.string(),
      type:           z.enum(['fact', 'event', 'relationship', 'preference', 'summary', 'offense', 'trauma']),
      content:        z.string().min(1).max(1000),
      importance:     z.number().int().min(1).max(10).default(5),
    });
    const result = schema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const entry = repo.create({ ...result.data, isActive: true });
    return reply.status(201).send({ success: true, data: entry });
  });

  // PATCH /memories/:id — actualizar contenido, tipo o importancia
  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const schema = z.object({
      content:    z.string().min(1).max(1000).optional(),
      type:       z.enum(['fact', 'event', 'relationship', 'preference', 'summary', 'offense', 'trauma']).optional(),
      importance: z.number().int().min(1).max(10).optional(),
    });
    const result = schema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const updated = repo.update(req.params.id, result.data);
    if (!updated) return reply.status(404).send({ success: false, error: 'Memory not found' });
    return reply.send({ success: true, data: updated });
  });

  // DELETE /memories/:id — soft-delete (deactivate)
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    repo.deactivate(req.params.id);
    return reply.status(204).send();
  });
};
