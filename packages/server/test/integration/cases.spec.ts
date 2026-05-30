import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { Case } from '../../src/entities/case.entity.js';
import { Task } from '../../src/entities/task.entity.js';
import { TaskStatus } from '../../src/common/enums.js';
import { Permissions } from '../../src/common/permissions.js';
import {
  createTestUser,
  createTestTaskSetup,
  loginAs,
  authed,
  cleanupTestData,
} from './helpers.js';

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const user = await createTestUser(app, {
    permissions: [Permissions.TASKS_READ, Permissions.TASKS_WRITE],
  });
  cookie = await loginAs(app, user.email);
});

afterAll(async () => {
  await cleanupTestData(app);
  await app.close();
});

async function createTask(pid?: string, inputData?: Record<string, unknown>) {
  const { taskDef } = await createTestTaskSetup(app);
  const res = await authed(app, cookie, {
    method: 'POST',
    url: '/tasks',
    payload: {
      taskDefinitionId: taskDef.id,
      workflowId: `wf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...(pid ? { processInstanceId: pid } : {}),
      ...(inputData ? { inputData } : {}),
    },
  });
  return JSON.parse(res.body);
}

describe('Case lazy upsert', () => {
  it('creates a Case row when a task with processInstanceId is created', async () => {
    const pid = `test-pid-${Date.now()}`;
    await createTask(pid);

    const c = await app.db.getRepository(Case).findOne({ where: { processInstanceId: pid } });
    expect(c).toBeTruthy();
    expect(c!.processInstanceId).toBe(pid);
    expect(c!.processDefinitionId).toBeTruthy();
  });

  it('does not create a Case row when processInstanceId is absent', async () => {
    const before = await app.db.getRepository(Case).count();
    await createTask(); // no processInstanceId
    const after = await app.db.getRepository(Case).count();
    expect(after).toBe(before);
  });

  it('does not duplicate the Case row for a second task on the same instance', async () => {
    const pid = `test-pid-dedup-${Date.now()}`;
    const { taskDef } = await createTestTaskSetup(app);

    await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: taskDef.id, workflowId: `wf-a-${Date.now()}`, processInstanceId: pid },
    });
    await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: taskDef.id, workflowId: `wf-b-${Date.now()}`, processInstanceId: pid },
    });

    const count = await app.db.getRepository(Case).count({ where: { processInstanceId: pid } });
    expect(count).toBe(1);
  });

  it('snapshots top-level scalar inputData as initial case variables', async () => {
    const pid = `test-pid-vars-${Date.now()}`;
    await createTask(pid, { applicantName: 'John Doe', amount: 50000, nested: { ignore: true } });

    const c = await app.db.getRepository(Case).findOne({ where: { processInstanceId: pid } });
    expect(c!.variables).toEqual({ applicantName: 'John Doe', amount: 50000 });
  });
});

describe('GET /cases', () => {
  it('returns 200 with paginated cases', async () => {
    const pid = `test-list-${Date.now()}`;
    await createTask(pid);

    const res = await authed(app, cookie, { method: 'GET', url: '/cases' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('items');
    expect(body).toHaveProperty('total');
    const ids = body.items.map((i: any) => i.processInstanceId);
    expect(ids).toContain(pid);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/cases' });
    expect(res.statusCode).toBe(401);
  });

  it('filters by status=pending when no tasks are present', async () => {
    const pid = `test-pending-${Date.now()}`;
    // Manually insert a Case with no tasks
    await app.db.getRepository(Case).save({ processInstanceId: pid });

    const res = await authed(app, cookie, { method: 'GET', url: '/cases?status=pending' });
    const body = JSON.parse(res.body);
    const found = body.items.find((i: any) => i.processInstanceId === pid);
    expect(found).toBeTruthy();
    expect(found.status).toBe('pending');
  });
});

describe('GET /cases/:id', () => {
  it('returns case detail with tasks', async () => {
    const pid = `test-detail-${Date.now()}`;
    await createTask(pid);

    const c = await app.db.getRepository(Case).findOne({ where: { processInstanceId: pid } });
    const res = await authed(app, cookie, { method: 'GET', url: `/cases/${c!.id}` });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.processInstanceId).toBe(pid);
    expect(body.tasks).toHaveLength(1);
    expect(body.attachments).toEqual([]);
  });

  it('derives status correctly', async () => {
    const pid = `test-status-${Date.now()}`;
    const task = await createTask(pid);

    const c = await app.db.getRepository(Case).findOne({ where: { processInstanceId: pid } });

    // created → in_progress
    let res = await authed(app, cookie, { method: 'GET', url: `/cases/${c!.id}` });
    expect(JSON.parse(res.body).status).toBe('in_progress');

    // complete the task: claim first
    await authed(app, cookie, { method: 'POST', url: `/tasks/${task.id}/claim` });
    await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${task.id}/complete`,
      payload: { data: { DECISION: 'APPROVED' } },
    });

    res = await authed(app, cookie, { method: 'GET', url: `/cases/${c!.id}` });
    expect(JSON.parse(res.body).status).toBe('completed');
  });

  it('returns 404 for unknown id', async () => {
    const res = await authed(app, cookie, {
      method: 'GET',
      url: '/cases/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /cases/by-process-instance/:processInstanceId', () => {
  it('returns case by processInstanceId', async () => {
    const pid = `test-bypid-${Date.now()}`;
    await createTask(pid);

    const res = await authed(app, cookie, {
      method: 'GET',
      url: `/cases/by-process-instance/${pid}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).processInstanceId).toBe(pid);
  });

  it('returns 404 for unknown processInstanceId', async () => {
    const res = await authed(app, cookie, {
      method: 'GET',
      url: '/cases/by-process-instance/no-such-workflow',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /cases/by-process-instance/:processInstanceId/variables', () => {
  it('merges variables onto the case', async () => {
    const pid = `test-vars-patch-${Date.now()}`;
    await createTask(pid, { amount: 1000 });

    // Initial variables from inputData snapshot
    let c = await app.db.getRepository(Case).findOne({ where: { processInstanceId: pid } });
    expect(c!.variables).toMatchObject({ amount: 1000 });

    const res = await authed(app, cookie, {
      method: 'PATCH',
      url: `/cases/by-process-instance/${pid}/variables`,
      payload: { variables: { stage: 'underwriting', amount: 2000 } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // New key added, existing key overwritten
    expect(body.variables).toMatchObject({ stage: 'underwriting', amount: 2000 });
  });

  it('returns 404 for unknown processInstanceId', async () => {
    const res = await authed(app, cookie, {
      method: 'PATCH',
      url: '/cases/by-process-instance/no-such/variables',
      payload: { variables: { foo: 'bar' } },
    });
    expect(res.statusCode).toBe(404);
  });
});
