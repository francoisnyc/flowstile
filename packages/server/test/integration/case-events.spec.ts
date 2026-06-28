import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { Permissions } from '../../src/common/permissions.js';
import { createTestUser, createTestTaskSetup, loginAs, authed, cleanupTestData } from './helpers.js';

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const user = await createTestUser(app, {
    permissions: [Permissions.TASKS_READ, Permissions.TASKS_WRITE, Permissions.TASKS_MANAGE],
  });
  cookie = await loginAs(app, user.email);
});

afterAll(async () => {
  await cleanupTestData(app);
  await app.close();
});

async function createCase(pid: string) {
  const { taskDef } = await createTestTaskSetup(app);
  await authed(app, cookie, {
    method: 'POST',
    url: '/tasks',
    payload: { taskDefinitionId: taskDef.id, workflowId: `wf-${pid}`, processInstanceId: pid },
  });
}

describe('Case events (timeline)', () => {
  it('records agent/system events and returns them on the case timeline, in order', async () => {
    const pid = `evt-pid-${Date.now()}`;
    await createCase(pid);

    const e1 = await authed(app, cookie, {
      method: 'POST',
      url: `/cases/by-process-instance/${pid}/events`,
      payload: { actor: 'agent', label: 'Risk assessment', payload: { recommendation: 'APPROVE', score: 720 }, phase: 'ASSESSMENT' },
    });
    expect(e1.statusCode).toBe(201);
    const ev1 = JSON.parse(e1.body);
    expect(ev1.actor).toBe('agent');
    expect(ev1.label).toBe('Risk assessment');
    expect(ev1.payload).toEqual({ recommendation: 'APPROVE', score: 720 });
    expect(ev1.phase).toBe('ASSESSMENT');

    await authed(app, cookie, {
      method: 'POST',
      url: `/cases/by-process-instance/${pid}/events`,
      payload: { actor: 'system', label: 'Ledger updated' },
    });

    const caseRes = await authed(app, cookie, { method: 'GET', url: `/cases/by-process-instance/${pid}` });
    const body = JSON.parse(caseRes.body);
    expect(body.events.map((e: { label: string }) => e.label)).toEqual(['Risk assessment', 'Ledger updated']);
    expect(body.events[0].actor).toBe('agent');
    expect(body.events[1].actor).toBe('system');
    expect(body.events[1].payload).toBeNull();
  });

  it('materializes the case when an event is recorded before any task exists', async () => {
    const pid = `evt-lazy-${Date.now()}`;
    const res = await authed(app, cookie, {
      method: 'POST',
      url: `/cases/by-process-instance/${pid}/events`,
      payload: { actor: 'agent', label: 'Triage' },
    });
    expect(res.statusCode).toBe(201);

    const caseRes = await authed(app, cookie, { method: 'GET', url: `/cases/by-process-instance/${pid}` });
    expect(caseRes.statusCode).toBe(200);
    expect(JSON.parse(caseRes.body).events.map((e: { label: string }) => e.label)).toEqual(['Triage']);
  });

  it('rejects an actor outside human/system/agent (400)', async () => {
    const pid = `evt-bad-${Date.now()}`;
    await createCase(pid);
    const res = await authed(app, cookie, {
      method: 'POST',
      url: `/cases/by-process-instance/${pid}/events`,
      payload: { actor: 'robot', label: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});
