import type { FastifyPluginAsync } from 'fastify';
import { MessageService } from './message.service.js';
import { ValidationError } from '../../shared/errors.js';
import { z } from 'zod';

const service = new MessageService();

const createSchema = z.object({
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1),
  characterId: z.string().optional(),
  parentId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({ content: z.string().min(1) });

export const messageRoutes: FastifyPluginAsync = async (app) => {
  // GET /messages?conversationId=&branchId=
  app.get('/', async (req) => {
    const { conversationId, branchId } = req.query as { conversationId: string; branchId?: string };
    if (!conversationId) throw new ValidationError('conversationId is required');
    return { success: true, data: service.list(conversationId, branchId) };
  });

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    return { success: true, data: service.get(req.params.id) };
  });

  app.post('/', async (req, reply) => {
    const result = createSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const msg = service.create(result.data);
    return reply.status(201).send({ success: true, data: msg });
  });


  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const result = updateSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    return { success: true, data: service.update(req.params.id, result.data) };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    service.delete(req.params.id);
    return reply.status(204).send();
  });

  // POST /messages/:id/branch
  app.post<{ Params: { id: string } }>('/:id/branch', async (req) => {
    return { success: true, data: service.branch(req.params.id) };
  });
};
