import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WorkflowNotFoundError } from '@temporalio/client';
import { buildApp } from '../../src/app.js';
import { SignalOutbox } from '../../src/entities/signal-outbox.entity.js';
import { Task } from '../../src/entities/task.entity.js';
import { OutboxStatus } from '../../src/common/enums.js';
import {
  processOutboxBatch,
  type SignalDeliverer,
} from '../../src/signals/outbox.js';
import {
  createTestUser,
  loginAs,
  authed,
  createTestTaskSetup,
  cleanupTestData,
} from './helpers.js';

describe('Signal outbox', () => {
  let app: FastifyInstance;
  let cookie: string;
  let taskDefId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // Force the Temporal-enabled gate without a live client. The relay loop
    // does not start (app.temporal is null), so we drive delivery manually.
    (app as unknown as { temporalEnabled: boolean }).temporalEnabled = true;

    const user = await createTestUser(app, { permissions: ['tasks:read', 'tasks:write', 'tasks:manage'] });
    cookie = await loginAs(app, user.email);

    const { taskDef } = await createTestTaskSetup(app);
    taskDefId = taskDef.id;
  });

  afterAll(async () => {
    await app.db.getRepository(SignalOutbox).createQueryBuilder().delete().execute();
    await cleanupTestData(app);
    await app.close();
  });

  const outboxRepo = () => app.db.getRepository(SignalOutbox);
  const taskRepo = () => app.db.getRepository(Task);

  async function createTask() {
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: {
        taskDefinitionId: taskDefId,
        workflowId: `wf-outbox-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function completeTask(id: string) {
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
    const res = await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { DECISION: 'APPROVED' } },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ signalStatus: string }>();
  }

  const ok: SignalDeliverer = async () => {};
  const transientFail: SignalDeliverer = async () => {
    throw new Error('temporal unavailable');
  };
  const workflowGone: SignalDeliverer = async () => {
    throw new WorkflowNotFoundError('gone', 'wf', undefined);
  };

  it('completion enqueues an outbox row in the same transaction', async () => {
    const id = await createTask();
    const body = await completeTask(id);

    expect(body.signalStatus).toBe('pending');

    const rows = await outboxRepo().find({ where: { taskId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].signalName).toBe(`flowstile:task:completed:${id}`);
    expect(rows[0].status).toBe(OutboxStatus.PENDING);
    expect((rows[0].payload as { data: unknown }).data).toEqual({ DECISION: 'APPROVED' });
  });

  it('cancellation enqueues a cancelled signal with null payload', async () => {
    const id = await createTask();
    const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/cancel` });
    expect(res.statusCode).toBe(200);

    const rows = await outboxRepo().find({ where: { taskId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].signalName).toBe(`flowstile:task:cancelled:${id}`);
    expect(rows[0].payload).toBeNull();
  });

  it('relay delivers a pending signal and projects delivered onto the task', async () => {
    const id = await createTask();
    await completeTask(id);

    const summary = await processOutboxBatch(app.db, ok, app.log);
    expect(summary.delivered).toBeGreaterThanOrEqual(1);

    const row = await outboxRepo().findOneOrFail({ where: { taskId: id } });
    expect(row.status).toBe(OutboxStatus.DELIVERED);
    expect(row.deliveredAt).not.toBeNull();

    const task = await taskRepo().findOneOrFail({ where: { id } });
    expect(task.signalStatus).toBe('delivered');
    expect(task.signalDeliveredAt).not.toBeNull();
  });

  it('relay reschedules with backoff on a transient error', async () => {
    const id = await createTask();
    await completeTask(id);

    const summary = await processOutboxBatch(app.db, transientFail, app.log, { baseDelayMs: 5000 });
    expect(summary.retried).toBeGreaterThanOrEqual(1);

    const row = await outboxRepo().findOneOrFail({ where: { taskId: id } });
    expect(row.status).toBe(OutboxStatus.PENDING);
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastError).toContain('temporal unavailable');

    // Task stays pending while retries are outstanding
    const task = await taskRepo().findOneOrFail({ where: { id } });
    expect(task.signalStatus).toBe('pending');
  });

  it('relay marks failed immediately when the workflow is gone', async () => {
    const id = await createTask();
    await completeTask(id);

    const summary = await processOutboxBatch(app.db, workflowGone, app.log);
    expect(summary.failed).toBeGreaterThanOrEqual(1);

    const row = await outboxRepo().findOneOrFail({ where: { taskId: id } });
    expect(row.status).toBe(OutboxStatus.FAILED);

    const task = await taskRepo().findOneOrFail({ where: { id } });
    expect(task.signalStatus).toBe('failed');
    expect(task.signalFailedAt).not.toBeNull();
  });

  it('relay marks failed once maxAttempts is exhausted', async () => {
    const id = await createTask();
    await completeTask(id);

    // Bump attempts to one short of the cap so the next failure is terminal
    const row = await outboxRepo().findOneOrFail({ where: { taskId: id } });
    row.attempts = row.maxAttempts - 1;
    await outboxRepo().save(row);

    await processOutboxBatch(app.db, transientFail, app.log);

    const after = await outboxRepo().findOneOrFail({ where: { taskId: id } });
    expect(after.status).toBe(OutboxStatus.FAILED);
    expect(after.attempts).toBe(after.maxAttempts);
  });

  it('respects batchSize and only processes due rows', async () => {
    const ids = await Promise.all([createTask(), createTask(), createTask()]);
    for (const id of ids) await completeTask(id);

    const summary = await processOutboxBatch(app.db, ok, app.log, { batchSize: 2 });
    expect(summary.processed).toBe(2);
  });

  it('retry-signal re-enqueues a failed signal as pending', async () => {
    const id = await createTask();
    await completeTask(id);

    // Drive it to failed
    await processOutboxBatch(app.db, workflowGone, app.log);
    let row = await outboxRepo().findOneOrFail({ where: { taskId: id } });
    expect(row.status).toBe(OutboxStatus.FAILED);

    const res = await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/retry-signal` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ signalStatus: string }>().signalStatus).toBe('pending');

    row = await outboxRepo().findOneOrFail({ where: { taskId: id } });
    expect(row.status).toBe(OutboxStatus.PENDING);
    expect(row.attempts).toBe(0);

    const task = await taskRepo().findOneOrFail({ where: { id } });
    expect(task.signalStatus).toBe('pending');
  });
});
