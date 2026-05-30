import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { Case } from '../../src/entities/case.entity.js';
import { ProcessDefinition } from '../../src/entities/process-definition.entity.js';
import { FormDefinition } from '../../src/entities/form-definition.entity.js';
import { FormDefinitionStatus } from '../../src/common/enums.js';
import { Permissions } from '../../src/common/permissions.js';
import { createTestUser, loginAs, authed, cleanupTestData } from './helpers.js';

let app: FastifyInstance;
let starter: Awaited<ReturnType<typeof createTestUser>>;
let starterCookie: string;
let nonStarterCookie: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  starter = await createTestUser(app, { permissions: [Permissions.PROCESSES_START] });
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

// The success and rollback paths require a reachable engine, so we stand in a
// fake Temporal client. This exercises everything past the temporalEnabled gate:
// the start envelope, case persistence, rollback-on-failure, and idempotency.
describe('POST /processes/:id/start (Temporal mocked)', () => {
  let start: ReturnType<typeof vi.fn>;
  let realTemporal: FastifyInstance['temporal'];
  let realEnabled: boolean;

  beforeEach(() => {
    start = vi.fn().mockResolvedValue({ workflowId: 'wf' });
    realTemporal = app.temporal;
    realEnabled = app.temporalEnabled;
    (app as { temporal: unknown }).temporal = { workflow: { start } };
    (app as { temporalEnabled: boolean }).temporalEnabled = true;
  });

  afterEach(() => {
    (app as { temporal: unknown }).temporal = realTemporal;
    (app as { temporalEnabled: boolean }).temporalEnabled = realEnabled;
  });

  it('starts the workflow and creates a case (happy path)', async () => {
    const pd = await makeProcess({ workflowType: 'loanWf', taskQueue: 'loan-q', startForm });
    const res = await authed(app, starterCookie, {
      method: 'POST',
      url: `/processes/${pd.id}/start`,
      payload: { data: { CUSTOMER_NAME: 'Jane', AMOUNT: 1000 } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.processInstanceId).toBeTruthy();
    expect(body.caseId).toBeTruthy();

    expect(start).toHaveBeenCalledTimes(1);
    const [workflowType, options] = start.mock.calls[0];
    expect(workflowType).toBe('loanWf');
    expect(options.taskQueue).toBe('loan-q');
    expect(options.workflowId).toBe(body.processInstanceId);

    const caseRow = await app.db.getRepository(Case).findOneByOrFail({ id: body.caseId });
    expect(caseRow.processInstanceId).toBe(body.processInstanceId);
    expect(caseRow.processDefinitionId).toBe(pd.id);
    expect(caseRow.entity).toEqual({ CUSTOMER_NAME: 'Jane', AMOUNT: 1000 });
  });

  it('injects the authenticated principal as startedBy and nests caller data', async () => {
    const pd = await makeProcess({ workflowType: 'loanWf', taskQueue: 'loan-q', startForm });
    // Caller tries to forge identity via the data payload.
    const res = await authed(app, starterCookie, {
      method: 'POST',
      url: `/processes/${pd.id}/start`,
      payload: { data: { CUSTOMER_NAME: 'Jane', AMOUNT: 1000, startedBy: 'hacker', processInstanceId: 'forged' } },
    });
    expect(res.statusCode).toBe(201);

    const [, options] = start.mock.calls[0];
    const arg = options.args[0];
    // Server-injected fields are authoritative, not the caller's forgeries.
    expect(arg.startedBy.id).toBe(starter.id);
    expect(arg.processInstanceId).toBe(res.json().processInstanceId);
    expect(arg.processInstanceId).not.toBe('forged');
    // The forged values survive only inside the sandboxed data envelope.
    expect(arg.data.startedBy).toBe('hacker');
    expect(arg.data.processInstanceId).toBe('forged');
  });

  it('rolls back the case when workflow start fails (502, no orphan)', async () => {
    start.mockRejectedValueOnce(new Error('engine exploded'));
    const pd = await makeProcess({ workflowType: 'loanWf', taskQueue: 'loan-q', startForm });
    const res = await authed(app, starterCookie, {
      method: 'POST',
      url: `/processes/${pd.id}/start`,
      payload: { data: { CUSTOMER_NAME: 'Jane', AMOUNT: 1000 } },
    });
    expect(res.statusCode).toBe(502);
    // Raw engine text must not leak to the caller.
    expect(JSON.stringify(res.json())).not.toContain('exploded');

    const cases = await app.db.getRepository(Case).count({ where: { processDefinitionId: pd.id } });
    expect(cases).toBe(0);
  });

  it('is idempotent: same key resolves to one case and one start', async () => {
    const pd = await makeProcess({ workflowType: 'loanWf', taskQueue: 'loan-q', startForm });
    const payload = { data: { CUSTOMER_NAME: 'Jane', AMOUNT: 1000 }, idempotencyKey: 'order-42' };

    const first = await authed(app, starterCookie, {
      method: 'POST', url: `/processes/${pd.id}/start`, payload,
    });
    const second = await authed(app, starterCookie, {
      method: 'POST', url: `/processes/${pd.id}/start`, payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().caseId).toBe(first.json().caseId);
    expect(start).toHaveBeenCalledTimes(1);

    const cases = await app.db.getRepository(Case).count({ where: { processDefinitionId: pd.id } });
    expect(cases).toBe(1);
  });
});
