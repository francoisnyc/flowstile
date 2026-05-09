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
  taskDefinitionId: string;
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
  taskDefinitionId: string;
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
  auth?: { email: string; password: string };
}

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
