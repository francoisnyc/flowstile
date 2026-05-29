import Fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { swaggerOptions } from './config/swagger.js';
import corsPlugin from './plugins/cors.js';
import csrfPlugin from './plugins/csrf.js';
import typeormPlugin from './plugins/typeorm.js';
import authPlugin from './plugins/auth.js';
import temporalPlugin from './plugins/temporal.js';
import signalRelayPlugin from './plugins/signal-relay.js';
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

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, swaggerOptions);

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  await app.register(corsPlugin);
  await app.register(rateLimit, { global: false });
  await app.register(typeormPlugin);
  await app.register(authPlugin);
  await app.register(csrfPlugin);
  await app.register(temporalPlugin);
  await app.register(signalRelayPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(groupRoutes);
  await app.register(formRoutes);
  await app.register(processRoutes);
  await app.register(taskRoutes);

  return app;
}
