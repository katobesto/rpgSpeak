import type { FastifyPluginAsync } from 'fastify';
import { StoryService } from './story.service.js';
import { createStorySchema, updateStorySchema } from './story.schema.js';
import { ValidationError, ForbiddenError } from '../../shared/errors.js';

const service = new StoryService();

export const storyRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const { search, characterId } = req.query as { search?: string; characterId?: string };
    const { userId, role } = (req as any).authUser ?? {};
    return { success: true, data: service.list(search, userId, role === 'admin', characterId) };
  });

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    return { success: true, data: service.get(req.params.id) };
  });

  app.post('/', async (req, reply) => {
    const result = createStorySchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const { userId } = (req as any).authUser ?? {};
    return reply.status(201).send({ success: true, data: service.create(result.data, userId) });
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const result = updateStorySchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const { userId, role } = (req as any).authUser ?? {};
    const existing = service.get(req.params.id);
    if (existing.userId !== userId && role !== 'admin') {
      throw new ForbiddenError('No tienes permiso para editar esta historia');
    }
    return { success: true, data: service.update(req.params.id, result.data) };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { userId, role } = (req as any).authUser ?? {};
    const existing = service.get(req.params.id);
    if (existing.userId !== userId && role !== 'admin') {
      throw new ForbiddenError('No tienes permiso para eliminar esta historia');
    }
    service.delete(req.params.id);
    return reply.status(204).send();
  });
};
