import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { Permissions } from '../../src/common/permissions.js';
import { createTestUser, loginAs, authed, cleanupTestData } from './helpers.js';

let app: FastifyInstance;
let cookie: string;
let agentToken: string;

const SCHEMA = {
  type: 'object',
  properties: {
    severity: { type: 'string' },
    service: { type: 'string' },
    page_on_call: { type: 'boolean' },
  },
  required: ['severity'],
};

// Calls an endpoint with the agent's service API key (no cookie) → principal.kind === 'service'.
function withKey(token: string, options: Parameters<FastifyInstance['inject']>[0]) {
  return app.inject({
    ...options,
    headers: { authorization: `Bearer ${token}`, ...('headers' in options ? options.headers : {}) },
  } as Parameters<FastifyInstance['inject']>[0]);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  const user = await createTestUser(app, {
    permissions: [Permissions.TASKS_READ, Permissions.TASKS_WRITE, Permissions.TASKS_MANAGE, Permissions.USERS_MANAGE],
  });
  cookie = await loginAs(app, user.email);
  const keyRes = await authed(app, cookie, {
    method: 'POST',
    url: '/auth/api-keys',
    payload: { name: `test-key-agent-${Date.now()}`, permissions: [Permissions.TASKS_READ, Permissions.TASKS_WRITE] },
  });
  agentToken = JSON.parse(keyRes.body).token;
});

afterAll(async () => {
  await cleanupTestData(app);
  await app.close();
});

async function createChatTask(extra: Record<string, unknown> = {}) {
  return authed(app, cookie, {
    method: 'POST',
    url: '/tasks',
    payload: {
      formSchema: SCHEMA,
      name: 'Incident intake',
      chat: { agent: 'incident-intake', goal: 'Collect severity/service/page.', greeting: 'What is happening?' },
      workflowId: `wf-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ...extra,
    },
  });
}

describe('Chat tasks (conversational forms)', () => {
  it('creates a chat task and seeds the greeting as an agent message', async () => {
    const res = await createChatTask();
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; chat: { agent: string; greeting: string } }>();
    expect(body.chat.agent).toBe('incident-intake');

    const msgs = await authed(app, cookie, { method: 'GET', url: `/tasks/${body.id}/messages` });
    const items = msgs.json<{ items: { role: string; content: string }[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ role: 'agent', content: 'What is happening?' });
  });

  it('infers role from the credential: cookie → human, service key → agent', async () => {
    const { id } = (await createChatTask()).json<{ id: string }>();

    const h = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/messages`, payload: { content: 'high severity' } });
    expect(h.statusCode).toBe(201);
    expect(h.json<{ role: string }>().role).toBe('human');

    const a = await withKey(agentToken, { method: 'POST', url: `/tasks/${id}/messages`, payload: { content: 'Which service?' } });
    expect(a.statusCode).toBe(201);
    expect(a.json<{ role: string }>().role).toBe('agent');

    const list = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}/messages` });
    expect(list.json<{ items: { role: string }[] }>().items.map((m) => m.role))
      .toEqual(['agent', 'human', 'agent']); // greeting, human, agent
  });

  it('lets the agent update the draft submission (merge, unvalidated)', async () => {
    const { id } = (await createChatTask()).json<{ id: string }>();

    await withKey(agentToken, { method: 'PATCH', url: `/tasks/${id}/submission`, payload: { data: { severity: 'high' } } });
    await withKey(agentToken, { method: 'PATCH', url: `/tasks/${id}/submission`, payload: { data: { service: 'orders-db' } } });

    const task = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}` });
    expect(task.json<{ submissionData: Record<string, unknown> }>().submissionData)
      .toEqual({ severity: 'high', service: 'orders-db' });
  });

  it('completes with the draft (human commits), validated against the schema', async () => {
    const { id } = (await createChatTask()).json<{ id: string }>();
    await withKey(agentToken, { method: 'PATCH', url: `/tasks/${id}/submission`, payload: { data: { severity: 'high', page_on_call: true } } });

    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
    const done = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { service: 'orders-db' } },
    });
    expect(done.statusCode).toBe(200);
    const body = done.json<{ status: string; submissionData: Record<string, unknown> }>();
    expect(body.status).toBe('completed');
    expect(body.submissionData).toEqual({ severity: 'high', page_on_call: true, service: 'orders-db' });
  });

  it('rejects a draft patch once the task is terminal (409)', async () => {
    const { id } = (await createChatTask()).json<{ id: string }>();
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/complete`, payload: { data: { severity: 'low' } } });

    const res = await withKey(agentToken, { method: 'PATCH', url: `/tasks/${id}/submission`, payload: { data: { severity: 'high' } } });
    expect(res.statusCode).toBe(409);
  });

  it('returns the chat config on the task envelope', async () => {
    const { id } = (await createChatTask()).json<{ id: string }>();
    const task = await authed(app, cookie, { method: 'GET', url: `/tasks/${id}` });
    expect(task.json<{ chat: { agent: string } }>().chat.agent).toBe('incident-intake');
  });
});
