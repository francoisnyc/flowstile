import { FlowstileApiError } from './errors.js';
import type {
  FlowstileClientOptions,
  CreateTaskInput,
  Task,
  AttachmentReference,
  UploadAttachmentInput,
} from './types.js';

export class FlowstileClient {
  private baseUrl: string;
  private auth?: { email: string; password: string };
  private jwt: string | null = null;

  constructor(options: FlowstileClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.auth = options.auth;
  }

  private async ensureAuth(): Promise<void> {
    if (this.jwt || !this.auth) return;

    const response = await fetch(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.auth),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new FlowstileApiError(response.status, '/auth/login', body);
    }

    // Extract JWT from Set-Cookie header
    const setCookie = response.headers.get('set-cookie') ?? '';
    const match = setCookie.match(/flowstile_token=([^;]+)/);
    if (!match) {
      throw new Error('Flowstile auth: no token in Set-Cookie header');
    }
    this.jwt = match[1];
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    await this.ensureAuth();

    const doRequest = async () => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...init?.headers as Record<string, string>,
      };
      if (this.jwt) {
        headers['Authorization'] = `Bearer ${this.jwt}`;
      }

      return fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    };

    let response = await doRequest();

    // Retry once on 401 — token may have expired or been invalidated
    if (response.status === 401 && this.auth) {
      this.jwt = null;
      await this.ensureAuth();
      response = await doRequest();
    }

    if (!response.ok) {
      const body = await response.text();
      throw new FlowstileApiError(response.status, path, body);
    }

    return response.json() as Promise<T>;
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    return this.request<Task>('/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getTask(taskId: string): Promise<Task> {
    return this.request<Task>(`/tasks/${taskId}`);
  }

  cancelTask(taskId: string): Promise<Task> {
    return this.request<Task>(`/tasks/${taskId}/cancel`, { method: 'POST' });
  }

  async uploadAttachment(taskId: string, input: UploadAttachmentInput): Promise<AttachmentReference> {
    await this.ensureAuth();

    const formData = new FormData();
    const blob = input.content instanceof Blob
      ? input.content
      : new Blob([input.content as Buffer], { type: input.contentType });
    formData.append('file', blob, input.fileName);

    const doRequest = async () => {
      const headers: Record<string, string> = {};
      if (this.jwt) headers['Authorization'] = `Bearer ${this.jwt}`;

      return fetch(`${this.baseUrl}/tasks/${taskId}/attachments`, {
        method: 'POST',
        headers,
        body: formData,
      });
    };

    let response = await doRequest();
    if (response.status === 401 && this.auth) {
      this.jwt = null;
      await this.ensureAuth();
      response = await doRequest();
    }

    if (!response.ok) {
      const body = await response.text();
      throw new FlowstileApiError(response.status, `/tasks/${taskId}/attachments`, body);
    }

    return response.json() as Promise<AttachmentReference>;
  }

  async downloadAttachment(taskId: string, attachmentId: string): Promise<Buffer> {
    await this.ensureAuth();

    const doRequest = async () => {
      const headers: Record<string, string> = {};
      if (this.jwt) headers['Authorization'] = `Bearer ${this.jwt}`;
      return fetch(`${this.baseUrl}/tasks/${taskId}/attachments/${attachmentId}/content`, { headers });
    };

    let response = await doRequest();
    if (response.status === 401 && this.auth) {
      this.jwt = null;
      await this.ensureAuth();
      response = await doRequest();
    }

    if (!response.ok) {
      const body = await response.text();
      throw new FlowstileApiError(response.status, `/tasks/${taskId}/attachments/${attachmentId}/content`, body);
    }

    return Buffer.from(await response.arrayBuffer());
  }
}
