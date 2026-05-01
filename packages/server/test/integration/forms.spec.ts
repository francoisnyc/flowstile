import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createTestUser, loginAs, authed, cleanupTestData } from './helpers.js';

const BASE_SCHEMA = {
  type: 'object',
  properties: { AMOUNT: { type: 'number' } },
  required: ['AMOUNT'],
};
const BASE_UI = {
  type: 'VerticalLayout',
  elements: [{ type: 'Control', scope: '#/properties/AMOUNT' }],
};

describe('Form routes', () => {
  let app: FastifyInstance;
  let cookie: string;
  const formCode = `TEST_FORM_ROUTES_${Date.now()}`;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const user = await createTestUser(app, { permissions: ['forms:write'] });
    cookie = await loginAs(app, user.email);
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  describe('POST /forms', () => {
    it('creates a new form as draft v1', async () => {
      const res = await authed(app, cookie, {
        method: 'POST',
        url: '/forms',
        payload: { code: formCode, jsonSchema: BASE_SCHEMA, uiSchema: BASE_UI },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ code: string; version: number; status: string }>();
      expect(body.code).toBe(formCode);
      expect(body.version).toBe(1);
      expect(body.status).toBe('draft');
    });

    it('returns 409 when the code already exists', async () => {
      const res = await authed(app, cookie, {
        method: 'POST',
        url: '/forms',
        payload: { code: formCode, jsonSchema: BASE_SCHEMA },
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/forms',
        payload: { code: 'WHATEVER', jsonSchema: {} },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /forms/:code/draft', () => {
    it('updates the draft schema', async () => {
      const updated = {
        ...BASE_SCHEMA,
        properties: { ...BASE_SCHEMA.properties, DECISION: { type: 'string' } },
      };
      const res = await authed(app, cookie, {
        method: 'PUT',
        url: `/forms/${formCode}/draft`,
        payload: { jsonSchema: updated },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ jsonSchema: { properties: Record<string, unknown> } }>();
      expect(body.jsonSchema.properties).toHaveProperty('DECISION');
    });
  });

  describe('GET /forms/:code/versions', () => {
    it('returns the draft as the only version', async () => {
      const res = await authed(app, cookie, {
        method: 'GET',
        url: `/forms/${formCode}/versions`,
      });

      expect(res.statusCode).toBe(200);
      const versions = res.json<{ status: string }[]>();
      expect(versions).toHaveLength(1);
      expect(versions[0].status).toBe('draft');
    });
  });

  describe('POST /forms/:code/publish', () => {
    it('publishes the draft as v1, removing the draft row', async () => {
      const res = await authed(app, cookie, {
        method: 'POST',
        url: `/forms/${formCode}/publish`,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{ version: number; status: string }>();
      expect(body.version).toBe(1);
      expect(body.status).toBe('published');
    });

    it('returns 404 when no draft exists', async () => {
      const res = await authed(app, cookie, {
        method: 'POST',
        url: `/forms/${formCode}/publish`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /forms/:code', () => {
    it('returns the latest published version', async () => {
      const res = await authed(app, cookie, {
        method: 'GET',
        url: `/forms/${formCode}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ version: number; status: string }>();
      expect(body.version).toBe(1);
      expect(body.status).toBe('published');
    });
  });

  describe('second publish increments version', () => {
    it('creates draft → publishes → version becomes 2', async () => {
      // Create new draft (since the first one was published)
      await authed(app, cookie, {
        method: 'PUT',
        url: `/forms/${formCode}/draft`,
        payload: { jsonSchema: BASE_SCHEMA },
      });

      const res = await authed(app, cookie, {
        method: 'POST',
        url: `/forms/${formCode}/publish`,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json<{ version: number }>().version).toBe(2);

      // versions list should now have 2 published rows
      const versRes = await authed(app, cookie, {
        method: 'GET',
        url: `/forms/${formCode}/versions`,
      });
      const versions = versRes.json<{ status: string }[]>();
      expect(versions.filter((v) => v.status === 'published')).toHaveLength(2);
    });
  });

  describe('GET /forms', () => {
    it('includes the test form in the list', async () => {
      const res = await authed(app, cookie, { method: 'GET', url: '/forms' });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: { code: string }[] }>();
      expect(body.items.some((f) => f.code === formCode)).toBe(true);
    });
  });
});
