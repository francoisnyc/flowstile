export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskStatus = 'created' | 'claimed' | 'completed' | 'cancelled';

export interface Task {
  id: string;
  taskDefinitionId: string;
  formDefinitionVersion: number;
  workflowId: string;
  processInstanceId: string | null;
  status: TaskStatus;
  assigneeId: string | null;
  priority: Priority;
  dueDate: string | null;
  followUpDate: string | null;
  inputData: Record<string, unknown>;
  contextData: Record<string, unknown>;
  submissionData: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CreateTaskInput {
  taskDefinitionId?: string;
  taskDefinitionCode?: string;
  workflowId: string;
  processInstanceId?: string;
  priority?: Priority;
  dueDate?: string;
  followUpDate?: string;
  inputData?: Record<string, unknown>;
  contextData?: Record<string, unknown>;
  submissionData?: Record<string, unknown>;
}

export interface CreateTaskAndWaitInput {
  taskDefinitionId?: string;
  taskDefinitionCode?: string;
  processInstanceId?: string;
  priority?: Priority;
  dueDate?: string;
  followUpDate?: string;
  inputData?: Record<string, unknown>;
  contextData?: Record<string, unknown>;
  /** Timeout in milliseconds. If the task is not completed within this time,
   *  a TaskTimeoutError is thrown and the task is cancelled (best-effort). */
  timeoutMs?: number;
}

export interface TaskResult<
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> {
  taskId: string;
  data: TOutput;
  completedBy: { id: string; email: string; displayName: string };
  completedAt: string;
  formVersion: number;
}

export interface FlowstileClientOptions {
  baseUrl: string;
  // Service-credential auth (recommended for workers/server-to-server). When set,
  // the client sends `Authorization: Bearer <apiKey>` directly and never logs in.
  apiKey?: string;
  // Human credential auth (logs in to obtain a JWT). Prefer `apiKey` for workers.
  auth?: { email: string; password: string };
}

export interface AttachmentReference {
  attachmentId: string;
  fileName: string;
  contentType: string;
  size: number;
  checksum: string;
  uploadedBy: string | null;
  uploadedAt: string;
}

export type CaseStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

// An RFC 6902 JSON Patch operation, used to mutate a case entity.
export type JsonPatchOperation =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown };

// The case entity plus its optimistic-concurrency version.
export interface CaseEntityResult {
  entity: Record<string, unknown> | null;
  entityVersion: number;
}

// A case is a projection over a workflow instance: every task and attachment
// sharing a processInstanceId, plus the authoritative case entity.
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

// A lean task view as it appears within a case overview (no form schema/data).
export interface CaseTask {
  id: string;
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
  };
  assignee: { id: string; email: string; displayName: string } | null;
}

// An attachment as it appears in a case overview: the standard reference plus
// the owning task and field, so consumers can build a download URL and group by field.
export interface CaseAttachment extends AttachmentReference {
  taskId: string;
  fieldKey: string;
}

export interface Case {
  id: string;
  processInstanceId: string;
  processDefinitionName: string | null;
  title: string | null;
  entity: Record<string, unknown> | null;
  entityVersion: number;
  status: CaseStatus;
  startedById: string | null;
  createdAt: string;
  tasks: CaseTask[];
  attachments: CaseAttachment[];
}

export interface ListCasesInput {
  status?: CaseStatus;
  limit?: number;
  offset?: number;
}

// Shape returned by all Flowstile list endpoints.
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface UploadAttachmentInput {
  fileName: string;
  contentType: string;
  content: Buffer | Blob | ReadableStream;
}

export type AttachmentFieldConfig = {
  multiple?: boolean;
  accept?: string[];
  maxSize?: number;
};

// Signal payload sent by the server when a task is completed
export interface TaskCompletedSignalPayload {
  data: Record<string, unknown>;
  completedBy: { id: string; email: string; displayName: string };
  completedAt: string; // ISO 8601
  formVersion: number;
}

// Signal name convention: flowstile:task:completed:<taskId>
export function taskCompletedSignalName(taskId: string): string {
  return `flowstile:task:completed:${taskId}`;
}

// Signal name convention: flowstile:task:cancelled:<taskId>
export function taskCancelledSignalName(taskId: string): string {
  return `flowstile:task:cancelled:${taskId}`;
}
