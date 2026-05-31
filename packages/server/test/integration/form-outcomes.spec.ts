import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { FormDefinition } from '../../src/entities/form-definition.entity.js';
import { ProcessDefinition } from '../../src/entities/process-definition.entity.js';
import { TaskDefinition } from '../../src/entities/task-definition.entity.js';
import { FormDefinitionStatus, Priority } from '../../src/common/enums.js';
import {
  createTestUser,
  loginAs,
  authed,
  cleanupTestData,
} from './helpers.js';

describe('Form outcome buttons', () => {
  let app: FastifyInstance;
  let cookie: string;
  let taskDefId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const user = await createTestUser(app, {
      permissions: ['tasks:read', 'tasks:write', 'tasks:manage', 'forms:write'],
    });
    cookie = await loginAs(app, user.email);

    const tag = Date.now();
    const form = await app.db.getRepository(FormDefinition).save({
      code: `TEST_FORM_OUT_${tag}`,
      version: 1,
      jsonSchema: {
        type: 'object',
        properties: {
          DECISION: { type: 'string', enum: ['approved', 'rejected'] },
          NOTES: { type: 'string' },
        },
        required: ['DECISION'],
      },
      uiSchema: { type: 'VerticalLayout', elements: [] },
      outcomes: [
        { value: 'approved', label: 'Approve', style: 'primary' },
        { value: 'rejected', label: 'Reject', style: 'danger', requireFields: ['NOTES'] },
      ],
      outcomeKey: 'DECISION',
      status: FormDefinitionStatus.PUBLISHED,
    });

    const process = await app.db.getRepository(ProcessDefinition).save({
      name: `Test Process ${tag}`,
    });
    const taskDef = await app.db.getRepository(TaskDefinition).save({
      code: `TEST_TASK_DEF_OUT_${tag}`,
      processDefinitionId: process.id,
      formDefinitionCode: form.code,
      candidateGroups: [],
      candidateUsers: [],
      defaultPriority: Priority.NORMAL,
    });
    taskDefId = taskDef.id;
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  async function createClaimedTask() {
    const created = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: taskDefId, workflowId: `wf-out-${Math.random().toString(36).slice(2)}` },
    });
    const id = created.json<{ id: string }>().id;
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
    return id;
  }

  it('surfaces outcomes and outcomeKey in GET /tasks/:id form block', async () => {
    const id = await createClaimedTask();
    const res = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}` });
    expect(res.statusCode).toBe(200);
    const form = res.json<{ form: { outcomes: unknown[]; outcomeKey: string } }>().form;
    expect(form.outcomeKey).toBe('DECISION');
    expect(form.outcomes).toHaveLength(2);
  });

  it('completes with a valid outcome value', async () => {
    const id = await createClaimedTask();
    const res = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { DECISION: 'approved' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ submissionData: { DECISION: string } }>().submissionData.DECISION).toBe('approved');
  });

  it('rejects an outcome value not in the declared set (422)', async () => {
    const id = await createClaimedTask();
    const res = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { DECISION: 'escalated' } },
    });
    // Schema enum rejects it before the outcome guard, but either way → 422
    expect(res.statusCode).toBe(422);
  });

  it('enforces requireFields for the chosen outcome (422 when missing)', async () => {
    const id = await createClaimedTask();
    const res = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { DECISION: 'rejected' } },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ details: { path: string }[] }>();
    expect(body.details.some((d) => d.path === '/NOTES')).toBe(true);
  });

  it('completes when requireFields are supplied for the chosen outcome', async () => {
    const id = await createClaimedTask();
    const res = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { DECISION: 'rejected', NOTES: 'not enough budget' } },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('Form outcomes CRUD', () => {
  let app: FastifyInstance;
  let cookie: string;

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

  it('round-trips outcomes through create → draft → publish', async () => {
    const code = `TEST_CRUD_OUT_${Date.now()}`;

    const created = await authed(app, cookie, {
      method: 'POST',
      url: '/forms',
      payload: {
        code,
        jsonSchema: { type: 'object', properties: { DECISION: { type: 'string', enum: ['a', 'b'] } } },
        outcomes: [
          { value: 'a', label: 'Accept', style: 'primary' },
          { value: 'b', label: 'Bounce', style: 'danger' },
        ],
        outcomeKey: 'DECISION',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ outcomes: unknown[] }>().outcomes).toHaveLength(2);

    const published = await authed(app, cookie, { method: 'POST', url: `/forms/${code}/publish` });
    expect(published.statusCode).toBe(201);
    expect(published.json<{ outcomeKey: string }>().outcomeKey).toBe('DECISION');

    // New draft inherits outcomes from the published version
    const draft = await authed(app, cookie, {
      method: 'PUT',
      url: `/forms/${code}/draft`,
      payload: { formMessages: { hint: 'x' } },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json<{ outcomes: unknown[] }>().outcomes).toHaveLength(2);
  });

  it('rejects duplicate outcome values (400)', async () => {
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/forms',
      payload: {
        code: `TEST_DUP_OUT_${Date.now()}`,
        jsonSchema: { type: 'object' },
        outcomes: [
          { value: 'a', label: 'One' },
          { value: 'a', label: 'Two' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
