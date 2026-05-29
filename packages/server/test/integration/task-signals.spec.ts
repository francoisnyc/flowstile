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

describe('Signal delivery status', () => {
  let app: FastifyInstance;
  let cookie: string;
  let taskDefId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const user = await createTestUser(app, { permissions: ['tasks:read', 'tasks:write', 'tasks:manage'] });
    cookie = await loginAs(app, user.email);

    const { taskDef } = await createTestTaskSetup(app);
    taskDefId = taskDef.id;
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  async function createTask() {
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: {
        taskDefinitionId: taskDefId,
        workflowId: `wf-sig-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        inputData: { DECISION: 'APPROVED' },
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  it('completed task has signalStatus=not_applicable when no Temporal is configured', async () => {
    const id = await createTask();
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });

    const res = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { DECISION: 'APPROVED' } },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ signalStatus: string }>();
    expect(body.signalStatus).toBe('not_applicable');
  });

  it('cancelled task has signalStatus=not_applicable when no Temporal is configured', async () => {
    const id = await createTask();
    const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/cancel` });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ signalStatus: string }>();
    expect(body.signalStatus).toBe('not_applicable');
  });

  it('signalStatus is null on newly created tasks', async () => {
    const id = await createTask();
    const res = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}` });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ signalStatus: string | null }>();
    expect(body.signalStatus).toBeNull();
  });

  it('GET /tasks can filter by signalStatus', async () => {
    const id = await createTask();
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/cancel` });

    const res = await authed(app, cookie, {
      method: 'GET',
      url: '/tasks?signalStatus=not_applicable',
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string; signalStatus: string }[] }>();
    const match = body.items.find((t) => t.id === id);
    expect(match).toBeTruthy();
    expect(match?.signalStatus).toBe('not_applicable');
  });

  it('POST /tasks/search can filter by signalStatus', async () => {
    const id = await createTask();
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/cancel` });

    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks/search',
      payload: { signalStatus: 'not_applicable' },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(id);
  });

  it('retry-signal returns 409 when signalStatus is not_applicable', async () => {
    const id = await createTask();
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/cancel` });

    const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/retry-signal` });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/failed or pending/i);
  });

  it('retry-signal returns 403 without tasks:manage', async () => {
    const id = await createTask();
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/cancel` });

    const noManageUser = await createTestUser(app, { permissions: ['tasks:read', 'tasks:write'] });
    const noManageCookie = await loginAs(app, noManageUser.email);

    const res = await authed(app, noManageCookie, { method: 'POST', url: `/tasks/${id}/retry-signal` });
    expect(res.statusCode).toBe(403);
  });
});
