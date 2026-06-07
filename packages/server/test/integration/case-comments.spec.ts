import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  createTestUser,
  createTestTaskSetup,
  loginAs,
  authed,
  cleanupTestData,
  createTestGroup,
} from './helpers.js';
import { Permissions } from '../../src/common/permissions.js';
import { Case } from '../../src/entities/case.entity.js';

describe('Case comments', () => {
  let app: FastifyInstance;
  let writerCookie: string;
  let readerCookie: string;
  let outsiderCookie: string;
  let caseId: string;
  let processInstanceId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // User with tasks:read + tasks:write — can see case and post comments
    const group = await createTestGroup(app, `test-group-${Date.now()}`);
    const writer = await createTestUser(app, {
      permissions: [Permissions.TASKS_READ, Permissions.TASKS_WRITE],
      groups: [group],
    });
    writerCookie = await loginAs(app, writer.email);

    // User with only tasks:read + tasks:manage — can see case (oversight) but cannot post comments
    // NOTE: tasks:manage gives case oversight, so this user can see all cases.
    // They lack tasks:write, so they cannot post comments (403).
    const reader = await createTestUser(app, {
      permissions: [Permissions.TASKS_READ, Permissions.TASKS_MANAGE],
    });
    readerCookie = await loginAs(app, reader.email);

    // User with tasks:read + tasks:write but no group membership — cannot see the case
    const outsider = await createTestUser(app, {
      permissions: [Permissions.TASKS_READ, Permissions.TASKS_WRITE],
    });
    outsiderCookie = await loginAs(app, outsider.email);

    // Create a task (which auto-creates a case) with candidateGroups
    const { taskDef } = await createTestTaskSetup(app);
    processInstanceId = `test-comments-${Date.now()}`;
    const taskRes = await authed(app, writerCookie, {
      method: 'POST',
      url: '/tasks',
      payload: {
        taskDefinitionId: taskDef.id,
        workflowId: `wf-${Date.now()}`,
        processInstanceId,
        candidateGroups: [group.name],
      },
    });
    expect(taskRes.statusCode).toBe(201);

    // Look up the case
    const c = await app.db.getRepository(Case).findOneBy({ processInstanceId });
    expect(c).toBeTruthy();
    caseId = c!.id;
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  describe('POST /cases/:id/comments', () => {
    it('creates a comment (201)', async () => {
      const res = await authed(app, writerCookie, {
        method: 'POST',
        url: `/cases/${caseId}/comments`,
        payload: { body: 'Looks good to me' },
      });
      expect(res.statusCode).toBe(201);
      const comment = res.json();
      expect(comment.id).toBeDefined();
      expect(comment.caseId).toBe(caseId);
      expect(comment.author).toMatchObject({ email: expect.stringContaining('test-') });
      expect(comment.body).toBe('Looks good to me');
      expect(comment.createdAt).toBeDefined();
    });

    it('rejects empty body (400)', async () => {
      const res = await authed(app, writerCookie, {
        method: 'POST',
        url: `/cases/${caseId}/comments`,
        payload: { body: '' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects body over 2000 characters (400)', async () => {
      const res = await authed(app, writerCookie, {
        method: 'POST',
        url: `/cases/${caseId}/comments`,
        payload: { body: 'x'.repeat(2001) },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects missing body field (400)', async () => {
      const res = await authed(app, writerCookie, {
        method: 'POST',
        url: `/cases/${caseId}/comments`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/cases/${caseId}/comments`,
        payload: { body: 'anon' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 without tasks:write', async () => {
      const res = await authed(app, readerCookie, {
        method: 'POST',
        url: `/cases/${caseId}/comments`,
        payload: { body: 'reader trying to post' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 404 for case the user cannot see (need-to-know)', async () => {
      const res = await authed(app, outsiderCookie, {
        method: 'POST',
        url: `/cases/${caseId}/comments`,
        payload: { body: 'outsider' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for non-existent case', async () => {
      const res = await authed(app, writerCookie, {
        method: 'POST',
        url: '/cases/00000000-0000-0000-0000-000000000000/comments',
        payload: { body: 'ghost' },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /cases/:id/comments', () => {
    it('returns comments in createdAt ascending order', async () => {
      // Add a second comment so we can verify ordering
      await authed(app, writerCookie, {
        method: 'POST',
        url: `/cases/${caseId}/comments`,
        payload: { body: 'Second comment' },
      });

      const res = await authed(app, writerCookie, {
        method: 'GET',
        url: `/cases/${caseId}/comments`,
      });
      expect(res.statusCode).toBe(200);
      const { items } = res.json();
      expect(items.length).toBeGreaterThanOrEqual(2);
      // Verify ascending order
      for (let i = 1; i < items.length; i++) {
        expect(new Date(items[i].createdAt).getTime())
          .toBeGreaterThanOrEqual(new Date(items[i - 1].createdAt).getTime());
      }
    });

    it('returns empty array for case with no comments', async () => {
      // Create a fresh case with no comments
      const { taskDef } = await createTestTaskSetup(app);
      const pid = `test-no-comments-${Date.now()}`;
      await authed(app, writerCookie, {
        method: 'POST',
        url: '/tasks',
        payload: {
          taskDefinitionId: taskDef.id,
          workflowId: `wf-${Date.now()}`,
          processInstanceId: pid,
          candidateGroups: ['test-group-' + Date.now()],
        },
      });
      const freshCase = await app.db.getRepository(Case).findOneBy({ processInstanceId: pid });
      if (freshCase) {
        const res = await authed(app, readerCookie, {
          method: 'GET',
          url: `/cases/${freshCase.id}/comments`,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().items).toEqual([]);
      }
    });

    it('returns 404 for case the user cannot see', async () => {
      const res = await authed(app, outsiderCookie, {
        method: 'GET',
        url: `/cases/${caseId}/comments`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /cases/:id — commentCount', () => {
    it('includes commentCount in case detail', async () => {
      const res = await authed(app, writerCookie, {
        method: 'GET',
        url: `/cases/${caseId}`,
      });
      expect(res.statusCode).toBe(200);
      const detail = res.json();
      expect(typeof detail.commentCount).toBe('number');
      expect(detail.commentCount).toBeGreaterThanOrEqual(2);
    });
  });
});
