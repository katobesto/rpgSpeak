import Fastify, { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyWebsocket from '@fastify/websocket';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __appDirname = path.dirname(fileURLToPath(import.meta.url));
// server/src/ → go up 2 levels to project root
const APP_PROJECT_ROOT = path.resolve(__appDirname, '../../');
import { AppError } from './shared/errors.js';
import { requireAuth, requireAdmin } from './middleware/auth.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { userRoutes } from './modules/users/user.routes.js';
import { characterRoutes } from './modules/characters/character.routes.js';
import { storyRoutes } from './modules/stories/story.routes.js';
import { conversationRoutes } from './modules/conversations/conversation.routes.js';
import { messageRoutes } from './modules/messages/message.routes.js';
import { providerRoutes } from './modules/providers/provider.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
import { generateRoutes } from './modules/generate/generate.routes.js';
import { ttsRoutes } from './modules/tts/tts.routes.js';
import { memoriesRoutes } from './modules/memories/memories.routes.js';
import { contextRoutes }  from './modules/context/context.routes.js';
import { chapterRoutes }      from './modules/chapters/chapter.routes.js';
import { storyScriptRoutes }  from './modules/chapters/story-script.routes.js';
import { backupRoutes }       from './modules/backup/backup.routes.js';
import { summariesRoutes }    from './modules/summaries/summaries.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.server.isDev
      ? {
          level: config.logging.level,
          transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } },
        }
      : { level: config.logging.level },
    // Increase keep-alive so long TTS synthesis requests don't get cut mid-flight
    connectionTimeout: 0,      // no connection timeout
    keepAliveTimeout: 300_000, // 5 min keep-alive
    // Raise body limit to 4 GB — needed for backup/restore uploads.
    // The default 1 MB limit blocks multipart uploads before @fastify/multipart
    // even gets a chance to parse the stream (causes 413 Payload Too Large).
    bodyLimit: 4 * 1024 * 1024 * 1024,
  });

  // ─── Plugins ────────────────────────────────────────────────────────────────
  await app.register(fastifyCors, {
    origin: config.cors.origin,
    credentials: true,
  });

  await app.register(fastifyMultipart, {
    // 4 GB ceiling — accommodates the backup/restore endpoint.
    // Individual character/image upload routes check file size themselves.
    limits: { fileSize: 4 * 1024 * 1024 * 1024 },
  });

  await app.register(fastifyWebsocket);

  // ─── Serve client build in production ───────────────────────────────────────
  if (!config.server.isDev) {
    await app.register(fastifyStatic, {
      root: path.resolve(process.cwd(), '../client/dist'),
      prefix: '/',
    });
  }

  // ─── API Routes ─────────────────────────────────────────────────────────────
  await app.register(
    async (api) => {
      // Public — no auth required
      await api.register(authRoutes, { prefix: '/auth' });

      // Protected zone — JWT required for every route inside
      await api.register(
        async (prot) => {
          // Hook must be registered BEFORE routes in Fastify
          prot.addHook('preHandler', requireAuth);

          await prot.register(userRoutes,         { prefix: '/users' });
          await prot.register(characterRoutes,    { prefix: '/characters' });
          await prot.register(storyRoutes,        { prefix: '/stories' });
          await prot.register(conversationRoutes, { prefix: '/conversations' });
          await prot.register(messageRoutes,      { prefix: '/messages' });
          await prot.register(providerRoutes,     { prefix: '/providers' });
          await prot.register(settingsRoutes,     { prefix: '/settings' });
          await prot.register(generateRoutes,     { prefix: '/generate' });
          await prot.register(ttsRoutes,          { prefix: '/tts' });
          await prot.register(memoriesRoutes,     { prefix: '/memories' });
          await prot.register(contextRoutes,      { prefix: '/context' });
          await prot.register(chapterRoutes,      { prefix: '/chapters' });
          await prot.register(storyScriptRoutes,  { prefix: '/story-script' });
          await prot.register(backupRoutes,       { prefix: '/backup' });
          await prot.register(summariesRoutes,    { prefix: '/summaries' });
        },
        { prefix: '' }
      );
    },
    { prefix: '/api' }
  );

  // ─── Serve character images ──────────────────────────────────────────────────
  app.get('/images/*', async (req, reply) => {
    const subpath = (req.params as Record<string, string>)['*'];
    const filePath = path.join(APP_PROJECT_ROOT, 'data', 'images', subpath);
    try {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return reply.header('Content-Type', mime).send(data);
    } catch {
      return reply.status(404).send({ error: 'Not found' });
    }
  });

  // ─── Health check ────────────────────────────────────────────────────────────
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

  // ─── Global error handler ────────────────────────────────────────────────────
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        success: false,
        error: error.code,
        message: error.message,
        statusCode: error.statusCode,
      });
    }

    // Zod validation errors from Fastify schema
    if (error.validation) {
      return reply.status(400).send({
        success: false,
        error: 'VALIDATION_ERROR',
        message: error.message,
        statusCode: 400,
      });
    }

    app.log.error(error);
    return reply.status(500).send({
      success: false,
      error: 'INTERNAL_ERROR',
      message: config.server.isDev ? error.message : 'Internal server error',
      statusCode: 500,
    });
  });

  // ─── 404 fallback (SPA) ──────────────────────────────────────────────────────
  if (!config.server.isDev) {
    app.setNotFoundHandler((_request, reply) => {
      reply.sendFile('index.html');
    });
  }

  return app;
}
