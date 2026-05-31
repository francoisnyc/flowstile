import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  createTestUser,
  createTestGroup,
  loginAs,
  authed,
  createTestTaskSetup,
  cleanupTestData,
} from './helpers.js';
import type { Group } from '../../src/entities/group.entity.js';

describe('POST /tasks/:id/claim — eligibility enforcement', () => {
  let app: FastifyInstance;
  let writePerms: string[];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    writePerms = ['tasks:read', 'tasks:write'];
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  async function makeTask(candidateGroups: string[] = [], candidateUsers: string[] = []) {
    const { taskDef, ...rest } = await createTestTaskSetup(app);
    // Patch the task definition's candidateGroups/candidateUsers directly
    await app.db.query(
      `UPDATE task_definitions SET "candidateGroups" = $1, "candidateUsers" = $2 WHERE id = $3`,
      [candidateGroups, candidateUsers, taskDef.id],
    );
    return rest;
  }

  async function createAndClaim(
    setup: Awaited<ReturnType<typeof createTestTaskSetup>>,
    cookie: string,
    extraGroups: Group[] = [],
  ) {
    // Create a fresh task
    const taskRes = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: {
        taskDefinitionId: setup.taskDef.id,
        workflowId: `wf-claim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    if (taskRes.statusCode !== 201) throw new Error(`Task creation failed: ${taskRes.body}`);
    const taskId = taskRes.json<{ id: string }>().id;

    return authed(app, cookie, { method: 'POST', url: `/tasks/${taskId}/claim` });
  }

  it('allows claim when candidateGroups and candidateUsers are both empty (oversight user)', async () => {
    // Uncandidated tasks are only visible to oversight (tasks:manage). Anyone
    // with oversight can claim them — no eligibility restriction when both lists are empty.
    const setup = await createTestTaskSetup(app);
    const user = await createTestUser(app, { permissions: [...writePerms, 'tasks:manage'] });
    const cookie = await loginAs(app, user.email);

    const taskRes = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: setup.taskDef.id, workflowId: `wf-open-${Date.now()}` },
    });
    expect(taskRes.statusCode).toBe(201);
    const taskId = taskRes.json<{ id: string }>().id;

    const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${taskId}/claim` });
    expect(res.statusCode).toBe(200);
  });

  it('allows claim when user is in a candidateGroup', async () => {
    const group = await createTestGroup(app, `test-group-officers-${Date.now()}`);
    const user = await createTestUser(app, { permissions: writePerms, groups: [group] });
    const cookie = await loginAs(app, user.email);

    const setup = await createTestTaskSetup(app);
    await app.db.query(
      `UPDATE task_definitions SET "candidateGroups" = $1 WHERE id = $2`,
      [[group.name], setup.taskDef.id],
    );

    const taskRes = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: setup.taskDef.id, workflowId: `wf-grp-ok-${Date.now()}` },
    });
    expect(taskRes.statusCode).toBe(201);
    const taskId = taskRes.json<{ id: string }>().id;

    const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${taskId}/claim` });
    expect(res.statusCode).toBe(200);
  });

  it('rejects claim when user is not in any candidateGroup', async () => {
    const group = await createTestGroup(app, `test-group-reviewers-${Date.now()}`);
    const user = await createTestUser(app, { permissions: writePerms, groups: [] });
    const cookie = await loginAs(app, user.email);

    const setup = await createTestTaskSetup(app);
    await app.db.query(
      `UPDATE task_definitions SET "candidateGroups" = $1 WHERE id = $2`,
      [[group.name], setup.taskDef.id],
    );

    const taskRes = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: setup.taskDef.id, workflowId: `wf-grp-no-${Date.now()}` },
    });
    expect(taskRes.statusCode).toBe(201);
    const taskId = taskRes.json<{ id: string }>().id;

    const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${taskId}/claim` });
    // With need-to-know scoping the user can't see the task at all (not in
    // any candidateGroup), so the server returns 404 to avoid leaking existence.
    expect(res.statusCode).toBe(404);
  });

  it('allows claim when user email is in candidateUsers', async () => {
    const user = await createTestUser(app, { permissions: writePerms });
    const cookie = await loginAs(app, user.email);

    const setup = await createTestTaskSetup(app);
    await app.db.query(
      `UPDATE task_definitions SET "candidateUsers" = $1 WHERE id = $2`,
      [[user.email], setup.taskDef.id],
    );

    const taskRes = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: setup.taskDef.id, workflowId: `wf-usr-ok-${Date.now()}` },
    });
    expect(taskRes.statusCode).toBe(201);
    const taskId = taskRes.json<{ id: string }>().id;

    const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${taskId}/claim` });
    expect(res.statusCode).toBe(200);
  });

  it('rejects claim when user email is not in candidateUsers and no candidateGroups', async () => {
    const otherEmail = `other-${Date.now()}@example.com`;
    const user = await createTestUser(app, { permissions: writePerms });
    const cookie = await loginAs(app, user.email);

    const setup = await createTestTaskSetup(app);
    await app.db.query(
      `UPDATE task_definitions SET "candidateUsers" = $1 WHERE id = $2`,
      [[otherEmail], setup.taskDef.id],
    );

    const taskRes = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: setup.taskDef.id, workflowId: `wf-usr-no-${Date.now()}` },
    });
    expect(taskRes.statusCode).toBe(201);
    const taskId = taskRes.json<{ id: string }>().id;

    const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${taskId}/claim` });
    // With need-to-know scoping the user can't see the task (not in candidateUsers),
    // so the server returns 404 to avoid leaking existence.
    expect(res.statusCode).toBe(404);
  });

  it('allows claim when user matches candidateUsers even when candidateGroups is non-empty', async () => {
    const group = await createTestGroup(app, `test-group-other-${Date.now()}`);
    const user = await createTestUser(app, { permissions: writePerms, groups: [] });
    const cookie = await loginAs(app, user.email);

    const setup = await createTestTaskSetup(app);
    await app.db.query(
      `UPDATE task_definitions SET "candidateGroups" = $1, "candidateUsers" = $2 WHERE id = $3`,
      [[group.name], [user.email], setup.taskDef.id],
    );

    const taskRes = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: { taskDefinitionId: setup.taskDef.id, workflowId: `wf-combo-${Date.now()}` },
    });
    expect(taskRes.statusCode).toBe(201);
    const taskId = taskRes.json<{ id: string }>().id;

    const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${taskId}/claim` });
    expect(res.statusCode).toBe(200);
  });
});
