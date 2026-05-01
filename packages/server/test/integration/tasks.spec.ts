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

describe('Task routes', () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;
  let taskDefId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const user = await createTestUser(app, { permissions: ['tasks:read', 'tasks:write'] });
    userId = user.id;
    cookie = await loginAs(app, user.email);

    const { taskDef } = await createTestTaskSetup(app);
    taskDefId = taskDef.id;
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  // Helper: create a fresh task via the API and return its id
  async function createTask(extra: Record<string, unknown> = {}) {
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: {
        taskDefinitionId: taskDefId,
        workflowId: `wf-${Date.now()}`,
        processInstanceId: `proc-${Date.now()}`,
        ...extra,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  describe('POST /tasks', () => {
    it('creates a task with status=created and locks the form version', async () => {
      const res = await authed(app, cookie, {
        method: 'POST',
        url: '/tasks',
        payload: {
          taskDefinitionId: taskDefId,
          workflowId: 'wf-create-test',
          priority: 'high',
          inputData: { CUSTOMER_ID: 'cust-1' },
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json<{
        status: string;
        priority: string;
        formDefinitionVersion: number;
        assigneeId: null;
      }>();
      expect(body.status).toBe('created');
      expect(body.priority).toBe('high');
      expect(body.formDefinitionVersion).toBe(1);
      expect(body.assigneeId).toBeNull();
    });

    it('returns 404 for unknown task definition', async () => {
      const res = await authed(app, cookie, {
        method: 'POST',
        url: '/tasks',
        payload: { taskDefinitionId: '00000000-0000-0000-0000-000000000000', workflowId: 'wf-x' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/tasks',
        payload: {
          taskDefinitionId: '00000000-0000-0000-0000-000000000000',
          workflowId: 'wf-unauth',
        },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /tasks/:id', () => {
    it('returns the task with a form schema attached', async () => {
      const id = await createTask();
      const res = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}` });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ id: string; form: { jsonSchema: unknown } }>();
      expect(body.id).toBe(id);
      expect(body.form).toBeDefined();
      expect(body.form.jsonSchema).toBeDefined();
    });

    it('returns 404 for unknown task', async () => {
      const res = await authed(app, cookie, {
        method: 'GET',
        url: '/tasks/00000000-0000-0000-0000-000000000000',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /tasks/:id/claim', () => {
    it('transitions status to claimed and sets assignee', async () => {
      const id = await createTask();
      const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; assigneeId: string }>();
      expect(body.status).toBe('claimed');
      expect(body.assigneeId).toBe(userId);
    });

    it('returns 409 when claiming an already-claimed task', async () => {
      const id = await createTask();
      await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('POST /tasks/:id/unclaim', () => {
    it('transitions status back to created and clears assignee', async () => {
      const id = await createTask();
      await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/unclaim` });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; assigneeId: null }>();
      expect(body.status).toBe('created');
      expect(body.assigneeId).toBeNull();
    });

    it('returns 409 when unclaiming a created task', async () => {
      const id = await createTask();
      const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/unclaim` });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('POST /tasks/:id/complete', () => {
    it('transitions to completed and saves submission data', async () => {
      const id = await createTask();
      await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      const res = await authed(app, cookie, {
        method: 'POST',
        url: `/tasks/${id}/complete`,
        payload: { data: { DECISION: 'APPROVED', NOTES: 'Looks good' } },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{
        status: string;
        completedAt: string;
        submissionData: Record<string, unknown>;
      }>();
      expect(body.status).toBe('completed');
      expect(body.completedAt).not.toBeNull();
      expect(body.submissionData.DECISION).toBe('APPROVED');
    });

    it('returns 409 when completing a created (unclaimed) task', async () => {
      const id = await createTask();
      const res = await authed(app, cookie, {
        method: 'POST',
        url: `/tasks/${id}/complete`,
        payload: { data: {} },
      });
      expect(res.statusCode).toBe(409);
    });

    it('returns 409 when completing an already-completed task', async () => {
      const id = await createTask();
      await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      await authed(app, cookie, {
        method: 'POST',
        url: `/tasks/${id}/complete`,
        payload: { data: { DECISION: 'APPROVED' } },
      });
      const res = await authed(app, cookie, {
        method: 'POST',
        url: `/tasks/${id}/complete`,
        payload: { data: {} },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('POST /tasks/:id/cancel', () => {
    it('cancels a created task', async () => {
      const id = await createTask();
      const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/cancel` });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('cancelled');
    });

    it('cancels a claimed task', async () => {
      const id = await createTask();
      await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/cancel` });

      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('cancelled');
    });

    it('returns 409 when cancelling a completed task', async () => {
      const id = await createTask();
      await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      await authed(app, cookie, {
        method: 'POST',
        url: `/tasks/${id}/complete`,
        payload: { data: { DECISION: 'APPROVED' } },
      });
      const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/cancel` });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('GET /tasks', () => {
    it('filters by status', async () => {
      const id = await createTask();

      const created = await authed(app, cookie, {
        method: 'GET',
        url: '/tasks?status=created',
      });
      const ids = created.json<{ items: { id: string }[] }>().items.map((t) => t.id);
      expect(ids).toContain(id);

      const completed = await authed(app, cookie, {
        method: 'GET',
        url: '/tasks?status=completed',
      });
      expect(completed.json<{ items: { id: string }[] }>().items.map((t) => t.id)).not.toContain(id);
    });
  });
});
