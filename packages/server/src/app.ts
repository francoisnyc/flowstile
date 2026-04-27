import Fastify, { FastifyInstance } from 'fastify';
import typeormPlugin from './plugins/typeorm.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  await app.register(typeormPlugin);
  await app.register(healthRoutes);

  return app;
}
