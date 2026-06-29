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

// Ad-hoc tasks: a task carrying an inline formSchema instead of (or alongside) a
// published form. See docs/ad-hoc-tasks.md.
describe('Ad-hoc tasks (inline forms)', () => {
  let app: FastifyInstance;
  let cookie: string;
  let userId: string;

  const INLINE_SCHEMA = {
    type: 'object',
    properties: {
      approved: { type: 'boolean', title: 'Approve?' },
      reason: { type: 'string' },
    },
    required: ['approved'],
  };

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    const user = await createTestUser(app, { permissions: ['tasks:read', 'tasks:write', 'tasks:manage'] });
    userId = user.id;
    cookie = await loginAs(app, user.email);
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  async function createAdHoc(extra: Record<string, unknown> = {}) {
    return authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: {
        formSchema: INLINE_SCHEMA,
        name: 'Confirm the thing',
        workflowId: `wf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...extra,
      },
    });
  }

  it('creates an ad-hoc task with no task definition and no locked version', async () => {
    const res = await createAdHoc();
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; name: string; formDefinitionVersion: number | null; taskDefinition?: unknown }>();
    expect(body.name).toBe('Confirm the thing');
    expect(body.formDefinitionVersion).toBeNull();
    expect(body.taskDefinition).toBeUndefined();
  });

  it('embeds the inline schema in the form envelope with null code/version', async () => {
    const created = await createAdHoc();
    const { id } = created.json<{ id: string }>();

    const res = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ form: { code: null; version: null; jsonSchema: unknown; outcomes: null } }>();
    expect(body.form.code).toBeNull();
    expect(body.form.version).toBeNull();
    expect(body.form.jsonSchema).toEqual(INLINE_SCHEMA);
    expect(body.form.outcomes).toBeNull();
  });

  it('runs the full lifecycle and validates submission against the inline schema', async () => {
    const created = await createAdHoc();
    const { id } = created.json<{ id: string }>();

    const claim = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
    expect(claim.statusCode).toBe(200);

    const complete = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { approved: true, reason: 'looks good' } },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json<{ status: string }>().status).toBe('completed');
  });

  it('rejects a submission that violates the inline schema (422)', async () => {
    const created = await createAdHoc();
    const { id } = created.json<{ id: string }>();
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });

    const res = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { approved: 'yes please' } }, // wrong type, and the right one is required
    });
    expect(res.statusCode).toBe(422);
  });

  it('checks the state machine before submission data (409 before 422)', async () => {
    const created = await createAdHoc();
    const { id } = created.json<{ id: string }>();
    // Not claimed → completing is an invalid transition; bad data must not pre-empt the 409.
    const res = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { approved: 'nonsense' } },
    });
    expect(res.statusCode).toBe(409);
  });

  it('validates inputData leniently against the inline schema (422 on bad type)', async () => {
    const res = await createAdHoc({ inputData: { approved: 'not-a-boolean' } });
    expect(res.statusCode).toBe(422);
  });

  it('accepts an inline form alongside a task definition (attribution kept, version null)', async () => {
    const { taskDef } = await createTestTaskSetup(app);
    const res = await createAdHoc({ taskDefinitionId: taskDef.id });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; formDefinitionVersion: number | null }>();
    // Inline schema overrides the definition's published form → no locked version.
    expect(body.formDefinitionVersion).toBeNull();

    // GET loads the taskDefinition relation, so attribution is visible there,
    // while the form envelope still serves the inline schema.
    const get = await authed(app, cookie, { method: 'GET', url: `/tasks/${body.id}` });
    const detail = get.json<{ taskDefinition?: { id: string }; form: { jsonSchema: unknown; code: null } }>();
    expect(detail.taskDefinition?.id).toBe(taskDef.id);
    expect(detail.form.code).toBeNull();
    expect(detail.form.jsonSchema).toEqual(INLINE_SCHEMA);
  });

  it('rejects a task with neither a definition nor a formSchema (400)', async () => {
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { workflowId: `wf-${Date.now()}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects both taskDefinitionId and taskDefinitionCode (400)', async () => {
    const { taskDef } = await createTestTaskSetup(app);
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: {
        taskDefinitionId: taskDef.id,
        taskDefinitionCode: taskDef.code,
        workflowId: `wf-${Date.now()}`,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
