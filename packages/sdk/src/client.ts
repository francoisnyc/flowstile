import { FlowstileApiError } from './errors.js';
import type {
  FlowstileClientOptions,
  CreateTaskInput,
  Task,
  AttachmentReference,
  UploadAttachmentInput,
  Case,
  CaseSummary,
  ListCasesInput,
  Paginated,
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

  listCases(input: ListCasesInput = {}): Promise<Paginated<CaseSummary>> {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    if (input.offset !== undefined) params.set('offset', String(input.offset));
    const qs = params.toString();
    return this.request<Paginated<CaseSummary>>(`/cases${qs ? `?${qs}` : ''}`);
  }

  getCase(caseId: string): Promise<Case> {
    return this.request<Case>(`/cases/${caseId}`);
  }

  getCaseByProcessInstance(processInstanceId: string): Promise<Case> {
    return this.request<Case>(`/cases/by-process-instance/${encodeURIComponent(processInstanceId)}`);
  }

  // Merges the given keys onto the case's variables (shallow). Case variables are
  // a denormalized display projection — not schema-validated, and not a source of
  // truth (the workflow and task submissionData remain authoritative).
  setCaseVariables(
    processInstanceId: string,
    variables: Record<string, unknown>,
  ): Promise<{ id: string; processInstanceId: string; variables: Record<string, unknown> | null }> {
    return this.request(
      `/cases/by-process-instance/${encodeURIComponent(processInstanceId)}/variables`,
      { method: 'PATCH', body: JSON.stringify({ variables }) },
    );
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
