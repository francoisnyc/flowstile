import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineTask, defineProcess } from '../src/process.js';

// createTaskAndWait lives in the workflow sandbox; mock the module so we can
// test defineTask / defineProcess in a plain Node.js test environment.
vi.mock('../src/workflows.js', () => ({
  createTaskAndWait: vi.fn(),
}));

import { createTaskAndWait } from '../src/workflows.js';
const mockCreate = vi.mocked(createTaskAndWait);

beforeEach(() => {
  mockCreate.mockReset();
});

describe('defineTask', () => {
  it('stores the task definition code and phase', () => {
    const t = defineTask('APPROVE_ORDER', { phase: 'APPROVAL' });
    expect(t.taskDefinitionCode).toBe('APPROVE_ORDER');
    expect(t.phase).toBe('APPROVAL');
  });

  it('phase: null marks a task as deliberately unphased', () => {
    const t = defineTask('HANDLE_EXCEPTION', { phase: null });
    expect(t.phase).toBeNull();
  });

  it('calls createTaskAndWait with taskDefinitionCode', async () => {
    mockCreate.mockResolvedValue({ taskId: 't1', data: { DECISION: 'APPROVED' }, completedBy: {} as never, completedAt: '', formVersion: 1 });

    const approveOrder = defineTask<{ DECISION: 'APPROVED' | 'REJECTED' }>('APPROVE_ORDER', { phase: null });
    const result = await approveOrder.createAndWait({ inputData: { total: 100 } });

    expect(mockCreate).toHaveBeenCalledWith({
      taskDefinitionCode: 'APPROVE_ORDER',
      inputData: { total: 100 },
    });
    expect(result.data.DECISION).toBe('APPROVED');
  });

  it('merges defaults with per-call input (call wins on collision)', async () => {
    mockCreate.mockResolvedValue({ taskId: 't1', data: {}, completedBy: {} as never, completedAt: '', formVersion: 1 });

    const t = defineTask('MY_TASK', { phase: null, defaults: { priority: 'high', timeoutMs: 60000 } });
    await t.createAndWait({ priority: 'urgent' });

    expect(mockCreate).toHaveBeenCalledWith({
      taskDefinitionCode: 'MY_TASK',
      priority: 'urgent',
      timeoutMs: 60000,
    });
  });

  it('works with no input argument', async () => {
    mockCreate.mockResolvedValue({ taskId: 't1', data: {}, completedBy: {} as never, completedAt: '', formVersion: 1 });

    const t = defineTask('SIMPLE', { phase: null });
    await t.createAndWait();

    expect(mockCreate).toHaveBeenCalledWith({ taskDefinitionCode: 'SIMPLE' });
  });

  it('stores defaults for inspection', () => {
    const t = defineTask('T', { phase: null, defaults: { priority: 'low' } });
    expect(t.defaults).toEqual({ priority: 'low' });
  });
});

describe('defineProcess', () => {
  it('stores name, taskQueue and plan', () => {
    const proc = defineProcess('my-process', {
      taskQueue: 'my-queue',
      plan: ['REVIEW', 'DECIDE'],
      tasks: {},
    });
    expect(proc.name).toBe('my-process');
    expect(proc.taskQueue).toBe('my-queue');
    expect(proc.plan).toEqual(['REVIEW', 'DECIDE']);
  });

  it('defaults to an empty plan', () => {
    const proc = defineProcess('p', { taskQueue: 'q', tasks: {} });
    expect(proc.plan).toEqual([]);
  });

  it('exposes typed tasks (object form)', async () => {
    mockCreate.mockResolvedValue({ taskId: 't1', data: { DECISION: 'REJECTED' }, completedBy: {} as never, completedAt: '', formVersion: 1 });

    interface ApprovalOut extends Record<string, unknown> { DECISION: 'APPROVED' | 'REJECTED' }

    const proc = defineProcess('order', {
      taskQueue: 'q',
      plan: ['APPROVAL'],
      tasks: {
        approve: defineTask<ApprovalOut>('APPROVE', { phase: 'APPROVAL', defaults: { priority: 'high' } }),
      },
    });

    const result = await proc.tasks.approve.createAndWait({ processInstanceId: 'wf-1' });
    expect(result.data.DECISION).toBe('REJECTED');
    expect(mockCreate).toHaveBeenCalledWith({
      taskDefinitionCode: 'APPROVE',
      priority: 'high',
      processInstanceId: 'wf-1',
    });
  });

  it('task-factory form scopes phases to the plan', async () => {
    mockCreate.mockResolvedValue({ taskId: 't1', data: {}, completedBy: {} as never, completedAt: '', formVersion: 1 });

    const proc = defineProcess('loan', {
      taskQueue: 'q',
      plan: ['REVIEW', 'DECIDE'],
    }, (task) => ({
      review: task('REVIEW_APP', { phase: 'REVIEW' }),
      fraud: task('FRAUD_FLAG', { phase: null }),
    }));

    expect(proc.plan).toEqual(['REVIEW', 'DECIDE']);
    expect(proc.tasks.review.phase).toBe('REVIEW');
    expect(proc.tasks.fraud.phase).toBeNull();

    await proc.tasks.review.createAndWait();
    expect(mockCreate).toHaveBeenCalledWith({ taskDefinitionCode: 'REVIEW_APP' });
  });

  it('throws at definition time when a phase is not in the plan', () => {
    expect(() =>
      defineProcess('p', {
        taskQueue: 'q',
        plan: ['REVIEW'],
        tasks: {
          bad: defineTask('TASK', { phase: 'UNDERWRITING' }),
        },
      }),
    ).toThrow(/phase 'UNDERWRITING'.*not in the plan/);
  });

  it('throws for a phased task when the process has no plan', () => {
    expect(() =>
      defineProcess('p', {
        taskQueue: 'q',
        tasks: { bad: defineTask('TASK', { phase: 'REVIEW' }) },
      }),
    ).toThrow(/not in the plan/);
  });
});
