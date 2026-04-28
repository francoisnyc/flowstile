import { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { User } from '../entities/user.entity.js';
import { UserStatus } from '../common/enums.js';
import { requireAuth } from '../plugins/auth.js';

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

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          skip: () => process.env.NODE_ENV === 'test',
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body as { email: string; password: string };

      const user = await app.db.getRepository(User).findOne({
        where: { email },
        relations: ['groups', 'roles'],
      });

      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        return reply.code(401).send({ error: 'Invalid credentials' });
      }
      if (user.status !== UserStatus.ACTIVE) {
        return reply.code(403).send({ error: 'Account is inactive' });
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

  app.post('/auth/logout', { preHandler: [requireAuth] }, async (_, reply) => {
    reply.clearCookie('flowstile_token', { path: '/' });
    return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: [requireAuth] }, async (request) => {
    return serializeUser(request.currentUser!);
  });
}
