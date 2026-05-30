import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { ApiKey } from '../../src/entities/api-key.entity.js';
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
let adminCookie: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const admin = await createTestUser(app, {
    permissions: [
      Permissions.USERS_MANAGE,
      Permissions.TASKS_READ,
      Permissions.TASKS_WRITE,
    ],
  });
  adminCookie = await loginAs(app, admin.email);
});

afterAll(async () => {
  await cleanupTestData(app);
  await app.close();
});

async function createKey(
  permissions: string[],
  extra: Record<string, unknown> = {},
): Promise<{ id: string; token: string; prefix: string }> {
  const res = await authed(app, adminCookie, {
    method: 'POST',
    url: '/auth/api-keys',
    payload: { name: `test-key-${Date.now()}-${Math.random().toString(36).slice(2)}`, permissions, ...extra },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body);
}

// Calls an endpoint with the API key in the Authorization header (no cookie).
function withKey(
  token: string,
  options: Parameters<FastifyInstance['inject']>[0],
) {
  return app.inject({
    ...options,
    headers: { authorization: `Bearer ${token}`, ...('headers' in options ? options.headers : {}) },
  } as Parameters<FastifyInstance['inject']>[0]);
}

describe('API key creation', () => {
  it('returns the plaintext token exactly once on creation', async () => {
    const key = await createKey([Permissions.TASKS_WRITE]);
    expect(key.token).toMatch(/^fsk_/);
    expect(key.prefix).toBe(key.token.slice(0, 12));
  });

  it('never returns the token or hash when listing', async () => {
    await createKey([Permissions.TASKS_READ]);
    const res = await authed(app, adminCookie, { method: 'GET', url: '/auth/api-keys' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    for (const k of body) {
      expect(k).not.toHaveProperty('token');
      expect(k).not.toHaveProperty('keyHash');
    }
  });

  it('rejects creation without users:manage', async () => {
    const user = await createTestUser(app, { permissions: [Permissions.TASKS_WRITE] });
    const cookie = await loginAs(app, user.email);
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/auth/api-keys',
      payload: { name: 'test-key-forbidden', permissions: [Permissions.TASKS_WRITE] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects unknown permission values', async () => {
    const res = await authed(app, adminCookie, {
      method: 'POST',
      url: '/auth/api-keys',
      payload: { name: 'test-key-badperm', permissions: ['tasks:bogus'] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('API key authentication', () => {
  it('authorizes a request bearing a valid key with the right permission', async () => {
    const key = await createKey([Permissions.TASKS_READ]);
    const res = await withKey(key.token, { method: 'GET', url: '/tasks' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a key lacking the required permission with 403', async () => {
    const key = await createKey([Permissions.TASKS_READ]);
    // POST /tasks requires tasks:write, key only has tasks:read
    const { taskDef } = await createTestTaskSetup(app);
    const res = await withKey(key.token, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: taskDef.id, workflowId: 'wf-key-403' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a service key create a task', async () => {
    const key = await createKey([Permissions.TASKS_WRITE]);
    const { taskDef } = await createTestTaskSetup(app);
    const res = await withKey(key.token, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: taskDef.id, workflowId: 'wf-key-create' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects an unknown key with 401', async () => {
    const res = await withKey('fsk_totally_made_up_token', { method: 'GET', url: '/tasks' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a revoked key with 401', async () => {
    const key = await createKey([Permissions.TASKS_READ]);
    const del = await authed(app, adminCookie, { method: 'DELETE', url: `/auth/api-keys/${key.id}` });
    expect(del.statusCode).toBe(204);
    const res = await withKey(key.token, { method: 'GET', url: '/tasks' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired key with 401', async () => {
    const key = await createKey([Permissions.TASKS_READ], {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const res = await withKey(key.token, { method: 'GET', url: '/tasks' });
    expect(res.statusCode).toBe(401);
  });

  it('updates lastUsedAt after a successful authenticated call', async () => {
    const key = await createKey([Permissions.TASKS_READ]);
    await withKey(key.token, { method: 'GET', url: '/tasks' });
    // lastUsedAt is updated fire-and-forget; poll briefly for it.
    let stored: ApiKey | null = null;
    for (let i = 0; i < 20; i++) {
      stored = await app.db.getRepository(ApiKey).findOne({ where: { id: key.id } });
      if (stored?.lastUsedAt) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(stored?.lastUsedAt).toBeTruthy();
  });
});

describe('Service principal task lifecycle', () => {
  it('allows a service key to cancel a created task it does not own', async () => {
    const writeKey = await createKey([Permissions.TASKS_WRITE]);
    const { taskDef } = await createTestTaskSetup(app);
    const created = await withKey(writeKey.token, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: taskDef.id, workflowId: 'wf-key-cancel' },
    });
    const task = JSON.parse(created.body);

    const res = await withKey(writeKey.token, { method: 'POST', url: `/tasks/${task.id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe(TaskStatus.CANCELLED);
  });

  it('forbids a service key from completing a task (requires a user account)', async () => {
    const writeKey = await createKey([Permissions.TASKS_WRITE]);
    const { taskDef } = await createTestTaskSetup(app);
    const created = await withKey(writeKey.token, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: taskDef.id, workflowId: 'wf-key-complete' },
    });
    const task = JSON.parse(created.body);

    const res = await withKey(writeKey.token, {
      method: 'POST',
      url: `/tasks/${task.id}/complete`,
      payload: { data: { DECISION: 'APPROVED' } },
    });
    expect(res.statusCode).toBe(403);
  });
});
