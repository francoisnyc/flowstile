import Fastify, { FastifyInstance } from 'fastify';
import typeormPlugin from './plugins/typeorm.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  await app.register(typeormPlugin);

  return app;
}
