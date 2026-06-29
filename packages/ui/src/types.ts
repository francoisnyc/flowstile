export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskStatus = 'created' | 'claimed' | 'completed' | 'cancelled';
export type FormStatus = 'draft' | 'published';
export type ProcessStatus = 'active' | 'inactive';

export interface ProcessSummary {
  id: string;
  name: string;
  status: ProcessStatus;
  startFormCode: string | null;
  workflowType: string | null;
  taskQueue: string | null;
  createdAt: string;
}

export interface StartCaseResult {
  processInstanceId: string;
  caseId: string;
}

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

export type OutcomeStyle = 'primary' | 'secondary' | 'danger';

export interface FormOutcome {
  value: string;
  label: string;
  style?: OutcomeStyle;
  requireFields?: string[];
}

export interface TaskForm {
  // null for an ad-hoc task's inline form (no published form code/version).
  code: string | null;
  version: number | null;
  jsonSchema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  formMessages: Record<string, unknown>;
  outcomes?: FormOutcome[] | null;
  outcomeKey?: string | null;
}

export interface Task {
  id: string;
  // null for an ad-hoc task with no task definition.
  taskDefinitionId: string | null;
  name?: string | null;
  taskDefinition?: TaskDefinitionRef;
  formDefinitionVersion: number | null;
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
  outcomes: FormOutcome[] | null;
  outcomeKey: string | null;
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

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface AttachmentRef {
  attachmentId: string;
  fileName: string;
  contentType: string;
  size: number;
  checksum: string;
  uploadedBy: string | null;
  uploadedAt: string;
}

export interface AttachmentFieldConfig {
  multiple?: boolean;
  accept?: string[];
  maxSize?: number;
}

export type CaseStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface CaseSummary {
  id: string;
  processInstanceId: string;
  processDefinitionName: string | null;
  title: string | null;
  entity: Record<string, unknown> | null;
  entityVersion: number;
  status: CaseStatus;
  startedById: string | null;
  createdAt: string;
  taskCount: number;
  openTaskCount: number;
}

export interface CaseTask {
  id: string;
  name?: string | null;
  status: TaskStatus;
  priority: Priority;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  taskDefinition?: {
    id: string;
    code: string;
    formDefinitionCode: string;
    milestoneCode?: string | null;
  };
  assignee: UserRef | null;
}

export interface CaseAttachment extends AttachmentRef {
  taskId: string;
  fieldKey: string;
}

export type MilestoneState = 'pending' | 'active' | 'achieved' | 'skipped';

export type CaseEventActor = 'human' | 'system' | 'agent';

// A display-only entry on the case timeline (the case-event log). Records
// automated/agent work a human reviewing the case should see — never read back
// to drive workflow logic.
export interface CaseEvent {
  id: string;
  actor: CaseEventActor;
  label: string;
  payload: Record<string, unknown> | null;
  phase: string | null;
  recordedAt: string;
}

export interface CaseMilestone {
  code: string;
  name: string;
  state: MilestoneState;
}

export interface CaseDetail {
  id: string;
  processInstanceId: string;
  processDefinitionName: string | null;
  title: string | null;
  entity: Record<string, unknown> | null;
  entityVersion: number;
  status: CaseStatus;
  startedById: string | null;
  createdAt: string;
  // The case plan rendered as a stepper; null when the process declares no plan.
  milestones: CaseMilestone[] | null;
  tasks: CaseTask[];
  // The additive case-event log (agent/system/human events), display-only.
  events: CaseEvent[];
  attachments: CaseAttachment[];
  commentCount: number;
}

export interface CaseComment {
  id: string;
  caseId: string;
  author: { id: string; email: string; displayName: string };
  body: string;
  createdAt: string;
}
