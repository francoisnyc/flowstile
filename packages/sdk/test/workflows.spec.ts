import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockCreateFlowstileTask,
  mockCancelFlowstileTask,
  mockCondition,
  mockDefineSignal,
  mockSetHandler,
  mockWorkflowInfo,
  mockIsCancellation,
} = vi.hoisted(() => ({
  mockCreateFlowstileTask: vi.fn(),
  mockCancelFlowstileTask: vi.fn(),
  mockCondition: vi.fn(),
  mockDefineSignal: vi.fn(),
  mockSetHandler: vi.fn(),
  mockWorkflowInfo: vi.fn(),
  mockIsCancellation: vi.fn(),
}));

vi.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({
    createFlowstileTask: mockCreateFlowstileTask,
    cancelFlowstileTask: mockCancelFlowstileTask,
  }),
  defineSignal: (...args: unknown[]) => mockDefineSignal(...args),
  setHandler: (...args: unknown[]) => mockSetHandler(...args),
  condition: (...args: unknown[]) => mockCondition(...args),
  workflowInfo: () => mockWorkflowInfo(),
  isCancellation: (...args: unknown[]) => mockIsCancellation(...args),
  CancellationScope: {
    nonCancellable: (fn: () => Promise<void>) => fn(),
  },
}));

import { createTaskAndWait } from '../src/workflows.js';
import { TaskTimeoutError, TaskCancelledError } from '../src/errors.js';

