import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { Case } from '../../src/entities/case.entity.js';
import { ProcessDefinition } from '../../src/entities/process-definition.entity.js';
import { FormDefinition } from '../../src/entities/form-definition.entity.js';
import { FormDefinitionStatus } from '../../src/common/enums.js';
import { Permissions } from '../../src/common/permissions.js';
import { createTestUser, loginAs, authed, cleanupTestData } from './helpers.js';

let app: FastifyInstance;
let starterCookie: string;
let nonStarterCookie: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const starter = await createTestUser(app, { permissions: [Permissions.PROCESSES_START] });
  starterCookie = await loginAs(app, starter.email);

  const nonStarter = await createTestUser(app, { permissions: [Permissions.TASKS_READ] });
  nonStarterCookie = await loginAs(app, nonStarter.email);
});

afterAll(async () => {
  await cleanupTestData(app);
  await app.close();
});

// Builds a process definition with optional portal-start config + start form.
async function makeProcess(opts: {
  workflowType?: string | null;
  taskQueue?: string | null;
  startForm?: Record<string, unknown> | null;
}) {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let startFormCode: string | null = null;
  if (opts.startForm) {
    const form = await app.db.getRepository(FormDefinition).save({
      code: `TEST_START_${tag}`,
      version: 1,
      jsonSchema: opts.startForm,
      uiSchema: {},
      status: FormDefinitionStatus.PUBLISHED,
    });
    startFormCode = form.code;
  }
  return app.db.getRepository(ProcessDefinition).save({
    name: `Test Process ${tag}`,
    workflowType: opts.workflowType ?? null,
    taskQueue: opts.taskQueue ?? null,
    startFormCode,
  });
}

const startForm = {
  type: 'object',
  properties: { CUSTOMER_NAME: { type: 'string' }, AMOUNT: { type: 'number' } },
  required: ['CUSTOMER_NAME', 'AMOUNT'],
};

describe('POST /processes/:id/start', () => {
  it('rejects unauthenticated callers with 401', async () => {
    const pd = await makeProcess({ workflowType: 'wf', taskQueue: 'q' });
    const res = await app.inject({
      method: 'POST',
      url: `/processes/${pd.id}/start`,
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects callers without processes:start with 403', async () => {
    const pd = await makeProcess({ workflowType: 'wf', taskQueue: 'q' });
    const res = await authed(app, nonStarterCookie, {
      method: 'POST',
      url: `/processes/${pd.id}/start`,
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for an unknown process', async () => {
    const res = await authed(app, starterCookie, {
      method: 'POST',
      url: `/processes/00000000-0000-0000-0000-000000000000/start`,
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 422 when the process is not configured for portal start', async () => {
    const pd = await makeProcess({ workflowType: null, taskQueue: null });
    const res = await authed(app, starterCookie, {
      method: 'POST',
      url: `/processes/${pd.id}/start`,
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 422 when data is supplied but the process has no start form', async () => {
    const pd = await makeProcess({ workflowType: 'wf', taskQueue: 'q', startForm: null });
    const res = await authed(app, starterCookie, {
      method: 'POST',
      url: `/processes/${pd.id}/start`,
      payload: { data: { rogue: 'value' } },
    });
    expect(res.statusCode).toBe(422);
  });

  it('returns 422 when start-form data fails validation', async () => {
    const pd = await makeProcess({ workflowType: 'wf', taskQueue: 'q', startForm });
    const res = await authed(app, starterCookie, {
      method: 'POST',
      url: `/processes/${pd.id}/start`,
      payload: { data: { CUSTOMER_NAME: 'Jane' } }, // missing required AMOUNT
    });
    expect(res.statusCode).toBe(422);
  });

  it('does not create a case when validation fails (no orphan)', async () => {
    const pd = await makeProcess({ workflowType: 'wf', taskQueue: 'q', startForm });
    await authed(app, starterCookie, {
      method: 'POST',
      url: `/processes/${pd.id}/start`,
      payload: { data: {} },
    });
    const cases = await app.db.getRepository(Case).count({ where: { processDefinitionId: pd.id } });
    expect(cases).toBe(0);
  });

  // With Temporal disabled in the test env the request is well-formed but the
  // engine is unavailable: it must surface 503 and leave no case behind.
  it('returns 503 and creates no case when Temporal is unavailable', async () => {
    const pd = await makeProcess({ workflowType: 'wf', taskQueue: 'q', startForm });
    const res = await authed(app, starterCookie, {
      method: 'POST',
      url: `/processes/${pd.id}/start`,
      payload: { data: { CUSTOMER_NAME: 'Jane', AMOUNT: 1000 } },
    });
    expect(res.statusCode).toBe(503);
    const cases = await app.db.getRepository(Case).count({ where: { processDefinitionId: pd.id } });
    expect(cases).toBe(0);
  });
});
