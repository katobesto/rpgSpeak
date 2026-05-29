import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { loginUser, getUserById, changePassword, updateProfile, updateAvatar, verifyToken } from './auth.service.js';
import { ValidationError, UnauthorizedError } from '../../shared/errors.js';
import { ProviderRepository } from '../providers/provider.repository.js';
import { SettingsService } from '../settings/settings.service.js';
import { createProvider } from '../../core/llm/provider.factory.js';
import type { GenerateRequest } from '@rpgspeak/shared';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(4, 'La nueva contraseña debe tener al menos 4 caracteres'),
});

const updateProfileSchema = z.object({
  displayName:    z.string().min(1, 'El nombre no puede estar vacío').max(50).optional(),
  appearance:     z.string().max(2000).optional(),
  narrationStyle: z.enum(['normal', 'medium', 'short']).optional(),
});

function isLocalhost(ip: string | undefined): boolean {
  if (!ip) return false;
  // Strip IPv6 prefix for IPv4-mapped addresses
  const clean = ip.replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

/** Extract + verify Bearer token from request, returns userId or throws. */
function requireAuth(req: { headers: Record<string, string | string[] | undefined> }): string {
  const authHeader = (req.headers.authorization as string | undefined) ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) throw new UnauthorizedError();
  try {
    const payload = verifyToken(token) as { userId: string };
    return payload.userId;
  } catch {
    throw new UnauthorizedError();
  }
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/auth/login  — public
  app.post('/login', async (req, reply) => {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);

    const { username, password } = result.data;
    const clientIp = req.headers['x-forwarded-for']?.toString().split(',')[0].trim()
      ?? req.socket.remoteAddress;

    const auth = loginUser(username, password, isLocalhost(clientIp));
    if (!auth) {
      return reply.status(401).send({
        success: false,
        error: 'INVALID_CREDENTIALS',
        message: 'Usuario o contraseña incorrectos',
        statusCode: 401,
      });
    }

    return reply.send({ success: true, data: auth });
  });

  // GET /api/auth/me  — requires token (validated by preHandler in app.ts)
  app.get('/me', async (req) => {
    const payload = (req as any).authUser as { userId: string } | undefined;
    if (!payload) throw new UnauthorizedError();

    const user = getUserById(payload.userId);
    if (!user) throw new UnauthorizedError();

    return { success: true, data: user };
  });

  // PUT /api/auth/password — change own password (requires token)
  app.put('/password', async (req, reply) => {
    const userId = requireAuth(req as any);

    const result = changePasswordSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);

    const { currentPassword, newPassword } = result.data;
    const ok = changePassword(userId, currentPassword, newPassword);
    if (!ok) {
      return reply.status(400).send({
        success: false,
        error: 'INVALID_PASSWORD',
        message: 'La contraseña actual es incorrecta',
        statusCode: 400,
      });
    }

    return reply.send({ success: true, data: { message: 'Contraseña actualizada correctamente' } });
  });

  // PATCH /api/auth/me — update profile fields
  app.patch('/me', async (req, reply) => {
    const userId = requireAuth(req as any);

    const result = updateProfileSchema.safeParse(req.body);
    if (!result.success) throw new ValidationError(result.error.issues[0].message);

    const updates: { displayName?: string; appearance?: string; narrationStyle?: string } = {};
    if (result.data.displayName    !== undefined) updates.displayName    = result.data.displayName.trim();
    if (result.data.appearance     !== undefined) updates.appearance     = result.data.appearance;
    if (result.data.narrationStyle !== undefined) updates.narrationStyle = result.data.narrationStyle;

    const auth = updateProfile(userId, updates);
    if (!auth) throw new UnauthorizedError();

    return reply.send({ success: true, data: auth });
  });

  // POST /api/auth/me/avatar — upload profile photo (multipart)
  app.post('/me/avatar', async (req, reply) => {
    const userId = requireAuth(req as any);

    const fileData = await req.file();
    if (!fileData) throw new ValidationError('No se recibió ningún archivo');

    const buffer = await fileData.toBuffer();
    const ext = path.extname(fileData.filename).toLowerCase() || '.jpg';
    const filename = `${uuidv4()}${ext}`;
    const dirPath = path.join(PROJECT_ROOT, 'data', 'images', 'users', userId);
    fs.mkdirSync(dirPath, { recursive: true });

    // Delete old avatar file if it exists
    const currentUser = getUserById(userId);
    if (currentUser?.avatar) {
      const oldPath = path.join(PROJECT_ROOT, 'data', 'images', currentUser.avatar.replace(/^\/images\//, ''));
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    fs.writeFileSync(path.join(dirPath, filename), buffer);
    const avatarPath = `/images/users/${userId}/${filename}`;

    const auth = updateAvatar(userId, avatarPath);
    if (!auth) throw new UnauthorizedError();

    return reply.status(201).send({ success: true, data: auth });
  });

  // DELETE /api/auth/me/avatar — remove profile photo
  app.delete('/me/avatar', async (req, reply) => {
    const userId = requireAuth(req as any);

    const user = getUserById(userId);
    if (user?.avatar) {
      const filePath = path.join(PROJECT_ROOT, 'data', 'images', user.avatar.replace(/^\/images\//, ''));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    const auth = updateAvatar(userId, null);
    if (!auth) throw new UnauthorizedError();

    return reply.send({ success: true, data: auth });
  });

  // POST /api/auth/me/generate-description — AI-generated appearance description
  // Takes the user's appearance text and optimises it into an SD-friendly prompt.
  app.post('/me/generate-description', async (req, reply) => {
    const userId = requireAuth(req as any);

    const user = getUserById(userId);
    if (!user) throw new UnauthorizedError();

    const settings = new SettingsService();
    const provRepo = new ProviderRepository();

    const defaultProviderId = settings.get('defaultProviderId') as string | null;
    const defaultModelId    = settings.get('defaultModelId')    as string | null;

    const providerRecord = defaultProviderId
      ? provRepo.findById(defaultProviderId)
      : provRepo.findAll()[0] ?? null;

    if (!providerRecord || !providerRecord.isEnabled) {
      throw new ValidationError('No hay un proveedor LLM configurado o habilitado.');
    }

    const modelId = defaultModelId ?? providerRecord.defaultModel;
    if (!modelId) {
      throw new ValidationError('No hay un modelo configurado. Ve a Settings y selecciona un modelo.');
    }

    const existingAppearance = user.appearance?.trim() || '';
    const prompt = `Eres un experto en generar prompts para generadores de imágenes IA (Stable Diffusion, Midjourney, DALL-E).

Basándote en la siguiente descripción de un usuario/jugador, genera un prompt detallado en inglés para un generador de imágenes que capture su apariencia física de forma consistente.

El prompt debe incluir:
- Rasgos faciales específicos (forma de cara, ojos, nariz, boca, expresión habitual)
- Color y estilo de cabello
- Complexión física y altura aproximada
- Atuendo característico (ropa, colores, materiales, accesorios)
- Rasgos distintivos (si los hay)
- Estilo artístico sugerido (realistic photography, portrait, etc.)

Formato de salida: Un único párrafo en inglés de 80-120 palabras, listo para usar directamente en un generador de imágenes.

DESCRIPCIÓN ACTUAL DEL USUARIO:
Nombre: ${user.displayName}
${existingAppearance ? `Apariencia: ${existingAppearance}` : '(sin descripción — inventa una apariencia genérica neutra y atractiva)'}

Responde SOLO con el prompt de imagen en inglés, sin explicaciones adicionales.`;

    const llm = createProvider(providerRecord);
    const request: GenerateRequest = {
      messages: [{ role: 'user', content: prompt }],
      model:    modelId,
      temperature: 0.7,
      stream: false,
    };

    const response = await llm.generate(request);
    return reply.send({ success: true, data: { description: response.content.trim() } });
  });
};
