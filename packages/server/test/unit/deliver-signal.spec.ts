import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliverSignal } from '../../src/signals/deliver-signal.js';

function createMockTemporal(signalFn: () => Promise<void>) {
  return {
    workflow: {
      getHandle: () => ({
        signal: signalFn,
      }),
    },
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('deliverSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('delivers signal on first attempt', async () => {
    const signalFn = vi.fn().mockResolvedValue(undefined);
    const logger = createMockLogger();

    const result = await deliverSignal({
      temporal: createMockTemporal(signalFn) as any,
      workflowId: 'wf-1',
      signalName: 'flowstile:task:completed:task-1',
      payload: { data: { foo: 'bar' } },
      logger: logger as any,
    });

    expect(result).toBe(true);
    expect(signalFn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalled();
  });

  it('retries on transient failure and succeeds', async () => {
    const signalFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(undefined);
    const logger = createMockLogger();

    const promise = deliverSignal({
      temporal: createMockTemporal(signalFn) as any,
      workflowId: 'wf-1',
      signalName: 'flowstile:task:completed:task-1',
      payload: { data: {} },
      logger: logger as any,
    });

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe(true);
    expect(signalFn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns false after all retries exhausted', async () => {
    const signalFn = vi.fn().mockRejectedValue(new Error('down'));
    const logger = createMockLogger();

    const promise = deliverSignal({
      temporal: createMockTemporal(signalFn) as any,
      workflowId: 'wf-1',
      signalName: 'flowstile:task:completed:task-1',
      payload: { data: {} },
      logger: logger as any,
    });

    // Advance past all retry delays (1s + 2s)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toBe(false);
    expect(signalFn).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalled();
  });

  it('does not retry WorkflowNotFoundError', async () => {
    class WorkflowNotFoundError extends Error {
      constructor() {
        super('workflow not found');
        this.name = 'WorkflowNotFoundError';
      }
    }
    const signalFn = vi.fn().mockRejectedValue(new WorkflowNotFoundError());
    const logger = createMockLogger();

    const result = await deliverSignal({
      temporal: createMockTemporal(signalFn) as any,
      workflowId: 'wf-1',
      signalName: 'flowstile:task:completed:task-1',
      payload: { data: {} },
      logger: logger as any,
    });

    expect(result).toBe(false);
    expect(signalFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('works with undefined payload (cancellation signals)', async () => {
    const signalFn = vi.fn().mockResolvedValue(undefined);
    const logger = createMockLogger();

    const result = await deliverSignal({
      temporal: createMockTemporal(signalFn) as any,
      workflowId: 'wf-1',
      signalName: 'flowstile:task:cancelled:task-1',
      payload: undefined,
      logger: logger as any,
    });

    expect(result).toBe(true);
    expect(signalFn).toHaveBeenCalledWith('flowstile:task:cancelled:task-1', undefined);
  });
});
