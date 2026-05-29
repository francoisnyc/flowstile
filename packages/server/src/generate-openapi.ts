import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod';
import { stringify } from 'yaml';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { groupRoutes } from './routes/groups.js';
import { formRoutes } from './routes/forms.js';
import { processRoutes } from './routes/processes.js';
import { taskRoutes } from './routes/tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: false });

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
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Register routes without infrastructure plugins (DB, auth, Temporal).
  // Swagger only needs the route schemas, not working handlers.
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(userRoutes);
  await app.register(groupRoutes);
  await app.register(formRoutes);
  await app.register(processRoutes);
  await app.register(taskRoutes);

  await app.ready();

  const spec = app.swagger();
  // Round-trip through JSON to strip non-serializable values (e.g. functions)
  const cleanSpec = JSON.parse(JSON.stringify(spec));
  const yamlOutput = stringify(cleanSpec, { lineWidth: 120 });
  const outPath = resolve(__dirname, '..', '..', '..', 'docs', 'openapi.yaml');

  writeFileSync(outPath, yamlOutput, 'utf-8');
  console.log(`OpenAPI spec written to ${outPath}`);

  await app.close();
}

main().catch((err) => {
  console.error('Failed to generate OpenAPI spec:', err);
  process.exit(1);
});