describe('createTaskAndWait', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkflowInfo.mockReturnValue({ workflowId: 'test-wf-1' });
    mockCreateFlowstileTask.mockResolvedValue({ id: 'task-123' });
    mockDefineSignal.mockImplementation((name: string) => ({ name }));
  });

  it('returns task result on successful completion (no timeout)', async () => {
    const payload = {
      data: { DECISION: 'APPROVED' },
      completedBy: { id: 'u1', email: 'alice@test.local', displayName: 'Alice' },
      completedAt: '2026-05-10T12:00:00Z',
      formVersion: 1,
    };

    mockCondition.mockImplementation((fn: () => boolean) => {
      const completedHandler = mockSetHandler.mock.calls.find(
        ([signal]) => signal.name === 'flowstile:task:completed:task-123',
      );
      if (completedHandler) completedHandler[1](payload);
      return Promise.resolve(true);
    });

    const result = await createTaskAndWait({
      taskDefinitionId: 'td-1',
      inputData: { orderId: 'ORD-1' },
    });

    expect(result).toEqual({
      taskId: 'task-123',
      data: { DECISION: 'APPROVED' },
      completedBy: { id: 'u1', email: 'alice@test.local', displayName: 'Alice' },
      completedAt: '2026-05-10T12:00:00Z',
      formVersion: 1,
    });

    expect(mockCreateFlowstileTask).toHaveBeenCalledWith({
      taskDefinitionId: 'td-1',
      inputData: { orderId: 'ORD-1' },
      workflowId: 'test-wf-1',
    });

    // condition called with undefined timeout (no timeoutMs provided)
    expect(mockCondition).toHaveBeenCalledWith(expect.any(Function), undefined);
  });

  it('returns task result on successful completion (with timeout, before expiry)', async () => {
    const payload = {
      data: { status: 'CONFIRMED' },
      completedBy: { id: 'u2', email: 'bob@test.local', displayName: 'Bob' },
      completedAt: '2026-05-10T13:00:00Z',
      formVersion: 2,
    };

    mockCondition.mockImplementation((fn: () => boolean, timeoutMs: number) => {
      const completedHandler = mockSetHandler.mock.calls.find(
        ([signal]) => signal.name === 'flowstile:task:completed:task-123',
      );
      if (completedHandler) completedHandler[1](payload);
      return Promise.resolve(true);
    });

    const result = await createTaskAndWait({
      taskDefinitionId: 'td-2',
      timeoutMs: 60000,
    });

    expect(result.data).toEqual({ status: 'CONFIRMED' });
    expect(mockCondition).toHaveBeenCalledWith(expect.any(Function), 60000);
  });

  it('throws TaskTimeoutError and cancels task when timeout expires', async () => {
    mockCondition.mockResolvedValue(false);
    mockCancelFlowstileTask.mockResolvedValue({ id: 'task-123', status: 'cancelled' });

    await expect(
      createTaskAndWait({ taskDefinitionId: 'td-1', timeoutMs: 5000 }),
    ).rejects.toThrow(TaskTimeoutError);

    expect(mockCancelFlowstileTask).toHaveBeenCalledWith('task-123');
  });

  it('throws TaskTimeoutError even if cancel fails (best-effort)', async () => {
    mockCondition.mockResolvedValue(false);
    mockCancelFlowstileTask.mockRejectedValue(new Error('task already claimed'));

    await expect(
      createTaskAndWait({ taskDefinitionId: 'td-1', timeoutMs: 10000 }),
    ).rejects.toThrow(TaskTimeoutError);
  });

  it('throws TaskCancelledError when cancellation signal received (no timeout)', async () => {
    mockCondition.mockImplementation((fn: () => boolean) => {
      const cancelHandler = mockSetHandler.mock.calls.find(
        ([signal]) => signal.name === 'flowstile:task:cancelled:task-123',
      );
      if (cancelHandler) cancelHandler[1]();
      return Promise.resolve(true);
    });

    await expect(
      createTaskAndWait({ taskDefinitionId: 'td-1' }),
    ).rejects.toThrow(TaskCancelledError);
  });

  it('throws TaskCancelledError when cancellation signal received (with timeout)', async () => {
    mockCondition.mockImplementation((fn: () => boolean, timeoutMs: number) => {
      const cancelHandler = mockSetHandler.mock.calls.find(
        ([signal]) => signal.name === 'flowstile:task:cancelled:task-123',
      );
      if (cancelHandler) cancelHandler[1]();
      return Promise.resolve(true);
    });

    await expect(
      createTaskAndWait({ taskDefinitionId: 'td-1', timeoutMs: 30000 }),
    ).rejects.toThrow(TaskCancelledError);
  });

  it('registers signal handlers for both completed and cancelled signals', async () => {
    mockCondition.mockImplementation((fn: () => boolean) => {
      const completedHandler = mockSetHandler.mock.calls.find(
        ([signal]) => signal.name === 'flowstile:task:completed:task-123',
      );
      if (completedHandler) {
        completedHandler[1]({
          data: {},
          completedBy: { id: 'u1', email: 'a@b.c', displayName: 'A' },
          completedAt: '2026-01-01T00:00:00Z',
          formVersion: 1,
        });
      }
      return Promise.resolve(true);
    });

    await createTaskAndWait({ taskDefinitionId: 'td-1' });

    expect(mockDefineSignal).toHaveBeenCalledWith('flowstile:task:completed:task-123');
    expect(mockDefineSignal).toHaveBeenCalledWith('flowstile:task:cancelled:task-123');
    expect(mockSetHandler).toHaveBeenCalledTimes(2);
  });

  describe('workflow cancellation', () => {
    it('cancels the Flowstile task when workflow is cancelled', async () => {
      const cancellationError = new Error('Workflow cancelled');
      mockCondition.mockRejectedValue(cancellationError);
      mockIsCancellation.mockReturnValue(true);
      mockCancelFlowstileTask.mockResolvedValue({ id: 'task-123', status: 'cancelled' });

      await expect(
        createTaskAndWait({ taskDefinitionId: 'td-1' }),
      ).rejects.toThrow(cancellationError);

      expect(mockIsCancellation).toHaveBeenCalledWith(cancellationError);
      expect(mockCancelFlowstileTask).toHaveBeenCalledWith('task-123');
    });

    it('still throws if task cancel fails during workflow cancellation', async () => {
      const cancellationError = new Error('Workflow cancelled');
      mockCondition.mockRejectedValue(cancellationError);
      mockIsCancellation.mockReturnValue(true);
      mockCancelFlowstileTask.mockRejectedValue(new Error('already completed'));

      await expect(
        createTaskAndWait({ taskDefinitionId: 'td-1' }),
      ).rejects.toThrow(cancellationError);

      expect(mockCancelFlowstileTask).toHaveBeenCalledWith('task-123');
    });

    it('re-throws non-cancellation errors without cancelling task', async () => {
      const unexpectedError = new Error('Something unexpected');
      mockCondition.mockRejectedValue(unexpectedError);
      mockIsCancellation.mockReturnValue(false);

      await expect(
        createTaskAndWait({ taskDefinitionId: 'td-1' }),
      ).rejects.toThrow(unexpectedError);

      expect(mockCancelFlowstileTask).not.toHaveBeenCalled();
    });
  });
});
