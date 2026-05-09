import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import type {
  CreateTaskAndWaitInput,
  TaskResult,
  TaskCompletedSignalPayload,
} from './types.js';
import { taskCompletedSignalName, taskCancelledSignalName } from './types.js';
import { TaskTimeoutError, TaskCancelledError } from './errors.js';

const {
  createFlowstileTask,
  cancelFlowstileTask,
} = proxyActivities<typeof activities>({
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
 *   interface MyOutput { DECISION: 'approved' | 'rejected'; NOTES: string }
 *   const result = await createTaskAndWait<MyOutput>({
 *     taskDefinitionId: 'my-task-def-uuid',
 *     inputData: { customerId },
 *     priority: 'high',
 *     timeoutMs: 24 * 60 * 60 * 1000, // 24 hours
 *   });
 *   // result.data.DECISION is typed
 *   // result.completedBy.email, result.completedAt available
 */
export async function createTaskAndWait<
  TOutput extends Record<string, unknown> = Record<string, unknown>,
>(
  input: CreateTaskAndWaitInput,
): Promise<TaskResult<TOutput>> {
  const { workflowId } = workflowInfo();

  const task = await createFlowstileTask({
    ...input,
    workflowId,
  });

  const completedSignal = defineSignal<[TaskCompletedSignalPayload]>(
    taskCompletedSignalName(task.id),
  );
  const cancelledSignal = defineSignal(
    taskCancelledSignalName(task.id),
  );

  let completionPayload: TaskCompletedSignalPayload | undefined;
  let cancelled = false;

  setHandler(completedSignal, (p) => {
    completionPayload = p;
  });
  setHandler(cancelledSignal, () => {
    cancelled = true;
  });

  const resolved = await condition(
    () => completionPayload !== undefined || cancelled,
    input.timeoutMs,
  );

  if (!resolved) {
    // Timed out — try to cancel the task so it doesn't sit in the inbox
    try {
      await cancelFlowstileTask(task.id);
    } catch {
      // Best effort — task may already be claimed/completed
    }
    throw new TaskTimeoutError(task.id, input.timeoutMs!);
  }

  if (cancelled) {
    throw new TaskCancelledError(task.id);
  }

  return {
    taskId: task.id,
    data: completionPayload!.data as TOutput,
    completedBy: completionPayload!.completedBy,
    completedAt: completionPayload!.completedAt,
    formVersion: completionPayload!.formVersion,
  };
}
