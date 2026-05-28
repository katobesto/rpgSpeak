import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { UserRepository } from './user.repository.js';
import { requireAdmin } from '../../middleware/auth.js';
import { ValidationError, NotFoundError } from '../../shared/errors.js';

const repo = new UserRepository();

const createSchema = z.object({
  username:    z.string().min(2).max(40).regex(/^[a-zA-Z0-9_.-]+$/, 'Solo letras, números y _ . -'),
  password:    z.string().min(4).max(100),
  displayName: z.string().min(1).max(80),
  role:        z.enum(['admin', 'user']),
});

const updateSchema = z.object({
  username:    z.string().min(2).max(40).regex(/^[a-zA-Z0-9_.-]+$/, 'Solo letras, números y _ . -').optional(),
  password:    z.string().min(4).max(100).optional(),
  displayName: z.string().min(1).max(80).optional(),
  role:        z.enum(['admin', 'user']).optional(),
});

export const userRoutes: FastifyPluginAsync = async (app) => {
  // All user-management routes require admin
  app.addHook('preHandler', requireAdmin);

  // GET /api/users
  app.get('/', async () => {
    return { success: true, data: repo.findAll() };
  });

  // GET /api/users/:id
  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const user = repo.findById(id);
    if (!user) throw new NotFoundError('Usuario no encontrado');
    return { success: true, data: user };
  });

  // POST /api/users
  app.post('/', async (req, reply) => {
    const result = createSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);

    const existing = repo.findByUsername(result.data.username);
    if (existing) {
      return reply.status(409).send({
        success: false,
        error: 'USERNAME_TAKEN',
        message: 'El nombre de usuario ya existe',
        statusCode: 409,
      });
    }

    const user = repo.create(result.data);
    return reply.status(201).send({ success: true, data: user });
  });

  // PATCH /api/users/:id
  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = updateSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);

    // Prevent username collision
    if (result.data.username) {
      const existing = repo.findByUsername(result.data.username);
      if (existing && existing.id !== id) {
        return reply.status(409).send({
          success: false,
          error: 'USERNAME_TAKEN',
          message: 'Ese nombre de usuario ya está en uso',
          statusCode: 409,
        });
      }
    }

    // Prevent removing the last admin
    if (result.data.role === 'user') {
      const all = repo.findAll();
      const admins = all.filter(u => u.role === 'admin' && u.id !== id);
      if (admins.length === 0) {
        throw new ValidationError('Debe existir al menos un administrador');
      }
    }

    const user = repo.update(id, result.data);
    if (!user) throw new NotFoundError('Usuario no encontrado');
    return { success: true, data: user };
  });

  // PATCH /api/users/:id/active
  app.patch('/:id/active', async (req) => {
    const { id } = req.params as { id: string };
    const { active } = req.body as { active: boolean };

    // Cannot deactivate yourself
    if (id === (req as any).authUser?.userId) {
      throw new ValidationError('No puedes desactivar tu propia cuenta');
    }

    const user = repo.setActive(id, Boolean(active));
    if (!user) throw new NotFoundError('Usuario no encontrado');
    return { success: true, data: user };
  });

  // GET /api/users/:id/characters  — assigned character IDs
  app.get('/:id/characters', async (req) => {
    const { id } = req.params as { id: string };
    return { success: true, data: { characterIds: repo.getAssignedCharacterIds(id) } };
  });

  // PUT /api/users/:id/characters  — replace full assignment
  app.put('/:id/characters', async (req) => {
    const { id } = req.params as { id: string };
    const { characterIds } = req.body as { characterIds: unknown };
    if (!Array.isArray(characterIds)) throw new ValidationError('characterIds debe ser un array');
    repo.setAssignedCharacters(id, characterIds as string[]);
    return { success: true, data: { characterIds } };
  });

  // GET /api/users/:id/stories  — assigned story IDs
  app.get('/:id/stories', async (req) => {
    const { id } = req.params as { id: string };
    return { success: true, data: { storyIds: repo.getAssignedStoryIds(id) } };
  });

  // PUT /api/users/:id/stories  — replace full assignment
  app.put('/:id/stories', async (req) => {
    const { id } = req.params as { id: string };
    const { storyIds } = req.body as { storyIds: unknown };
    if (!Array.isArray(storyIds)) throw new ValidationError('storyIds debe ser un array');
    repo.setAssignedStories(id, storyIds as string[]);
    return { success: true, data: { storyIds } };
  });

  // DELETE /api/users/:id
  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };

    if (id === 'user-admin') {
      return reply.status(403).send({
        success: false,
        error: 'FORBIDDEN',
        message: 'El usuario admin principal no puede eliminarse',
        statusCode: 403,
      });
    }

    if (id === (req as any).authUser?.userId) {
      throw new ValidationError('No puedes eliminar tu propia cuenta');
    }

    repo.delete(id);
    return reply.status(204).send();
  });
};
