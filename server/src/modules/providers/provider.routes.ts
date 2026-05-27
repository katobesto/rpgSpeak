import type { FastifyPluginAsync } from 'fastify';
import { ProviderService } from './provider.service.js';
import { AppError } from '../../shared/errors.js';

const service = new ProviderService();

export const providerRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () => ({ success: true, data: service.list() }));

  app.get<{ Params: { id: string } }>('/:id', async (req) => ({
    success: true, data: service.get(req.params.id),
  }));

  app.post('/', async (req, reply) => {
    try {
      const p = service.create(req.body);
      return reply.status(201).send({ success: true, data: p });
    } catch (err) {
      app.log.error({ err, body: req.body }, 'Failed to create provider');
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    try {
      const p = service.update(req.params.id, req.body);
      return reply.send({ success: true, data: p });
    } catch (err) {
      app.log.error({ err, body: req.body }, 'Failed to update provider');
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    service.delete(req.params.id);
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string } }>('/:id/models', async (req) => ({
    success: true, data: await service.listModels(req.params.id),
  }));

  app.get<{ Params: { id: string } }>('/:id/validate', async (req) => ({
    success: true, data: await service.validate(req.params.id),
  }));
};
