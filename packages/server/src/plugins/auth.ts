import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyJwt from '@fastify/jwt';
import { User } from '../entities/user.entity.js';

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: User | null;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { userId: string };
    user: { userId: string };
  }
}

export default fp(async (app: FastifyInstance) => {
  await app.register(fastifyCookie);
  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? 'flowstile-dev-jwt-secret-minimum-32-chars!!',
    cookie: { cookieName: 'flowstile_token', signed: false },
  });

  app.decorateRequest('currentUser', null);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
      const { userId } = request.user;
      const user = await app.db.getRepository(User).findOne({
        where: { id: userId },
        relations: ['groups', 'roles'],
      });
      if (user) request.currentUser = user;
    } catch {
      // No valid token — currentUser stays null
    }
  });
});

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.currentUser) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
}

export function requirePermission(permission: string) {
  return async function (request: FastifyRequest, reply: FastifyReply) {
    if (!request.currentUser) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    const granted = request.currentUser.roles.flatMap((r) => r.permissions);
    if (!granted.includes(permission)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  };
}
