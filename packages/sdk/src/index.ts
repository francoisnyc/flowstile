export { FlowstileClient } from './client.js';
export { defineTask, defineProcess } from './process.js';
export type { TaskDescriptor, TasksMap, ProcessDefinition, TaskOptions, PhasedTaskFactory } from './process.js';
export { runDoctor, formatDoctorReport } from './doctor.js';
export type { DoctorReport, DoctorFinding, DoctorSeverity } from './doctor.js';
export type {
  FlowstileClientOptions,
  CreateTaskInput,
  CreateTaskAndWaitInput,
  Task,
  TaskResult,
  TaskCompletedSignalPayload,
  Priority,
  TaskStatus,
  Case,
  CaseSummary,
  CaseTask,
  CaseAttachment,
  CaseStatus,
  CaseEntityResult,
  JsonPatchOperation,
  ListCasesInput,
  Paginated,
  AttachmentReference,
} from './types.js';
export { taskCompletedSignalName, taskCancelledSignalName } from './types.js';
export { TaskTimeoutError, TaskCancelledError, FlowstileApiError } from './errors.js';
