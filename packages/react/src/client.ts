import type { FlowstileApiError, Task, UseFlowstileTaskOptions, AttachmentRef } from './types.js';

// Error body shape from the Flowstile server
interface ApiErrorBody {
  error?: string;
  message?: string;
  details?: Array<{ path: string; message: string }>;
}

class FlowstileApiErrorImpl extends Error implements FlowstileApiError {
  status: number;
  code: string;
  details?: unknown;
  validationErrors?: Record<string, string[]>;

  constructor(status: number, body: ApiErrorBody) {
    const message = body.error ?? body.message ?? `Request failed with status ${status}`;
    super(message);
    this.name = 'FlowstileApiError';
    this.status = status;
    this.code = statusToCode(status);
    this.details = body.details;

    // Parse 422 details into validationErrors keyed by JSON Pointer path
    if (status === 422 && Array.isArray(body.details)) {
      this.validationErrors = {};
      for (const detail of body.details) {
        const path = detail.path;
        if (!this.validationErrors[path]) {
          this.validationErrors[path] = [];
        }
        this.validationErrors[path].push(detail.message);
      }
    }
  }
}

function statusToCode(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 422: return 'VALIDATION_ERROR';
    default: return 'UNKNOWN';
  }
}

export class FlowstileClient {
  private baseUrl: string;
  private token?: string;
  private getToken?: () => Promise<string>;

  constructor(opts: UseFlowstileTaskOptions) {
    this.baseUrl = opts.baseUrl ?? '';
    this.token = opts.token;
    this.getToken = opts.getToken;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // getToken takes precedence over static token
    if (this.getToken) {
      const token = await this.getToken();
      headers['Authorization'] = `Bearer ${token}`;
    } else if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      credentials: 'include',
      ...init,
      headers,
    });

    if (!res.ok) {
      let body: ApiErrorBody;
      try {
        body = await res.json() as ApiErrorBody;
      } catch {
        body = { error: `Request failed with status ${res.status}` };
      }
      throw new FlowstileApiErrorImpl(res.status, body);
    }

    return res.json() as Promise<T>;
  }

  async getTask(taskId: string): Promise<Task> {
    return this.request<Task>(`/tasks/${taskId}`);
  }

  async claimTask(taskId: string): Promise<void> {
    await this.request(`/tasks/${taskId}/claim`, { method: 'POST' });
  }

  async unclaimTask(taskId: string): Promise<void> {
    await this.request(`/tasks/${taskId}/unclaim`, { method: 'POST' });
  }

  async completeTask(taskId: string, data: Record<string, unknown>): Promise<void> {
    await this.request(`/tasks/${taskId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.request(`/tasks/${taskId}/cancel`, { method: 'POST' });
  }

  async uploadAttachment(taskId: string, file: File): Promise<AttachmentRef> {
    const headers: Record<string, string> = {};
    if (this.getToken) {
      headers['Authorization'] = `Bearer ${await this.getToken()}`;
    } else if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const formData = new FormData();
    formData.append('file', file, file.name);

    const res = await fetch(`${this.baseUrl}/tasks/${taskId}/attachments`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: formData,
    });

    if (!res.ok) {
      let body: ApiErrorBody;
      try { body = await res.json() as ApiErrorBody; } catch { body = {}; }
      throw new FlowstileApiErrorImpl(res.status, body);
    }

    return res.json() as Promise<AttachmentRef>;
  }

  getAttachmentUrl(taskId: string, attachmentId: string): string {
    return `${this.baseUrl}/tasks/${taskId}/attachments/${attachmentId}/content`;
  }
}
