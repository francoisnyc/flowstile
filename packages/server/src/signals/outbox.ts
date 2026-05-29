import type { DataSource, EntityManager } from 'typeorm';
import type { FastifyBaseLogger } from 'fastify';
import { WorkflowNotFoundError } from '@temporalio/client';
import { SignalOutbox } from '../entities/signal-outbox.entity.js';
import { Task } from '../entities/task.entity.js';
import { OutboxStatus, SignalStatus, TaskStatus } from '../common/enums.js';

export function completedSignalName(taskId: string): string {
  return `flowstile:task:completed:${taskId}`;
}

export function cancelledSignalName(taskId: string): string {
  return `flowstile:task:cancelled:${taskId}`;
}

interface EnqueueParams {
  taskId: string;
  workflowId: string;
  signalName: string;
  payload?: unknown;
  maxAttempts?: number;
}

// Inserts an outbox row. Call inside the same transaction that persists the
// task state change so the delivery intent commits atomically with it.
export async function enqueueSignal(
  manager: EntityManager,
  params: EnqueueParams,
): Promise<SignalOutbox> {
  const repo = manager.getRepository(SignalOutbox);
  const row = repo.create({
    taskId: params.taskId,
    workflowId: params.workflowId,
    signalName: params.signalName,
    payload: params.payload ?? null,
    status: OutboxStatus.PENDING,
    attempts: 0,
    maxAttempts: params.maxAttempts ?? 10,
    nextAttemptAt: new Date(),
    lastError: null,
    deliveredAt: null,
  });
  return repo.save(row);
}

// Resets an existing outbox row (or creates one) so the relay re-attempts
// delivery. Used by the manual retry-signal endpoint.
export async function reenqueueForTask(
  manager: EntityManager,
  task: { id: string; workflowId: string; status: TaskStatus; submissionData: Record<string, unknown>;
    completedAt: Date | null; formDefinitionVersion: number;
    assignee?: { id: string; email: string; displayName: string } | null },
): Promise<SignalOutbox> {
  const repo = manager.getRepository(SignalOutbox);
  const existing = await repo.findOne({ where: { taskId: task.id }, order: { createdAt: 'DESC' } });

  const signalName = task.status === TaskStatus.COMPLETED
    ? completedSignalName(task.id)
    : cancelledSignalName(task.id);

  const payload = task.status === TaskStatus.COMPLETED
    ? buildCompletedPayload(task)
    : null;

  if (existing) {
    existing.status = OutboxStatus.PENDING;
    existing.attempts = 0;
    existing.nextAttemptAt = new Date();
    existing.lastError = null;
    existing.deliveredAt = null;
    existing.signalName = signalName;
    existing.payload = payload;
    existing.workflowId = task.workflowId;
    return repo.save(existing);
  }

  return enqueueSignal(manager, { taskId: task.id, workflowId: task.workflowId, signalName, payload });
}

export function buildCompletedPayload(task: {
  submissionData: Record<string, unknown>;
  completedAt: Date | null;
  formDefinitionVersion: number;
  assignee?: { id: string; email: string; displayName: string } | null;
}) {
  return {
    data: task.submissionData,
    completedBy: task.assignee
      ? { id: task.assignee.id, email: task.assignee.email, displayName: task.assignee.displayName }
      : null,
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    formVersion: task.formDefinitionVersion,
  };
}

// Delivers a single signal. Injected into processOutboxBatch so tests can
// substitute a stub. The production impl wraps the Temporal client.
export type SignalDeliverer = (
  workflowId: string,
  signalName: string,
  payload: unknown | null,
) => Promise<void>;

export interface ProcessOptions {
  batchSize?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface ProcessSummary {
  processed: number;
  delivered: number;
  failed: number;
  retried: number;
}

function backoffMs(attempts: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** (attempts - 1), maxDelayMs);
}

// Drains one batch of due outbox rows. Locks rows FOR UPDATE SKIP LOCKED so
// multiple server instances can run the relay without double-delivering.
// Mirrors each outcome onto the owning task's signalStatus projection.
export async function processOutboxBatch(
  dataSource: DataSource,
  deliver: SignalDeliverer,
  logger: FastifyBaseLogger,
  opts: ProcessOptions = {},
): Promise<ProcessSummary> {
  const batchSize = opts.batchSize ?? 20;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 60_000;

  const summary: ProcessSummary = { processed: 0, delivered: 0, failed: 0, retried: 0 };

  await dataSource.transaction(async (manager) => {
    const outboxRepo = manager.getRepository(SignalOutbox);
    const taskRepo = manager.getRepository(Task);

    const rows = await outboxRepo
      .createQueryBuilder('o')
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .where('o.status = :status', { status: OutboxStatus.PENDING })
      .andWhere('o.nextAttemptAt <= :now', { now: new Date() })
      .orderBy('o.createdAt', 'ASC')
      .limit(batchSize)
      .getMany();

    for (const row of rows) {
      summary.processed++;
      try {
        await deliver(row.workflowId, row.signalName, row.payload);
        row.status = OutboxStatus.DELIVERED;
        row.deliveredAt = new Date();
        row.lastError = null;
        await outboxRepo.save(row);
        await taskRepo.update(
          { id: row.taskId },
          { signalStatus: SignalStatus.DELIVERED, signalDeliveredAt: new Date() },
        );
        summary.delivered++;
        logger.info({ outboxId: row.id, taskId: row.taskId, signalName: row.signalName }, 'Signal delivered');
      } catch (err) {
        row.attempts++;
        row.lastError = err instanceof Error ? err.message : String(err);

        const terminal =
          err instanceof WorkflowNotFoundError || row.attempts >= row.maxAttempts;

        if (terminal) {
          row.status = OutboxStatus.FAILED;
          await outboxRepo.save(row);
          await taskRepo.update(
            { id: row.taskId },
            { signalStatus: SignalStatus.FAILED, signalFailedAt: new Date() },
          );
          summary.failed++;
          logger.error(
            { outboxId: row.id, taskId: row.taskId, workflowId: row.workflowId, attempts: row.attempts, err },
            'Signal delivery failed permanently — workflow may be out of sync',
          );
        } else {
          row.nextAttemptAt = new Date(Date.now() + backoffMs(row.attempts, baseDelayMs, maxDelayMs));
          await outboxRepo.save(row);
          summary.retried++;
          logger.warn(
            { outboxId: row.id, taskId: row.taskId, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt, err },
            'Signal delivery failed, will retry',
          );
        }
      }
    }
  });

  return summary;
}
