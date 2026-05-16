import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFlowstileTask } from '../src/useFlowstileTask.js';

const mockTask = {
  id: 'task-1',
  status: 'created',
  priority: 'normal',
  assigneeId: null,
  assignee: null,
  inputData: { customerName: 'Alice' },
  contextData: { region: 'US' },
  submissionData: {},
  form: {
    code: 'LOAN_REVIEW',
    version: 1,
    jsonSchema: { type: 'object', properties: { DECISION: { type: 'string' } } },
    uiSchema: { type: 'VerticalLayout', elements: [] },
  },
  actions: { canClaim: true, canUnclaim: false, canComplete: false, canCancel: true },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
  dueDate: null,
  workflowId: 'wf-1',
};

function makeOkFetch(body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as Response);
}

function makeErrorFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe('useFlowstileTask', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches task on mount and exposes task, form, and merged data', async () => {
    vi.stubGlobal('fetch', makeOkFetch(mockTask));

    const { result } = renderHook(() => useFlowstileTask('task-1'));

    // Initially loading
    expect(result.current.status).toBe('loading');
    expect(result.current.task).toBeNull();

    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(result.current.task).toEqual(mockTask);
    expect(result.current.form).toEqual(mockTask.form);
    // data merges contextData + inputData + submissionData
    expect(result.current.data).toEqual({
      region: 'US',
      customerName: 'Alice',
    });
    expect(result.current.error).toBeNull();
    expect(result.current.validationErrors).toBeNull();
    expect(result.current.isMutating).toBe(false);
  });

  it('sets status=error and error object on fetch failure (404)', async () => {
    vi.stubGlobal('fetch', makeErrorFetch(404, { error: 'Task not found' }));

    const { result } = renderHook(() => useFlowstileTask('missing-task'));

    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.task).toBeNull();
    expect(result.current.error).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
      message: 'Task not found',
    });
  });

  it('refetches after claim action and updates task status', async () => {
    const claimedTask = { ...mockTask, status: 'claimed', actions: { canClaim: false, canUnclaim: true, canComplete: true, canCancel: true } };

    const fetchMock = vi.fn()
      // initial GET
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockTask) } as Response)
      // POST claim
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response)
      // refetch GET
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(claimedTask) } as Response);

    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFlowstileTask('task-1'));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.task?.status).toBe('created');

    await act(async () => {
      await result.current.claim();
    });

    await waitFor(() => expect(result.current.task?.status).toBe('claimed'));
    expect(result.current.isMutating).toBe(false);
  });

  it('sets isMutating=true while action is in flight', async () => {
    let resolveClaimFetch!: (value: Response) => void;
    const claimPromise = new Promise<Response>((resolve) => { resolveClaimFetch = resolve; });

    const claimedTask = { ...mockTask, status: 'claimed' };

    const fetchMock = vi.fn()
      // initial GET
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockTask) } as Response)
      // POST claim - delayed
      .mockReturnValueOnce(claimPromise)
      // refetch GET
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(claimedTask) } as Response);

    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFlowstileTask('task-1'));

    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Start claim but don't await yet
    let claimPromiseResult: Promise<void>;
    act(() => {
      claimPromiseResult = result.current.claim();
    });

    // isMutating should be true while claim is in flight
    await waitFor(() => expect(result.current.isMutating).toBe(true));

    // Resolve the claim fetch
    act(() => {
      resolveClaimFetch({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response);
    });

    await act(async () => {
      await claimPromiseResult;
    });

    expect(result.current.isMutating).toBe(false);
  });

  it('sets validationErrors on 422 from complete action', async () => {
    const validationErrorBody = {
      error: 'Validation failed',
      details: [
        { path: '/data/DECISION', message: 'must be one of: approved, rejected' },
        { path: '/data/notes', message: 'must not be empty' },
      ],
    };

    const fetchMock = vi.fn()
      // initial GET
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockTask) } as Response)
      // POST complete - returns 422
      .mockResolvedValueOnce({ ok: false, status: 422, json: () => Promise.resolve(validationErrorBody) } as Response);

    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFlowstileTask('task-1'));

    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.complete({ DECISION: 'maybe' }).catch(() => {});
    });

    expect(result.current.validationErrors).toEqual({
      '/data/DECISION': ['must be one of: approved, rejected'],
      '/data/notes': ['must not be empty'],
    });
    expect(result.current.error).toMatchObject({ status: 422, code: 'VALIDATION_ERROR' });
    expect(result.current.isMutating).toBe(false);
  });

  it('refetches when taskId changes', async () => {
    const task2 = { ...mockTask, id: 'task-2', contextData: { region: 'EU' } };

    const fetchMock = vi.fn()
      // initial GET for task-1
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockTask) } as Response)
      // GET for task-2 after rerender
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(task2) } as Response);

    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(({ taskId }) => useFlowstileTask(taskId), {
      initialProps: { taskId: 'task-1' },
    });

    await waitFor(() => expect(result.current.task?.id).toBe('task-1'));

    rerender({ taskId: 'task-2' });

    await waitFor(() => expect(result.current.task?.id).toBe('task-2'));
    expect(result.current.data).toMatchObject({ region: 'EU' });
  });
});
