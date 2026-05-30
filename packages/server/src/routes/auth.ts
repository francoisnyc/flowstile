import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import bcrypt from 'bcrypt';
import { User } from '../entities/user.entity.js';
import { ApiKey } from '../entities/api-key.entity.js';
import { UserStatus } from '../common/enums.js';
import { requireAuth, requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { generateApiKeyToken, hashApiKey } from '../common/api-keys.js';

function serializeUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    roles: user.roles.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions })),
    groups: user.groups.map((g) => ({ id: g.id, name: g.name })),
  };
}

// Metadata view of an API key — never includes the token or its hash.
function serializeApiKey(key: ApiKey) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    permissions: key.permissions,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    createdAt: key.createdAt,
  };
}

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const PERMISSION_VALUES = Object.values(Permissions) as [string, ...string[]];

const CreateApiKeyBody = z.object({
  name: z.string().min(1),
  permissions: z.array(z.enum(PERMISSION_VALUES)).min(1),
  expiresAt: z.coerce.date().optional(),
});

const ApiKeyParam = z.object({ id: z.string().uuid() });

// A valid bcrypt hash (of a throwaway string) compared against when no user is
// found, so a failed login costs the same whether or not the email exists.
// Without it, bcrypt's short-circuit leaks account existence via response time.
const DUMMY_PASSWORD_HASH = '$2b$10$ib8NPkmGSp69LgQqZ7Zp4Oow.knaijYVIcNO6rucmR85.8q/XTHVq';

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/auth/login',
    {
      schema: { body: LoginBody, tags: ['Auth'] },
      config: {
        rateLimit: {
          max: process.env.NODE_ENV === 'production' ? 5 : 1000,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const user = await app.db.getRepository(User).findOne({
        where: { email },
        relations: ['groups', 'roles'],
      });

      // Always run bcrypt — against a dummy hash when the user is absent — so the
      // timing of a rejected login doesn't reveal whether the email exists.
      const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
      if (!user || !passwordMatches || user.status !== UserStatus.ACTIVE) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }

      const token = app.jwt.sign({ userId: user.id }, { expiresIn: '7d' });
      reply.setCookie('flowstile_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 7 * 24 * 60 * 60,
      });

      return serializeUser(user);
    },
  );

  app.post('/auth/logout', { preHandler: [requireAuth], schema: { tags: ['Auth'] } }, async (_, reply) => {
    reply.clearCookie('flowstile_token', { path: '/' });
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: [requireAuth], schema: { tags: ['Auth'] } }, async (request) => {
    if (request.currentUser) return serializeUser(request.currentUser);
    // Service principal (API key): no user record to serialize.
    const p = request.principal!;
    return { kind: p.kind, id: p.id, displayName: p.displayName, permissions: p.permissions };
  });

  // --- API keys (machine/service credentials) ---
  // Managed by user administrators. The plaintext token is returned exactly once,
  // at creation; thereafter only metadata is retrievable.
  const manage = { preHandler: [requirePermission(Permissions.USERS_MANAGE)] };

  app.post(
    '/auth/api-keys',
    { ...manage, schema: { body: CreateApiKeyBody, tags: ['Auth'] } },
    async (request, reply) => {
      const { name, permissions, expiresAt } = request.body;

      const token = generateApiKeyToken();
      const key = await app.db.getRepository(ApiKey).save({
        name,
        keyHash: hashApiKey(token),
        prefix: token.slice(0, 12),
        permissions,
        expiresAt: expiresAt ?? null,
        createdById: request.currentUser?.id ?? null,
      });

      // The only response that ever contains the plaintext token.
      return reply.code(201).send({ ...serializeApiKey(key), token });
    },
  );

  app.get(
    '/auth/api-keys',
    { ...manage, schema: { tags: ['Auth'] } },
    async () => {
      const keys = await app.db.getRepository(ApiKey).find({ order: { createdAt: 'DESC' } });
      return keys.map(serializeApiKey);
    },
  );

  app.delete(
    '/auth/api-keys/:id',
    { ...manage, schema: { params: ApiKeyParam, tags: ['Auth'] } },
    async (request, reply) => {
      const { id } = request.params;
      const repo = app.db.getRepository(ApiKey);
      const key = await repo.findOne({ where: { id } });
      if (!key) return reply.code(404).send({ error: 'API key not found' });
      if (!key.revokedAt) {
        key.revokedAt = new Date();
        await repo.save(key);
      }
      return reply.code(204).send();
    },
  );
};
