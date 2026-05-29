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

describe('POST /tasks/search', () => {
  let app: FastifyInstance;
  let cookie: string;
  let taskDefId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const user = await createTestUser(app, { permissions: ['tasks:read', 'tasks:write'] });
    cookie = await loginAs(app, user.email);

    const { taskDef } = await createTestTaskSetup(app);
    taskDefId = taskDef.id;
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  async function createTask(overrides: Record<string, unknown> = {}) {
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: {
        taskDefinitionId: taskDefId,
        workflowId: `wf-search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  function search(body: Record<string, unknown>) {
    return authed(app, cookie, {
      method: 'POST',
      url: '/tasks/search',
      payload: body,
    });
  }

  it('returns all tasks when no filters are provided', async () => {
    const id = await createTask({ inputData: { ORDER_ID: 'all-test' } });

    const res = await search({});
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[]; total: number }>();
    expect(body.items.map((t) => t.id)).toContain(id);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('filters by inputVariables with eq operator', async () => {
    const matchId = await createTask({ inputData: { ORDER_ID: 'ORD-SEARCH-1' } });
    await createTask({ inputData: { ORDER_ID: 'ORD-SEARCH-2' } });

    const res = await search({
      inputVariables: [{ name: 'ORDER_ID', operator: 'eq', value: 'ORD-SEARCH-1' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string; inputData: Record<string, unknown> }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
    expect(body.items.every((t) => t.inputData.ORDER_ID === 'ORD-SEARCH-1')).toBe(true);
  });

  it('filters by numeric eq', async () => {
    const matchId = await createTask({ inputData: { AMOUNT: 99999 } });
    await createTask({ inputData: { AMOUNT: 11111 } });

    const res = await search({
      inputVariables: [{ name: 'AMOUNT', operator: 'eq', value: 99999 }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
  });

  it('filters by contextVariables', async () => {
    const matchId = await createTask({ contextData: { REGION: 'US-EAST' } });
    await createTask({ contextData: { REGION: 'EU-WEST' } });

    const res = await search({
      contextVariables: [{ name: 'REGION', operator: 'eq', value: 'US-EAST' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
  });

  it('filters by submissionVariables', async () => {
    const id = await createTask();
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
    await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { DECISION: 'APPROVED' } },
    });

    const res = await search({
      submissionVariables: [{ name: 'DECISION', operator: 'eq', value: 'APPROVED' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(id);
  });

  it('combines metadata and variable filters (AND)', async () => {
    const matchId = await createTask({ inputData: { ORDER_ID: 'ORD-COMBO-1' } });

    const res = await search({
      status: 'created',
      inputVariables: [{ name: 'ORDER_ID', operator: 'eq', value: 'ORD-COMBO-1' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
  });

  it('combines filters across multiple scopes (AND)', async () => {
    const matchId = await createTask({
      inputData: { ORDER_ID: 'ORD-MULTI-1' },
      contextData: { CUSTOMER: 'Acme Corp' },
    });
    await createTask({
      inputData: { ORDER_ID: 'ORD-MULTI-1' },
      contextData: { CUSTOMER: 'Other Corp' },
    });

    const res = await search({
      inputVariables: [{ name: 'ORDER_ID', operator: 'eq', value: 'ORD-MULTI-1' }],
      contextVariables: [{ name: 'CUSTOMER', operator: 'eq', value: 'Acme Corp' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
    expect(body.items.length).toBe(1);
  });

  it('filters with like operator using % wildcard', async () => {
    const matchId = await createTask({ inputData: { ORDER_ID: 'ORD-LIKE-001' } });
    await createTask({ inputData: { ORDER_ID: 'INVOICE-001' } });

    const res = await search({
      inputVariables: [{ name: 'ORDER_ID', operator: 'like', value: 'ORD-LIKE%' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string; inputData: Record<string, unknown> }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
    expect(body.items.every((t) => String(t.inputData.ORDER_ID).startsWith('ORD-LIKE'))).toBe(true);
  });

  it('rejects like operator with numeric value', async () => {
    const res = await search({
      inputVariables: [{ name: 'AMOUNT', operator: 'like', value: 123 }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects like operator without % wildcard', async () => {
    const res = await search({
      inputVariables: [{ name: 'ORDER_ID', operator: 'like', value: 'ORD-001' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('respects pagination (limit and offset)', async () => {
    const marker = `PAGINATE-${Date.now()}`;
    await createTask({ inputData: { MARKER: marker } });
    await createTask({ inputData: { MARKER: marker } });
    await createTask({ inputData: { MARKER: marker } });

    const res1 = await search({
      inputVariables: [{ name: 'MARKER', operator: 'eq', value: marker }],
      limit: 2,
      offset: 0,
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json<{ items: unknown[]; total: number; limit: number; offset: number }>();
    expect(body1.items.length).toBe(2);
    expect(body1.total).toBe(3);
    expect(body1.limit).toBe(2);
    expect(body1.offset).toBe(0);

    const res2 = await search({
      inputVariables: [{ name: 'MARKER', operator: 'eq', value: marker }],
      limit: 2,
      offset: 2,
    });
    const body2 = res2.json<{ items: unknown[]; total: number }>();
    expect(body2.items.length).toBe(1);
    expect(body2.total).toBe(3);
  });

  it('returns 403 without tasks:read permission', async () => {
    const noPermsUser = await createTestUser(app, { permissions: [] });
    const noPermsCookie = await loginAs(app, noPermsUser.email);

    const res = await authed(app, noPermsCookie, {
      method: 'POST',
      url: '/tasks/search',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns empty results when no tasks match', async () => {
    const res = await search({
      inputVariables: [{ name: 'NONEXISTENT', operator: 'eq', value: 'no-match' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: unknown[]; total: number }>();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});
