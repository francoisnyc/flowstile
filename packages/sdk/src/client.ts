import { FlowstileApiError } from './errors.js';
import type {
  FlowstileClientOptions,
  CreateTaskInput,
  Task,
  AttachmentReference,
  UploadAttachmentInput,
  Case,
  CaseSummary,
  CaseEntityResult,
  JsonPatchOperation,
  ListCasesInput,
  Paginated,
} from './types.js';

export class FlowstileClient {
  private baseUrl: string;
  private apiKey?: string;
  private auth?: { email: string; password: string };
  private jwt: string | null = null;

  constructor(options: FlowstileClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.auth = options.auth;
  }

  // The Authorization header value for the current credential, or null if none.
  private authHeader(): string | null {
    if (this.apiKey) return `Bearer ${this.apiKey}`;
    if (this.jwt) return `Bearer ${this.jwt}`;
    return null;
  }

  private async ensureAuth(): Promise<void> {
    // API key auth needs no login round-trip; password auth logs in once.
    if (this.apiKey || this.jwt || !this.auth) return;

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
        // Only set Content-Type when there is a body — Fastify rejects requests
        // that carry Content-Type: application/json with an empty body (400).
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers as Record<string, string>,
      };
      const authHeader = this.authHeader();
      if (authHeader) {
        headers['Authorization'] = authHeader;
      }

      return fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    };

    let response = await doRequest();

    // Retry once on 401 for password auth — the JWT may have expired. API keys
    // cannot be re-derived, so a 401 there is surfaced directly.
    if (response.status === 401 && this.auth && !this.apiKey) {
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

  /** Generic authenticated GET — used by tooling (doctor, codegen) for
   *  endpoints without a dedicated typed method. */
  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
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

  // Reads back the authoritative case entity and its version. The case entity is
  // a first-class, optionally schema-validated business-data record — the workflow
  // may legitimately read it to drive logic (e.g. in patched/parallel branches).
  getCaseEntity(processInstanceId: string): Promise<CaseEntityResult> {
    return this.request<CaseEntityResult>(
      `/cases/by-process-instance/${encodeURIComponent(processInstanceId)}/entity`,
    );
  }

  // Applies an RFC 6902 JSON Patch to the case entity. Operations are applied
  // server-side under a row lock, so concurrent branches writing disjoint fields
  // do not conflict. Pass `expectedVersion` for optimistic concurrency on a
  // same-field read-modify-write (409 on mismatch).
  patchCaseEntity(
    processInstanceId: string,
    patch: JsonPatchOperation[],
    expectedVersion?: number,
  ): Promise<CaseEntityResult> {
    return this.request<CaseEntityResult>(
      `/cases/by-process-instance/${encodeURIComponent(processInstanceId)}/entity`,
      { method: 'PATCH', body: JSON.stringify({ patch, expectedVersion }) },
    );
  }

  // Replaces the entire case entity. Use for initialization or migration; prefer
  // patchCaseEntity for incremental updates from concurrent branches.
  setCaseEntity(
    processInstanceId: string,
    entity: Record<string, unknown>,
    expectedVersion?: number,
  ): Promise<CaseEntityResult> {
    return this.request<CaseEntityResult>(
      `/cases/by-process-instance/${encodeURIComponent(processInstanceId)}/entity`,
      { method: 'PUT', body: JSON.stringify({ entity, expectedVersion }) },
    );
  }

  /** @deprecated Use setCaseEntity (full replace) or patchCaseEntity (JSON Patch). */
  setCaseVariables(
    processInstanceId: string,
    variables: Record<string, unknown>,
  ): Promise<CaseEntityResult> {
    return this.setCaseEntity(processInstanceId, variables);
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
      const authHeader = this.authHeader();
      if (authHeader) headers['Authorization'] = authHeader;

      return fetch(`${this.baseUrl}/tasks/${taskId}/attachments`, {
        method: 'POST',
        headers,
        body: formData,
      });
    };

    let response = await doRequest();
    if (response.status === 401 && this.auth && !this.apiKey) {
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
      const authHeader = this.authHeader();
      if (authHeader) headers['Authorization'] = authHeader;
      return fetch(`${this.baseUrl}/tasks/${taskId}/attachments/${attachmentId}/content`, { headers });
    };

    let response = await doRequest();
    if (response.status === 401 && this.auth && !this.apiKey) {
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
