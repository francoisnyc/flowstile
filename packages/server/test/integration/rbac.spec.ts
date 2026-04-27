import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  createTestUser,
  loginAs,
  authed,
  createTestTaskSetup,
  cleanupTestData,
} from './helpers.js';

describe('RBAC permission enforcement', () => {
  let app: FastifyInstance;
  let taskDefId: string;
  let taskId: string;

  // Cookies for users with specific single permissions
  let taskReadCookie: string;
  let formsWriteCookie: string;
  let noPermCookie: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const { taskDef } = await createTestTaskSetup(app);
    taskDefId = taskDef.id;

    // Create a task via DB shortcut so we have an id to test GET /tasks/:id
    const fullUser = await createTestUser(app, { permissions: ['tasks:read', 'tasks:write'] });
    const fullCookie = await loginAs(app, fullUser.email);
    const res = await authed(app, fullCookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: taskDefId, workflowId: `wf-rbac-${Date.now()}` },
    });
    taskId = res.json<{ id: string }>().id;

    const taskReadUser = await createTestUser(app, { permissions: ['tasks:read'] });
    taskReadCookie = await loginAs(app, taskReadUser.email);

    const formsUser = await createTestUser(app, { permissions: ['forms:write'] });
    formsWriteCookie = await loginAs(app, formsUser.email);

    const noPermUser = await createTestUser(app);
    noPermCookie = await loginAs(app, noPermUser.email);
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  describe('tasks:read permission', () => {
    it('allows GET /tasks', async () => {
      const res = await authed(app, taskReadCookie, { method: 'GET', url: '/tasks' });
      expect(res.statusCode).toBe(200);
    });

    it('allows GET /tasks/:id', async () => {
      const res = await authed(app, taskReadCookie, { method: 'GET', url: `/tasks/${taskId}` });
      expect(res.statusCode).toBe(200);
    });

    it('rejects POST /tasks with 403', async () => {
      const res = await authed(app, taskReadCookie, {
        method: 'POST',
        url: '/tasks',
        payload: { taskDefinitionId: taskDefId, workflowId: 'wf-rbac-denied' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects POST /tasks/:id/claim with 403', async () => {
      const res = await authed(app, taskReadCookie, {
        method: 'POST',
        url: `/tasks/${taskId}/claim`,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('tasks:write permission', () => {
    it('rejects GET /tasks without tasks:read (403)', async () => {
      const writeOnlyUser = await createTestUser(app, { permissions: ['tasks:write'] });
      const cookie = await loginAs(app, writeOnlyUser.email);
      const res = await authed(app, cookie, { method: 'GET', url: '/tasks' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('forms:write permission', () => {
    it('rejects POST /forms for user with only tasks:read (403)', async () => {
      const res = await authed(app, taskReadCookie, {
        method: 'POST',
        url: '/forms',
        payload: { code: `RBAC_DENIED_${Date.now()}`, jsonSchema: { type: 'object' } },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects GET /forms/:code/versions for user with only tasks:read (403)', async () => {
      // forms:write is needed to see version history
      const res = await authed(app, taskReadCookie, {
        method: 'GET',
        url: '/forms/NONEXISTENT/versions',
      });
      expect(res.statusCode).toBe(403);
    });

    it('allows GET /forms for any authenticated user', async () => {
      // read-only form list requires only authentication
      const res = await authed(app, taskReadCookie, { method: 'GET', url: '/forms' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('users:manage permission', () => {
    it('rejects GET /users for user with tasks:write (403)', async () => {
      const res = await authed(app, taskReadCookie, { method: 'GET', url: '/users' });
      expect(res.statusCode).toBe(403);
    });

    it('rejects GET /groups for user with no permissions (403)', async () => {
      const res = await authed(app, noPermCookie, { method: 'GET', url: '/groups' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('unauthenticated requests', () => {
    it('returns 401 (not 403) for protected routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/tasks' });
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 for forms write routes', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/forms',
        payload: { code: 'X', jsonSchema: {} },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
