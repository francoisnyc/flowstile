import type {
  FlowstileClientOptions,
  CreateTaskInput,
  Task,
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
      throw new Error(`Flowstile auth failed (${response.status}): ${body}`);
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...init?.headers as Record<string, string>,
    };
    if (this.jwt) {
      headers['Authorization'] = `Bearer ${this.jwt}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Flowstile API error ${response.status} on ${path}: ${body}`);
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
}
