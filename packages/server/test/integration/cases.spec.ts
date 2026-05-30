import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { Case } from '../../src/entities/case.entity.js';
import { Task } from '../../src/entities/task.entity.js';
import { ProcessDefinition } from '../../src/entities/process-definition.entity.js';
import { FormDefinition } from '../../src/entities/form-definition.entity.js';
import { TaskDefinition } from '../../src/entities/task-definition.entity.js';
import { TaskStatus, FormDefinitionStatus, Priority } from '../../src/common/enums.js';
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

  it('snapshots top-level scalar inputData as the initial case entity (no schema)', async () => {
    const pid = `test-pid-vars-${Date.now()}`;
    await createTask(pid, { applicantName: 'John Doe', amount: 50000, nested: { ignore: true } });

    const c = await app.db.getRepository(Case).findOne({ where: { processInstanceId: pid } });
    expect(c!.entity).toEqual({ applicantName: 'John Doe', amount: 50000 });
    expect(c!.entityVersion).toBe(0);
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

describe('Case entity (GET / PATCH / PUT /entity)', () => {
  it('reads back the entity and version', async () => {
    const pid = `test-entity-read-${Date.now()}`;
    await createTask(pid, { amount: 1000 });

    const res = await authed(app, cookie, {
      method: 'GET',
      url: `/cases/by-process-instance/${pid}/entity`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entity).toMatchObject({ amount: 1000 });
    expect(body.entityVersion).toBe(0);
  });

  it('applies a JSON Patch and bumps the version', async () => {
    const pid = `test-entity-patch-${Date.now()}`;
    await createTask(pid, { amount: 1000 });

    const res = await authed(app, cookie, {
      method: 'PATCH',
      url: `/cases/by-process-instance/${pid}/entity`,
      payload: {
        patch: [
          { op: 'replace', path: '/amount', value: 2000 },
          { op: 'add', path: '/stage', value: 'underwriting' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entity).toEqual({ amount: 2000, stage: 'underwriting' });
    expect(body.entityVersion).toBe(1);
  });

  it('full-replaces the entity with PUT', async () => {
    const pid = `test-entity-put-${Date.now()}`;
    await createTask(pid, { amount: 1000 });

    const res = await authed(app, cookie, {
      method: 'PUT',
      url: `/cases/by-process-instance/${pid}/entity`,
      payload: { entity: { only: 'this' } },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.entity).toEqual({ only: 'this' });
    expect(body.entityVersion).toBe(1);
  });

  it('rejects a stale expectedVersion with 409', async () => {
    const pid = `test-entity-conflict-${Date.now()}`;
    await createTask(pid, { amount: 1 });

    // First write moves version 0 → 1
    await authed(app, cookie, {
      method: 'PUT',
      url: `/cases/by-process-instance/${pid}/entity`,
      payload: { entity: { amount: 2 } },
    });

    // Second write asserting version 0 (stale) must conflict
    const res = await authed(app, cookie, {
      method: 'PUT',
      url: `/cases/by-process-instance/${pid}/entity`,
      payload: { entity: { amount: 3 }, expectedVersion: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).currentVersion).toBe(1);
  });

  it('returns 422 for a JSON Patch against a missing path', async () => {
    const pid = `test-entity-badpatch-${Date.now()}`;
    await createTask(pid, {});

    const res = await authed(app, cookie, {
      method: 'PATCH',
      url: `/cases/by-process-instance/${pid}/entity`,
      payload: { patch: [{ op: 'replace', path: '/missing/deep', value: 1 }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 404 for unknown processInstanceId', async () => {
    const res = await authed(app, cookie, {
      method: 'PUT',
      url: '/cases/by-process-instance/no-such/entity',
      payload: { entity: { foo: 'bar' } },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Case entity schema validation', () => {
  it('rejects an entity that violates the process caseEntitySchema', async () => {
    // A process whose case entity must have a numeric amount.
    const process = await app.db.getRepository(ProcessDefinition).save({
      name: `Test Process Schema ${Date.now()}`,
      caseEntitySchema: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        required: ['amount'],
      },
    });
    const form = await app.db.getRepository(FormDefinition).save({
      code: `TEST_FORM_SCHEMA_${Date.now()}`,
      version: 1,
      jsonSchema: { type: 'object', properties: { DECISION: { type: 'string' } } },
      uiSchema: { type: 'VerticalLayout', elements: [] },
      status: FormDefinitionStatus.PUBLISHED,
    });
    const taskDef = await app.db.getRepository(TaskDefinition).save({
      code: `TEST_TASK_SCHEMA_${Date.now()}`,
      processDefinitionId: process.id,
      formDefinitionCode: form.code,
      candidateGroups: [],
      candidateUsers: [],
      defaultPriority: Priority.NORMAL,
    });

    const pid = `test-entity-schema-${Date.now()}`;
    await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: taskDef.id, workflowId: `wf-${Date.now()}`, processInstanceId: pid },
    });

    // With a schema present, the entity initializes to null (not a scalar snapshot).
    const c = await app.db.getRepository(Case).findOne({ where: { processInstanceId: pid } });
    expect(c!.entity).toBeNull();

    // A non-conforming write is rejected …
    const bad = await authed(app, cookie, {
      method: 'PUT',
      url: `/cases/by-process-instance/${pid}/entity`,
      payload: { entity: { amount: 'not-a-number' } },
    });
    expect(bad.statusCode).toBe(422);

    // … and a conforming write succeeds.
    const good = await authed(app, cookie, {
      method: 'PUT',
      url: `/cases/by-process-instance/${pid}/entity`,
      payload: { entity: { amount: 1234 } },
    });
    expect(good.statusCode).toBe(200);
    expect(JSON.parse(good.body).entity).toEqual({ amount: 1234 });
  });
});
