import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
  CancellationScope,
  isCancellation,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import type {
  CreateTaskAndWaitInput,
  TaskResult,
  TaskCompletedSignalPayload,
} from './types.js';
import { taskCompletedSignalName, taskCancelledSignalName } from './types.js';
import { TaskTimeoutError, TaskCancelledError, FlowstileApiError } from './errors.js';
import { projectContext, buildPersistPatch } from './mapping.js';

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
  const { createFlowstileTask, cancelFlowstileTask, getFlowstileCaseEntity, patchFlowstileCaseEntity } =
    proxyActivities<typeof activities>({
      startToCloseTimeout: '10 minutes',
      retry: { maximumAttempts: 3 },
    });

  const { workflowId } = workflowInfo();

  // contextFrom (input mapping): project named case variables into contextData
  // before creating the task. Explicit call-site contextData wins per key. Only
  // touches the entity when declared, so workflows that don't opt in are
  // unchanged. The first task of a case has no entity yet → 404 → project
  // nothing (other errors propagate to Temporal's activity retry).
  let contextData = input.contextData;
  if (input.contextFrom && input.processInstanceId) {
    let entity: Record<string, unknown> | null = null;
    try {
      ({ entity } = await getFlowstileCaseEntity(input.processInstanceId));
    } catch (err) {
      if (!(err instanceof FlowstileApiError && err.statusCode === 404)) throw err;
    }
    contextData = { ...projectContext(entity, input.contextFrom), ...(input.contextData ?? {}) };
  }

  const task = await createFlowstileTask({
    ...input,
    contextData,
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

  // condition() returns void (not boolean) when timeoutMs is undefined, which
  // is falsy. Always check the actual state variables — never !resolved — so
  // that a no-timeout wait doesn't misfire as a timeout the moment it resolves.
  try {
    await condition(
      () => completionPayload !== undefined || cancelled,
      input.timeoutMs,
    );
  } catch (err) {
    if (isCancellation(err)) {
      // Workflow itself was cancelled — clean up the task so it doesn't rot in the inbox
      await CancellationScope.nonCancellable(async () => {
        try {
          await cancelFlowstileTask(task.id);
        } catch {
          // Best effort — task may already be completed
        }
      });
    }
    throw err;
  }

  // Timed out: condition resolved but neither signal fired yet.
  if (completionPayload === undefined && !cancelled) {
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

  // persist (output mapping): promote the allowlisted submission fields to the
  // case entity after a successful completion (never on timeout/cancel). Only
  // touches the entity when declared.
  if (input.persist && input.processInstanceId) {
    const patch = buildPersistPatch(completionPayload!.data, input.persist);
    if (patch.length > 0) {
      await patchFlowstileCaseEntity(input.processInstanceId, patch);
    }
  }

  return {
    taskId: task.id,
    data: completionPayload!.data as TOutput,
    completedBy: completionPayload!.completedBy,
    completedAt: completionPayload!.completedAt,
    formVersion: completionPayload!.formVersion,
  };
}
