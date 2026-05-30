import { createTaskAndWait } from './workflows.js';
import type { CreateTaskAndWaitInput, TaskResult } from './types.js';

export interface TaskDescriptor<TOutput extends Record<string, unknown> = Record<string, unknown>> {
  readonly taskDefinitionCode: string;
  readonly defaults: Partial<Omit<CreateTaskAndWaitInput, 'taskDefinitionCode' | 'taskDefinitionId'>>;
  createAndWait(
    input?: Omit<CreateTaskAndWaitInput, 'taskDefinitionCode' | 'taskDefinitionId'>,
  ): Promise<TaskResult<TOutput>>;
}

/**
 * Bind a stable task definition code to a TypeScript output type and optional defaults.
 * The returned descriptor's `createAndWait()` method is safe to call inside a Temporal workflow.
 *
 * Example:
 *   const approveOrder = defineTask<{ DECISION: 'APPROVED' | 'REJECTED' }>('APPROVE_ORDER', { priority: 'high' });
 *   const result = await approveOrder.createAndWait({ inputData: { ... } });
 *   // result.data.DECISION is typed
 */
export function defineTask<TOutput extends Record<string, unknown> = Record<string, unknown>>(
  taskDefinitionCode: string,
  defaults?: Partial<Omit<CreateTaskAndWaitInput, 'taskDefinitionCode' | 'taskDefinitionId'>>,
): TaskDescriptor<TOutput> {
  const resolvedDefaults = defaults ?? {};
  return {
    taskDefinitionCode,
    defaults: resolvedDefaults,
    createAndWait(input = {}) {
      return createTaskAndWait<TOutput>({
        ...resolvedDefaults,
        ...input,
        taskDefinitionCode,
      });
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TasksMap = Record<string, TaskDescriptor<any>>;

export interface ProcessDefinition<TTasks extends TasksMap = TasksMap> {
  readonly name: string;
  readonly taskQueue: string;
  readonly tasks: TTasks;
}

/**
 * Declare a process with its task queue and typed task definitions.
 * Pass the returned object to `createFlowstileWorker` and import its `tasks`
 * from your workflow functions.
 *
 * Example:
 *   export const orderProcess = defineProcess('order-fulfillment', {
 *     taskQueue: 'flowstile',
 *     tasks: {
 *       approveOrder: defineTask<ApprovalDecision>('APPROVE_ORDER', { priority: 'high' }),
 *       confirmShipment: defineTask<ShipmentDecision>('CONFIRM_SHIPMENT'),
 *     },
 *   });
 */
export function defineProcess<TTasks extends TasksMap>(
  name: string,
  config: { taskQueue: string; tasks: TTasks },
): ProcessDefinition<TTasks> {
  return { name, taskQueue: config.taskQueue, tasks: config.tasks };
}
