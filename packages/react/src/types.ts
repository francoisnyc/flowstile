export interface FlowstileApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export interface TaskActions {
  canClaim: boolean;
  canUnclaim: boolean;
  canComplete: boolean;
  canCancel: boolean;
}

export interface TaskAssignee {
  id: string;
  email: string;
  displayName: string;
}

export type OutcomeStyle = 'primary' | 'secondary' | 'danger';

export interface FormOutcome {
  value: string;
  label: string;
  style?: OutcomeStyle;
  requireFields?: string[];
}

export interface TaskForm {
  code: string;
  version: number;
  jsonSchema: Record<string, unknown>;
  uiSchema: Record<string, unknown>;
  formMessages?: Record<string, unknown>;
  outcomes?: FormOutcome[] | null;
  outcomeKey?: string | null;
}

export interface Task {
  id: string;
  status: string;
  priority: string;
  assigneeId: string | null;
  assignee: TaskAssignee | null;
  inputData: Record<string, unknown>;
  contextData: Record<string, unknown>;
  submissionData: Record<string, unknown>;
  form: TaskForm;
  actions: TaskActions;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  dueDate: string | null;
  workflowId: string;
}

export type TaskStatus = 'loading' | 'error' | 'ready';

export interface UseFlowstileTaskOptions {
  baseUrl?: string;
  token?: string;
  getToken?: () => Promise<string>;
}

export interface UseFlowstileTaskResult {
  task: Task | null;
  form: TaskForm | null;
  data: Record<string, unknown>;
  status: TaskStatus;
  error: FlowstileApiError | null;
  validationErrors: Record<string, string[]> | null;
  isMutating: boolean;
  claim: () => Promise<void>;
  unclaim: () => Promise<void>;
  complete: (submissionData: Record<string, unknown>) => Promise<void>;
  cancel: () => Promise<void>;
  refetch: () => Promise<void>;
}
