import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { verifyToken } from '../modules/auth/auth.service.js';
import type { AuthPayload } from '@rpgspeak/shared';

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthPayload;
  }
}

/**
 * preHandler — validates Bearer token and attaches `req.authUser`.
 * Returns 401 if token is missing or invalid.
 */
export function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    reply.status(401).send({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Se requiere autenticación',
      statusCode: 401,
    });
    return;
  }

  try {
    req.authUser = verifyToken(header.slice(7));
    done();
  } catch {
    reply.status(401).send({
      success: false,
      error: 'INVALID_TOKEN',
      message: 'Token inválido o expirado',
      statusCode: 401,
    });
  }
}

/**
 * preHandler — requireAuth + admin role check.
 */
export function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  requireAuth(req, reply, () => {
    if (req.authUser?.role !== 'admin') {
      reply.status(403).send({
        success: false,
        error: 'FORBIDDEN',
        message: 'Se requieren permisos de administrador',
        statusCode: 403,
      });
      return;
    }
    done();
  });
}
