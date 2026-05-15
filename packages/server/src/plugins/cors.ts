import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';

export default fp(async (app: FastifyInstance) => {
  const raw = process.env.CORS_ORIGINS ?? '';
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    // No origins configured — same-origin only (current behavior preserved)
    return;
  }

  await app.register(fastifyCors, {
    origin: origins,
    credentials: true,
  });
});
