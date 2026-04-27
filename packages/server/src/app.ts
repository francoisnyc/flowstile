import Fastify, { FastifyInstance } from 'fastify';
import typeormPlugin from './plugins/typeorm.js';
import authPlugin from './plugins/auth.js';
import temporalPlugin from './plugins/temporal.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { groupRoutes } from './routes/groups.js';
import { formRoutes } from './routes/forms.js';
import { processRoutes } from './routes/processes.js';
import { taskRoutes } from './routes/tasks.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  });

  await app.register(typeormPlugin);
  await app.register(authPlugin);
  await app.register(temporalPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(groupRoutes);
  await app.register(formRoutes);
  await app.register(processRoutes);
  await app.register(taskRoutes);

  return app;
}
