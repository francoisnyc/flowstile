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

  describe('GET /tasks/:id — actions', () => {
    type Actions = {
      canClaim: boolean;
      canUnclaim: boolean;
      canComplete: boolean;
      canCancel: boolean;
    };

    it('unassigned created task: canClaim true, canUnclaim false, canComplete false, canCancel true', async () => {
      const id = await createTask();
      const res = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}` });
      expect(res.statusCode).toBe(200);
      const { actions } = res.json<{ actions: Actions }>();
      expect(actions.canClaim).toBe(true);
      expect(actions.canUnclaim).toBe(false);
      expect(actions.canComplete).toBe(false);
      expect(actions.canCancel).toBe(true);
    });

    it('claimed task viewed by assignee: canClaim false, canUnclaim true, canComplete true, canCancel true', async () => {
      const id = await createTask();
      await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      const res = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}` });
      expect(res.statusCode).toBe(200);
      const { actions } = res.json<{ actions: Actions }>();
      expect(actions.canClaim).toBe(false);
      expect(actions.canUnclaim).toBe(true);
      expect(actions.canComplete).toBe(true);
      expect(actions.canCancel).toBe(true);
    });

    it('completed task: all actions false', async () => {
      const id = await createTask();
      await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      await authed(app, cookie, {
        method: 'POST',
        url: `/tasks/${id}/complete`,
        payload: { data: { DECISION: 'APPROVED' } },
      });
      const res = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}` });
      expect(res.statusCode).toBe(200);
      const { actions } = res.json<{ actions: Actions }>();
      expect(actions.canClaim).toBe(false);
      expect(actions.canUnclaim).toBe(false);
      expect(actions.canComplete).toBe(false);
      expect(actions.canCancel).toBe(false);
    });

    it('claimed task viewed by non-assignee without tasks:manage: canUnclaim false, canComplete false', async () => {
      // Create a second user (write perms) and claim the task as them
      const claimUser = await createTestUser(app, { permissions: ['tasks:read', 'tasks:write'] });
      const claimCookie = await loginAs(app, claimUser.email);

      const id = await createTask();
      // claim as claimUser
      await authed(app, claimCookie, { method: 'POST', url: `/tasks/${id}/claim` });

      // view as the main user (not the assignee, no tasks:manage)
      const res = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}` });
      expect(res.statusCode).toBe(200);
      const { actions } = res.json<{ actions: Actions }>();
      expect(actions.canUnclaim).toBe(false);
      expect(actions.canComplete).toBe(false);
    });

    it('user without tasks:write: canClaim false, canCancel false', async () => {
      const readUser = await createTestUser(app, { permissions: ['tasks:read'] });
      const readCookie = await loginAs(app, readUser.email);

      const id = await createTask();
      const res = await authed(app, readCookie, { method: 'GET', url: `/tasks/${id}` });
      expect(res.statusCode).toBe(200);
      const { actions } = res.json<{ actions: Actions }>();
      expect(actions.canClaim).toBe(false);
      expect(actions.canCancel).toBe(false);
    });
  });

  describe('POST /tasks/:id/complete — writable-field stripping', () => {
    it('silently strips fields marked readOnly in visibility rules', async () => {
      // Create a form with NOTES marked readOnly
      const tag = `READONLY_${Date.now()}`;
      const form = await app.db.getRepository(
        (await import('../../src/entities/form-definition.entity.js')).FormDefinition,
      ).save({
        code: `TEST_FORM_${tag}`,
        version: 1,
        jsonSchema: {
          type: 'object',
          properties: {
            DECISION: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
            NOTES: { type: 'string' },
          },
          required: ['DECISION'],
        },
        uiSchema: { type: 'VerticalLayout', elements: [] },
        visibilityRules: { NOTES: { readOnly: true } },
        status: 'published',
      });

      const process = await app.db.getRepository(
        (await import('../../src/entities/process-definition.entity.js')).ProcessDefinition,
      ).save({ name: `Test Process ${tag}` });

      const taskDef = await app.db.getRepository(
        (await import('../../src/entities/task-definition.entity.js')).TaskDefinition,
      ).save({
        code: `TEST_TASK_DEF_${tag}`,
        processDefinitionId: process.id,
        formDefinitionCode: form.code,
        candidateGroups: [],
        candidateUsers: [],
        defaultPriority: 'normal',
      });

      // Create the task with pre-existing NOTES in submissionData
      const createRes = await authed(app, cookie, {
        method: 'POST',
        url: '/tasks',
        payload: {
          taskDefinitionId: taskDef.id,
          workflowId: `wf-readonly-${Date.now()}`,
          submissionData: { NOTES: 'original' },
        },
      });
      expect(createRes.statusCode).toBe(201);
      const taskId = createRes.json<{ id: string }>().id;

      // Claim it
      await authed(app, cookie, { method: 'POST', url: `/tasks/${taskId}/claim` });

      // Complete with DECISION + attempt to overwrite NOTES
      const res = await authed(app, cookie, {
        method: 'POST',
        url: `/tasks/${taskId}/complete`,
        payload: { data: { DECISION: 'APPROVED', NOTES: 'overwritten' } },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ submissionData: Record<string, unknown> }>();
      expect(body.submissionData.DECISION).toBe('APPROVED');
      // NOTES must be the original value — overwrite was stripped
      expect(body.submissionData.NOTES).toBe('original');
    });

    it('allows submission of writable fields', async () => {
      // No readOnly rules — all fields are writable
      const id = await createTask();
      await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      const res = await authed(app, cookie, {
        method: 'POST',
        url: `/tasks/${id}/complete`,
        payload: { data: { DECISION: 'REJECTED', NOTES: 'all good' } },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ submissionData: Record<string, unknown> }>();
      expect(body.submissionData.DECISION).toBe('REJECTED');
      expect(body.submissionData.NOTES).toBe('all good');
    });

    it('returns 422 when writable fields fail schema validation', async () => {
      const id = await createTask();
      await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
      const res = await authed(app, cookie, {
        method: 'POST',
        url: `/tasks/${id}/complete`,
        // DECISION is required but missing; NOTES is fine
        payload: { data: { NOTES: 'no decision provided' } },
      });

      expect(res.statusCode).toBe(422);
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
