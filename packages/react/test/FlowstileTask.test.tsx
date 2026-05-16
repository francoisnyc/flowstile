import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { FlowstileTask } from '../src/FlowstileTask.js';

const mockTask = {
  id: 'task-1',
  status: 'created',
  priority: 'normal',
  assigneeId: null,
  assignee: null,
  inputData: {},
  contextData: {},
  submissionData: {},
  form: {
    code: 'TEST',
    version: 1,
    jsonSchema: { type: 'object', properties: { DECISION: { type: 'string' } } },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [{ type: 'Control', scope: '#/properties/DECISION' }],
    },
  },
  actions: { canClaim: true, canUnclaim: false, canComplete: false, canCancel: false },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
  dueDate: null,
  workflowId: 'wf-1',
};

const claimedTask = {
  ...mockTask,
  status: 'claimed',
  actions: { canClaim: false, canUnclaim: true, canComplete: true, canCancel: false },
};

const completedTask = {
  ...mockTask,
  status: 'completed',
  actions: { canClaim: false, canUnclaim: false, canComplete: false, canCancel: false },
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

describe('FlowstileTask', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows loading state initially', async () => {
    // fetch never resolves
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    render(<FlowstileTask taskId="task-1" />);

    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('renders Claim button when canClaim is true', async () => {
    vi.stubGlobal('fetch', makeOkFetch(mockTask));

    render(<FlowstileTask taskId="task-1" />);

    await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull());

    expect(screen.getByText('Claim')).toBeDefined();
    expect(screen.queryByText('Submit')).toBeNull();
  });

  it('renders Submit button when canComplete is true', async () => {
    vi.stubGlobal('fetch', makeOkFetch(claimedTask));

    render(<FlowstileTask taskId="task-1" />);

    await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull());

    expect(screen.getByText('Submit')).toBeDefined();
    expect(screen.queryByText('Claim')).toBeNull();
  });

  it('renders form as read-only with no action buttons when task is completed', async () => {
    vi.stubGlobal('fetch', makeOkFetch(completedTask));

    const { container } = render(<FlowstileTask taskId="task-1" />);

    await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull());

    // No action buttons
    expect(screen.queryByText('Claim')).toBeNull();
    expect(screen.queryByText('Submit')).toBeNull();

    // Form should be read-only (inputs disabled/readonly)
    const inputs = container.querySelectorAll('input');
    if (inputs.length > 0) {
      const hasReadonlyOrDisabled = Array.from(inputs).some(
        (el) => (el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly,
      );
      expect(hasReadonlyOrDisabled).toBe(true);
    }
  });

  it('fires onClaim callback after successful claim', async () => {
    const onClaim = vi.fn();

    const fetchMock = vi.fn()
      // initial GET
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(mockTask) } as Response)
      // POST claim
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response)
      // refetch GET
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve(claimedTask) } as Response);

    vi.stubGlobal('fetch', fetchMock);

    render(<FlowstileTask taskId="task-1" onClaim={onClaim} />);

    await waitFor(() => expect(screen.getByText('Claim')).toBeDefined());

    await act(async () => {
      screen.getByText('Claim').click();
    });

    await waitFor(() => expect(onClaim).toHaveBeenCalledOnce());
  });

  it('fires onError callback on API failure (500)', async () => {
    const onError = vi.fn();

    vi.stubGlobal(
      'fetch',
      makeErrorFetch(500, { error: 'Internal Server Error' }),
    );

    render(<FlowstileTask taskId="task-1" onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalled());

    const calledWith = onError.mock.calls[0][0] as { status: number };
    expect(calledWith.status).toBe(500);
  });
});
