import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlowstileClient } from '../src/client.js';

function makeFetchMock(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

describe('FlowstileClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches with credentials: include by default', async () => {
    const fetchMock = makeFetchMock(200, { id: 'task-1', status: 'created' });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlowstileClient({});
    await client.getTask('task-1');

    expect(fetchMock).toHaveBeenCalledWith('/tasks/task-1', expect.objectContaining({
      credentials: 'include',
    }));
  });

  it('sends static Bearer token when token option is provided', async () => {
    const fetchMock = makeFetchMock(200, { id: 'task-1', status: 'created' });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlowstileClient({ token: 'my-static-token' });
    await client.getTask('task-1');

    expect(fetchMock).toHaveBeenCalledWith('/tasks/task-1', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer my-static-token',
      }),
    }));
  });

  it('calls getToken before each request and uses result as Bearer', async () => {
    const fetchMock = makeFetchMock(200, { id: 'task-1', status: 'created' });
    vi.stubGlobal('fetch', fetchMock);

    const getToken = vi.fn().mockResolvedValue('dynamic-token');
    const client = new FlowstileClient({ getToken });

    await client.getTask('task-1');

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/tasks/task-1', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer dynamic-token',
      }),
    }));
  });

  it('getToken takes precedence over static token', async () => {
    const fetchMock = makeFetchMock(200, { id: 'task-1', status: 'created' });
    vi.stubGlobal('fetch', fetchMock);

    const getToken = vi.fn().mockResolvedValue('dynamic-token');
    const client = new FlowstileClient({ token: 'static-token', getToken });

    await client.getTask('task-1');

    expect(fetchMock).toHaveBeenCalledWith('/tasks/task-1', expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: 'Bearer dynamic-token',
      }),
    }));
  });

  it('throws FlowstileApiError on non-OK responses (404)', async () => {
    const fetchMock = makeFetchMock(404, { error: 'Task not found' });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlowstileClient({});

    await expect(client.getTask('missing-task')).rejects.toMatchObject({
      name: 'FlowstileApiError',
      status: 404,
      code: 'NOT_FOUND',
      message: 'Task not found',
    });
  });

  it('parses 422 details into validationErrors keyed by JSON Pointer path', async () => {
    const fetchMock = makeFetchMock(422, {
      error: 'Validation failed',
      details: [
        { path: '/data/name', message: 'must not be empty' },
        { path: '/data/name', message: 'must be at least 3 characters' },
        { path: '/data/amount', message: 'must be a number' },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlowstileClient({});

    let thrownError: unknown;
    try {
      await client.completeTask('task-1', { name: '' });
    } catch (e) {
      thrownError = e;
    }

    expect(thrownError).toMatchObject({
      name: 'FlowstileApiError',
      status: 422,
      code: 'VALIDATION_ERROR',
      validationErrors: {
        '/data/name': ['must not be empty', 'must be at least 3 characters'],
        '/data/amount': ['must be a number'],
      },
    });
  });

  it('POST calls include correct method and body (complete sends { data: ... })', async () => {
    const fetchMock = makeFetchMock(204, null);
    // Make ok: true for 204-like response
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.resolve(null),
    } as unknown as Response));

    const client = new FlowstileClient({ baseUrl: 'http://localhost:3000' });
    const submissionData = { decision: 'approved', notes: 'Looks good' };

    await client.completeTask('task-42', submissionData);

    const mockFetch = vi.mocked(globalThis.fetch);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/tasks/task-42/complete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ data: submissionData }),
      }),
    );
  });
});
