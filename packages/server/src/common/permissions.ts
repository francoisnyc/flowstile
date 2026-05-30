export const Permissions = {
  TASKS_READ: 'tasks:read',
  TASKS_WRITE: 'tasks:write',
  TASKS_MANAGE: 'tasks:manage',
  FORMS_WRITE: 'forms:write',
  PROCESSES_WRITE: 'processes:write',
  PROCESSES_START: 'processes:start',
  USERS_MANAGE: 'users:manage',
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];
