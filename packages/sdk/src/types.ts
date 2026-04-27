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
}

export interface TaskResult {
  taskId: string;
  data: Record<string, unknown>;
}

export interface FlowstileClientOptions {
  baseUrl: string;
}

// Signal payload sent by the server when a task is completed
export interface TaskCompletedSignalPayload {
  data: Record<string, unknown>;
}

// Signal name convention: flowstile:task:completed:<taskId>
export function taskCompletedSignalName(taskId: string): string {
  return `flowstile:task:completed:${taskId}`;
}
