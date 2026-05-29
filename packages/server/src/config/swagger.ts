import type { FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

// Shared @fastify/swagger options used by both the live server (app.ts) and the
// static spec generator (generate-openapi.ts). Keeping a single source prevents
// the two registrations from drifting — a past drift dropped `transform`, which
// leaked raw Zod metadata into the generated OpenAPI document.
export const swaggerOptions: FastifyDynamicSwaggerOptions = {
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
};
