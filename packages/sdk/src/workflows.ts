import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import type { CreateTaskAndWaitInput, TaskResult, TaskCompletedSignalPayload } from './types.js';
import { taskCompletedSignalName } from './types.js';

const { createFlowstileTask } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

/**
 * Workflow function: creates a Flowstile task and durably waits for a human to
 * complete it. The workflow resumes when the Flowstile server sends the
 * `flowstile:task:completed:<taskId>` signal upon task completion.
 *
 * Usage inside a Temporal workflow:
 *
 *   import { createTaskAndWait } from '@flowstile/sdk/workflows';
 *
 *   const result = await createTaskAndWait({
 *     taskDefinitionId: 'my-task-def-uuid',
 *     inputData: { customerId },
 *     priority: 'high',
 *   });
 *   const decision = result.data.APPROVAL_DECISION;
 */
export async function createTaskAndWait(
  input: CreateTaskAndWaitInput,
): Promise<TaskResult> {
  const { workflowId } = workflowInfo();

  const task = await createFlowstileTask({
    ...input,
    workflowId,
  });

  const signalName = taskCompletedSignalName(task.id);
  const completedSignal = defineSignal<[TaskCompletedSignalPayload]>(signalName);

  let payload: TaskCompletedSignalPayload | undefined;
  setHandler(completedSignal, (p) => {
    payload = p;
  });

  await condition(() => payload !== undefined);

  return { taskId: task.id, data: payload!.data };
}
