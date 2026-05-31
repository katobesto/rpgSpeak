import type { FastifyPluginAsync } from 'fastify';
import { CharacterService } from './character.service.js';
import { createCharacterSchema, updateCharacterSchema } from './character.schema.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../../shared/errors.js';
import { SettingsService } from '../settings/settings.service.js';
import { createImageProvider } from '../../core/image/image-provider.factory.js';

const service = new CharacterService();

export const characterRoutes: FastifyPluginAsync = async (app) => {
  // GET /characters
  app.get('/', async (req) => {
    const { search, storyId } = req.query as { search?: string; storyId?: string };
    const { userId, role } = (req as any).authUser ?? {};
    const items = service.list(search, userId, role === 'admin', storyId);
    return { success: true, data: items };
  });

  // GET /characters/:id
  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const character = service.get(req.params.id);
    return { success: true, data: character };
  });

  // POST /characters
  app.post('/', async (req, reply) => {
    const result = createCharacterSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const { userId } = (req as any).authUser ?? {};
    const character = service.create(result.data, userId);
    return reply.status(201).send({ success: true, data: character });
  });

  // PATCH /characters/:id
  app.patch<{ Params: { id: string } }>('/:id', async (req) => {
    const result = updateCharacterSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const { userId, role } = (req as any).authUser ?? {};
    const existing = service.get(req.params.id);
    if (existing.userId !== userId && role !== 'admin') {
      throw new ForbiddenError('No tienes permiso para editar este personaje');
    }
    const character = service.update(req.params.id, result.data);
    return { success: true, data: character };
  });

  // DELETE /characters/:id
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const { userId, role } = (req as any).authUser ?? {};
    const existing = service.get(req.params.id);
    if (existing.userId !== userId && role !== 'admin') {
      throw new ForbiddenError('No tienes permiso para eliminar este personaje');
    }
    service.delete(req.params.id);
    return reply.status(204).send();
  });

  // POST /characters/:id/duplicate
  app.post<{ Params: { id: string } }>('/:id/duplicate', async (req, reply) => {
    const { userId, role } = (req as any).authUser ?? {};
    const existing = service.get(req.params.id);
    if (existing.userId !== userId && role !== 'admin') {
      throw new ForbiddenError('No tienes permiso para duplicar este personaje');
    }
    const character = service.duplicate(req.params.id);
    return reply.status(201).send({ success: true, data: character });
  });

  // POST /characters/import
  app.post('/import', async (req, reply) => {
    const result = createCharacterSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);
    const character = service.create(result.data);
    return reply.status(201).send({ success: true, data: character });
  });

  // POST /characters/:id/generate-description
  app.post<{ Params: { id: string } }>('/:id/generate-description', async (req) => {
    const { providerId, modelId } = (req.body ?? {}) as { providerId?: string; modelId?: string };
    const result = await service.generateImageDescription(req.params.id, { providerId, modelId });
    return { success: true, data: result };
  });

  // POST /characters/:id/images  (multipart/form-data)
  app.post<{ Params: { id: string } }>('/:id/images', async (req, reply) => {
    const fileData = await req.file();
    if (!fileData) throw new ValidationError('No file provided');
    const buffer = await fileData.toBuffer();
    const { setAsAvatar } = req.query as { setAsAvatar?: string };
    const character = service.addImage(
      req.params.id,
      buffer.toString('base64'),
      fileData.filename,
      setAsAvatar === 'true',
    );
    return reply.status(201).send({ success: true, data: character });
  });

  // DELETE /characters/:id/images
  app.delete<{ Params: { id: string } }>('/:id/images', async (req) => {
    const { path: imgPath } = req.body as { path: string };
    if (!imgPath) throw new ValidationError('path is required');
    const character = service.removeImage(req.params.id, imgPath);
    return { success: true, data: character };
  });

  // POST /characters/:id/generate-comfy
  // Genera una imagen usando el workflow de ComfyUI y la añade a la galería
  app.post<{ Params: { id: string } }>('/:id/generate-comfy', async (req, reply) => {
    const character = service.get(req.params.id);
    if (!character) throw new NotFoundError('Character', req.params.id);

    const prompt = character.imageDescription?.trim();
    if (!prompt) {
      throw new ValidationError(
        'El personaje no tiene descripción de imagen. Genera o escribe una en la pestaña Apariencia primero.',
      );
    }

    const { workflowName } = (req.body ?? {}) as { workflowName?: string };
    const workflow = workflowName ?? 'image_z_image_turbo';

    const settingsService = new SettingsService();
    const imageProvider = createImageProvider(settingsService.getAll());
    const { buffer, filename } = await imageProvider.generate({ prompt, workflowName: workflow });

    const base64 = buffer.toString('base64');
    const updated = service.addImage(req.params.id, base64, filename, false);

    return reply.status(201).send({ success: true, data: updated });
  });
};
