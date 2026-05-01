import type { Task, User, Group, RoleRef, FormSummary, FormDefinition, Page } from '../types.js';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...init?.headers as Record<string, string> };
  if (init?.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Auth
export const login = (email: string, password: string) =>
  request<User>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
export const logout = () => request<void>('/auth/logout', { method: 'POST' });
export const me = () => request<User>('/auth/me');

// Tasks
export const listTasks = (params?: Record<string, string>) => {
  const qs = new URLSearchParams(params).toString();
  return request<Page<Task>>(`/tasks${qs ? `?${qs}` : ''}`);
};
export const getTask = (id: string) => request<Task>(`/tasks/${id}`);
export const claimTask = (id: string) =>
  request<Task>(`/tasks/${id}/claim`, { method: 'POST' });
export const unclaimTask = (id: string) =>
  request<Task>(`/tasks/${id}/unclaim`, { method: 'POST' });
export const completeTask = (id: string, data: Record<string, unknown>) =>
  request<Task>(`/tasks/${id}/complete`, { method: 'POST', body: JSON.stringify({ data }) });

// Admin — Users
export const listUsers = () => request<Page<User>>('/users');
export const createUser = (body: {
  email: string;
  displayName: string;
  password: string;
  roleIds?: string[];
  groupIds?: string[];
}) => request<User>('/users', { method: 'POST', body: JSON.stringify(body) });
export const updateUser = (id: string, body: {
  displayName?: string;
  status?: string;
  roleIds?: string[];
  groupIds?: string[];
}) => request<User>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

// Admin — Groups
export const listGroups = () => request<Page<Group>>('/groups');
export const createGroup = (body: { name: string; memberIds?: string[] }) =>
  request<Group>('/groups', { method: 'POST', body: JSON.stringify(body) });
export const updateGroup = (id: string, body: { name?: string; memberIds?: string[] }) =>
  request<Group>(`/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

// Admin — Roles
export const listRoles = () => request<RoleRef[]>('/roles');

// Forms
export const listForms = () => request<Page<FormSummary>>('/forms');
export const getFormVersions = (code: string) =>
  request<FormDefinition[]>(`/forms/${code}/versions`);
export const createForm = (body: {
  code: string;
  jsonSchema: Record<string, unknown>;
  uiSchema?: Record<string, unknown>;
}) => request<FormDefinition>('/forms', { method: 'POST', body: JSON.stringify(body) });
export const updateDraft = (code: string, body: Partial<FormDefinition>) =>
  request<FormDefinition>(`/forms/${code}/draft`, { method: 'PUT', body: JSON.stringify(body) });
export const publishForm = (code: string) =>
  request<FormDefinition>(`/forms/${code}/publish`, { method: 'POST' });
