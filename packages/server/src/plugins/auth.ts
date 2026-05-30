import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import { User } from '../entities/user.entity.js';
import { ApiKey } from '../entities/api-key.entity.js';
import { UserStatus } from '../common/enums.js';
import { hashApiKey, looksLikeApiKey } from '../common/api-keys.js';

// The authenticated actor on a request. Either a human (user-backed, with the
// full User entity attached) or a machine (service-backed, from an API key).
// Route handlers that need a human inspect `user`; permission checks use
// `permissions`, which is uniform across both kinds.
export interface AuthPrincipal {
  kind: 'user' | 'service';
  // userId for human principals, api key id for service principals.
  id: string;
  displayName: string;
  permissions: string[];
  // Populated only for human principals. Null for service principals.
  user: User | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: User | null;
    principal: AuthPrincipal | null;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { userId: string };
    user: { userId: string };
  }
}

// Pulls a Flowstile API key from the request, if present. Accepts either an
// X-API-Key header or an Authorization: Bearer <token> whose token carries the
// API-key prefix. Returns null when the request carries no API key (e.g. a JWT).
function extractApiKey(request: FastifyRequest): string | null {
  const headerKey = request.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.length > 0) return headerKey;
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    if (looksLikeApiKey(token)) return token;
  }
  return null;
}

// Resolves a raw API key token to a service principal, or null if the token is
// unknown, revoked, or expired. Touches lastUsedAt as a fire-and-forget side
// effect so a slow update never delays the request.
async function authenticateApiKey(
  app: FastifyInstance,
  token: string,
): Promise<AuthPrincipal | null> {
  const repo = app.db.getRepository(ApiKey);
  const key = await repo.findOne({ where: { keyHash: hashApiKey(token) } });
  if (!key) return null;
  if (key.revokedAt) return null;
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) return null;

  repo.update({ id: key.id }, { lastUsedAt: new Date() }).catch(() => {
    // Best-effort usage tracking — never fail auth on a metadata write.
  });

  return {
    kind: 'service',
    id: key.id,
    displayName: key.name,
    permissions: key.permissions,
    user: null,
  };
}

export default fp(async (app: FastifyInstance) => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET env var must be set');
  }

  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: jwtSecret,
    cookie: { cookieName: 'flowstile_token', signed: false },
    verify: {
      extractToken: (request: FastifyRequest) => {
        // Cookie first (browser), then Authorization header (SDK/service)
        const cookie = request.cookies?.flowstile_token;
        if (cookie) return cookie;
        const auth = request.headers.authorization;
        if (auth?.startsWith('Bearer ')) return auth.slice(7);
        return undefined;
      },
    },
  });

  app.decorateRequest('currentUser', null);
  app.decorateRequest('principal', null);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    // API key path takes precedence: a service credential is presented as either
    // X-API-Key or a prefixed Bearer token, and must not be run through jwtVerify.
    const apiKeyToken = extractApiKey(request);
    if (apiKeyToken) {
      const principal = await authenticateApiKey(app, apiKeyToken);
      if (principal) {
        request.principal = principal;
        request.currentUser = null;
      }
      // Unknown/revoked/expired key → request stays unauthenticated.
      return;
    }

    // JWT path (browser cookie or human Bearer token).
    try {
      await request.jwtVerify();
      const { userId } = request.user;
      const user = await app.db.getRepository(User).findOne({
        where: { id: userId },
        relations: ['groups', 'roles'],
      });
      if (user && user.status === UserStatus.ACTIVE) {
        request.currentUser = user;
        request.principal = {
          kind: 'user',
          id: user.id,
          displayName: user.displayName,
          permissions: user.roles.flatMap((r) => r.permissions),
          user,
        };
      }
    } catch {
      // No valid token — principal/currentUser stay null
    }
  });
});

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.principal) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

export function requirePermission(permission: string) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.principal) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    if (!request.principal.permissions.includes(permission)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  };
}

// Guard for handlers that fundamentally require a human user (e.g. claiming a
// task, reading a visibility-filtered form). Returns the User, or sends 403 and
// returns null when the caller is a service principal.
export function requireUser(request: FastifyRequest, reply: FastifyReply): User | null {
  if (!request.currentUser) {
    reply.code(403).send({ error: 'This action requires a user account' });
    return null;
  }
  return request.currentUser;
}
