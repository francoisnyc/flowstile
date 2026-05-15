import Fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import corsPlugin from './plugins/cors.js';
import csrfPlugin from './plugins/csrf.js';
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

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Flowstile API',
        version: '0.1.0',
        description:
          'Human-task inbox and form layer for Temporal.io workflows.\n\n' +
          'Authentication uses JWT tokens delivered as HttpOnly cookies (`flowstile_token`) ' +
          'or as Bearer tokens in the Authorization header.',
        license: { name: 'Apache-2.0' },
      },
      components: {
        securitySchemes: {
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'flowstile_token',
          },
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      },
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      tags: [
        { name: 'Health' },
        { name: 'Auth' },
        { name: 'Users' },
        { name: 'Groups' },
        { name: 'Forms' },
        { name: 'Processes' },
        { name: 'Tasks' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
  });

  await app.register(corsPlugin);
  await app.register(rateLimit, { global: false });
  await app.register(typeormPlugin);
  await app.register(authPlugin);
  await app.register(csrfPlugin);
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
