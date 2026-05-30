import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FlowstileClient } from '../src/client.js';
import { FlowstileApiError } from '../src/errors.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function cookieResponse(token: string) {
  const res = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Set-Cookie': `flowstile_token=${token}; Path=/; HttpOnly` },
  });
  return res;
}

describe('FlowstileClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('authentication', () => {
    it('authenticates on first request and caches the token', async () => {
      const client = new FlowstileClient({
        baseUrl: 'http://localhost:3000',
        auth: { email: 'svc@test.local', password: 'secret' },
      });

      mockFetch
        .mockResolvedValueOnce(cookieResponse('jwt-abc'))
        .mockResolvedValueOnce(jsonResponse({ id: 't1', status: 'created' }));

      const task = await client.getTask('t1');
      expect(task).toEqual({ id: 't1', status: 'created' });

      // Login was called
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/auth/login', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'svc@test.local', password: 'secret' }),
      }));

      // Subsequent request uses cached token (no new login call)
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 't2', status: 'claimed' }));
      await client.getTask('t2');

      // Should be 3 total calls: login, getTask(t1), getTask(t2) — no second login
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('throws when login response has no Set-Cookie token', async () => {
      const client = new FlowstileClient({
        baseUrl: 'http://localhost:3000',
        auth: { email: 'svc@test.local', password: 'secret' },
      });

      mockFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await expect(client.getTask('t1')).rejects.toThrow('no token in Set-Cookie');
    });

    it('throws FlowstileApiError when login fails', async () => {
      const client = new FlowstileClient({
        baseUrl: 'http://localhost:3000',
        auth: { email: 'bad@test.local', password: 'wrong' },
      });

      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

      await expect(client.getTask('t1')).rejects.toThrow(FlowstileApiError);
    });
  });

  describe('401 retry', () => {
    it('retries once on 401 by re-authenticating', async () => {
      const client = new FlowstileClient({
        baseUrl: 'http://localhost:3000',
        auth: { email: 'svc@test.local', password: 'secret' },
      });

      // Initial auth
      mockFetch.mockResolvedValueOnce(cookieResponse('jwt-old'));
      // First request returns 401 (token expired)
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
      // Re-auth
      mockFetch.mockResolvedValueOnce(cookieResponse('jwt-new'));
      // Retry succeeds
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 't1', status: 'created' }));

      const task = await client.getTask('t1');
      expect(task).toEqual({ id: 't1', status: 'created' });
      // login, request(401), login, request(200)
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('throws on 401 if no auth credentials configured', async () => {
      const client = new FlowstileClient({ baseUrl: 'http://localhost:3000' });

      // No auth — request goes directly, no login
      mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

      await expect(client.getTask('t1')).rejects.toThrow(FlowstileApiError);
    });
  });

  describe('API methods', () => {
    let client: FlowstileClient;

    beforeEach(() => {
      client = new FlowstileClient({
        baseUrl: 'http://localhost:3000',
        auth: { email: 'svc@test.local', password: 'pass' },
      });
      mockFetch.mockResolvedValueOnce(cookieResponse('jwt-test'));
    });

    it('createTask sends POST /tasks', async () => {
      const taskData = { id: 'new-task', status: 'created' as const };
      mockFetch.mockResolvedValueOnce(jsonResponse(taskData));

      const result = await client.createTask({
        taskDefinitionId: 'td-1',
        workflowId: 'wf-1',
        inputData: { orderId: 'ORD-1' },
      });

      expect(result).toEqual(taskData);
      const createCall = mockFetch.mock.calls[1];
      expect(createCall[0]).toBe('http://localhost:3000/tasks');
      expect(JSON.parse(createCall[1].body)).toEqual({
        taskDefinitionId: 'td-1',
        workflowId: 'wf-1',
        inputData: { orderId: 'ORD-1' },
      });
    });

    it('cancelTask sends POST /tasks/:id/cancel', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 't1', status: 'cancelled' }));

      const result = await client.cancelTask('t1');
      expect(result.status).toBe('cancelled');

      const cancelCall = mockFetch.mock.calls[1];
      expect(cancelCall[0]).toBe('http://localhost:3000/tasks/t1/cancel');
      expect(cancelCall[1].method).toBe('POST');
    });

    it('throws FlowstileApiError on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      const err = await client.getTask('missing').catch((e) => e);
      expect(err).toBeInstanceOf(FlowstileApiError);
      expect(err.statusCode).toBe(404);
      expect(err.path).toBe('/tasks/missing');
    });

    it('listCases sends GET /cases with no query when no filters', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ items: [], total: 0, limit: 50, offset: 0 }));

      const result = await client.listCases();
      expect(result).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
      expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:3000/cases');
    });

    it('listCases encodes status, limit, and offset into the query string', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ items: [], total: 0, limit: 10, offset: 20 }));

      await client.listCases({ status: 'in_progress', limit: 10, offset: 20 });
      expect(mockFetch.mock.calls[1][0]).toBe(
        'http://localhost:3000/cases?status=in_progress&limit=10&offset=20',
      );
    });

    it('getCase sends GET /cases/:id', async () => {
      const detail = { id: 'c1', processInstanceId: 'wf-1', tasks: [], attachments: [] };
      mockFetch.mockResolvedValueOnce(jsonResponse(detail));

      const result = await client.getCase('c1');
      expect(result).toEqual(detail);
      expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:3000/cases/c1');
    });

    it('getCaseByProcessInstance URL-encodes the processInstanceId', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'c1', processInstanceId: 'loan/42' }));

      await client.getCaseByProcessInstance('loan/42');
      expect(mockFetch.mock.calls[1][0]).toBe(
        'http://localhost:3000/cases/by-process-instance/loan%2F42',
      );
    });

    it('setCaseVariables sends PATCH with a merge body', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ id: 'c1', processInstanceId: 'wf-1', variables: { stage: 'review' } }),
      );

      const result = await client.setCaseVariables('wf-1', { stage: 'review' });
      expect(result.variables).toEqual({ stage: 'review' });

      const call = mockFetch.mock.calls[1];
      expect(call[0]).toBe('http://localhost:3000/cases/by-process-instance/wf-1/variables');
      expect(call[1].method).toBe('PATCH');
      expect(JSON.parse(call[1].body)).toEqual({ variables: { stage: 'review' } });
    });
  });
});
