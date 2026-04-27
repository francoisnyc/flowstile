export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskStatus = 'created' | 'claimed' | 'completed' | 'cancelled';
export type FormStatus = 'draft' | 'published';

export interface UserRef {
  id: string;
  email: string;
  displayName: string;
}

export interface RoleRef {
  id: string;
  name: string;
  permissions: string[];
}

export interface GroupRef {
  id: string;
  name: string;
}

export interface User extends UserRef {
  status: string;
  roles: RoleRef[];
  groups: GroupRef[];
}

export interface TaskDefinitionRef {
  id: string;
  code: string;
  formDefinitionCode: string;
  candidateGroups: string[];
  candidateUsers: string[];
  defaultPriority: Priority;
}

export interface TaskForm {
  code: string;
  version: number;
  jsonSchema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  formMessages: Record<string, unknown>;
}

export interface Task {
  id: string;
  taskDefinitionId: string;
  taskDefinition?: TaskDefinitionRef;
  formDefinitionVersion: number;
  workflowId: string;
  processInstanceId: string | null;
  status: TaskStatus;
  assigneeId: string | null;
  assignee?: UserRef | null;
  priority: Priority;
  dueDate: string | null;
  followUpDate: string | null;
  inputData: Record<string, unknown>;
  contextData: Record<string, unknown>;
  submissionData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  form?: TaskForm;
}

export interface FormDefinition {
  id: string;
  code: string;
  version: number;
  status: FormStatus;
  jsonSchema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  visibilityRules: Record<string, unknown>;
  formMessages: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Group {
  id: string;
  name: string;
  members: UserRef[];
}

export interface FormSummary {
  code: string;
  latestPublishedVersion: number | null;
  hasDraft: boolean;
  latestPublished: FormDefinition | null;
}
