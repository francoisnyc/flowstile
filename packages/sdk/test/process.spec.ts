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
  it('stores the task definition code', () => {
    const t = defineTask('APPROVE_ORDER');
    expect(t.taskDefinitionCode).toBe('APPROVE_ORDER');
  });

  it('calls createTaskAndWait with taskDefinitionCode', async () => {
    mockCreate.mockResolvedValue({ taskId: 't1', data: { DECISION: 'APPROVED' }, completedBy: {} as never, completedAt: '', formVersion: 1 });

    const approveOrder = defineTask<{ DECISION: 'APPROVED' | 'REJECTED' }>('APPROVE_ORDER');
    const result = await approveOrder.createAndWait({ inputData: { total: 100 } });

    expect(mockCreate).toHaveBeenCalledWith({
      taskDefinitionCode: 'APPROVE_ORDER',
      inputData: { total: 100 },
    });
    expect(result.data.DECISION).toBe('APPROVED');
  });

  it('merges defaults with per-call input (call wins on collision)', async () => {
    mockCreate.mockResolvedValue({ taskId: 't1', data: {}, completedBy: {} as never, completedAt: '', formVersion: 1 });

    const t = defineTask('MY_TASK', { priority: 'high', timeoutMs: 60000 });
    await t.createAndWait({ priority: 'urgent' });

    expect(mockCreate).toHaveBeenCalledWith({
      taskDefinitionCode: 'MY_TASK',
      priority: 'urgent',
      timeoutMs: 60000,
    });
  });

  it('works with no input argument', async () => {
    mockCreate.mockResolvedValue({ taskId: 't1', data: {}, completedBy: {} as never, completedAt: '', formVersion: 1 });

    const t = defineTask('SIMPLE');
    await t.createAndWait();

    expect(mockCreate).toHaveBeenCalledWith({ taskDefinitionCode: 'SIMPLE' });
  });

  it('stores defaults for inspection', () => {
    const t = defineTask('T', { priority: 'low' });
    expect(t.defaults).toEqual({ priority: 'low' });
  });
});

describe('defineProcess', () => {
  it('stores name and taskQueue', () => {
    const proc = defineProcess('my-process', {
      taskQueue: 'my-queue',
      tasks: {},
    });
    expect(proc.name).toBe('my-process');
    expect(proc.taskQueue).toBe('my-queue');
  });

  it('exposes typed tasks', async () => {
    mockCreate.mockResolvedValue({ taskId: 't1', data: { DECISION: 'REJECTED' }, completedBy: {} as never, completedAt: '', formVersion: 1 });

    interface ApprovalOut extends Record<string, unknown> { DECISION: 'APPROVED' | 'REJECTED' }

    const proc = defineProcess('order', {
      taskQueue: 'q',
      tasks: {
        approve: defineTask<ApprovalOut>('APPROVE', { priority: 'high' }),
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
});
