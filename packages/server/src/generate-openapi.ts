import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { stringify } from 'yaml';
import { swaggerOptions } from './config/swagger.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { userRoutes } from './routes/users.js';
import { groupRoutes } from './routes/groups.js';
import { formRoutes } from './routes/forms.js';
import { processRoutes } from './routes/processes.js';
import { taskRoutes } from './routes/tasks.js';
import { attachmentRoutes } from './routes/attachments.js';
import { caseRoutes } from './routes/cases.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({ logger: false });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(swagger, swaggerOptions);

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
  await app.register(attachmentRoutes);
  await app.register(caseRoutes);

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
