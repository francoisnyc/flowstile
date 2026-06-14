import { createTaskAndWait } from './workflows.js';
import type { CreateTaskAndWaitInput, TaskResult } from './types.js';
import type { VariableMapping } from './mapping.js';

type TaskDefaults = Partial<Omit<CreateTaskAndWaitInput, 'taskDefinitionCode' | 'taskDefinitionId'>>;

export interface TaskDescriptor<TOutput extends Record<string, unknown> = Record<string, unknown>> {
  readonly taskDefinitionCode: string;
  /**
   * The milestone (phase of the case plan) this task belongs to. Required —
   * every task is either placed on the map or explicitly opted out with null
   * (exception/escalation tasks that aren't on the happy path).
   * Display-only: never gates task creation or workflow progress.
   */
  readonly phase: string | null;
  readonly defaults: TaskDefaults;
  /** Input mapping: case variables projected into `contextData`. */
  readonly contextFrom?: VariableMapping;
  /** Output mapping: submission fields promoted to the case entity. */
  readonly persist?: VariableMapping;
  createAndWait(
    input?: Omit<CreateTaskAndWaitInput, 'taskDefinitionCode' | 'taskDefinitionId'>,
  ): Promise<TaskResult<TOutput>>;
}

export interface TaskOptions {
  /** Milestone code from the process plan, or null for unphased tasks. */
  phase: string | null;
  /** Defaults merged into every `createAndWait` call. */
  defaults?: TaskDefaults;
  /** Project named case-entity variables into this task's `contextData` for
   *  display (input mapping). Array maps each key to the same name; object
   *  renames (entity key → context key). Plumbing only — no calculation. */
  contextFrom?: VariableMapping;
  /** Promote an allowlist of submission fields to the case entity on
   *  completion (output mapping). Array keeps the name; object renames
   *  (submission key → entity key). Plumbing only. */
  persist?: VariableMapping;
}

/**
 * Bind a stable task definition code to a TypeScript output type, a phase in
 * the case plan, and optional defaults. The returned descriptor's
 * `createAndWait()` method is safe to call inside a Temporal workflow.
 *
 * Phase membership in the plan is validated at `defineProcess` time (throws at
 * module load, so a worker with a stale plan fails to boot). For compile-time
 * checking, use the task-factory form of `defineProcess` instead.
 *
 * Example:
 *   const approveOrder = defineTask<{ DECISION: 'APPROVED' | 'REJECTED' }>(
 *     'APPROVE_ORDER',
 *     { phase: 'Approval', defaults: { priority: 'high' } },
 *   );
 */
export function defineTask<TOutput extends Record<string, unknown> = Record<string, unknown>>(
  taskDefinitionCode: string,
  options: TaskOptions,
): TaskDescriptor<TOutput> {
  const resolvedDefaults = options.defaults ?? {};
  return {
    taskDefinitionCode,
    phase: options.phase,
    defaults: resolvedDefaults,
    contextFrom: options.contextFrom,
    persist: options.persist,
    createAndWait(input = {}) {
      return createTaskAndWait<TOutput>({
        // Descriptor-level mappings apply to every call; an explicit call-site
        // contextFrom/persist (rare) overrides via the spread of `input`.
        ...(options.contextFrom ? { contextFrom: options.contextFrom } : {}),
        ...(options.persist ? { persist: options.persist } : {}),
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
  /**
   * The case plan: ordered business phases, as users should understand them.
   * Rendered as a stepper on the case page. Omit for processes that don't
   * need orientation.
   */
  readonly plan: readonly string[];
  readonly tasks: TTasks;
}

/** `defineTask` scoped to a plan: `phase` only accepts members of the plan. */
export type PhasedTaskFactory<TPhase extends string> = <
  TOutput extends Record<string, unknown> = Record<string, unknown>,
>(
  taskDefinitionCode: string,
  options: {
    phase: TPhase | null;
    defaults?: TaskDefaults;
    contextFrom?: VariableMapping;
    persist?: VariableMapping;
  },
) => TaskDescriptor<TOutput>;

export interface ProcessConfig<TTasks extends TasksMap> {
  taskQueue: string;
  plan?: readonly string[];
  tasks: TTasks;
}

/**
 * Declare a process with its task queue, case plan, and typed task definitions.
 * Pass the returned object to `createFlowstileWorker` and import its `tasks`
 * from your workflow functions.
 *
 * Preferred form — the task factory scopes `phase` to the plan, so a typo'd or
 * removed phase is a compile error:
 *
 *   export const loanProcess = defineProcess('Loan Origination', {
 *     taskQueue: 'flowstile',
 *     plan: ['Application Review', 'Underwriting', 'Final Decision'],
 *   }, (task) => ({
 *     reviewApplication: task<ReviewOutput>('REVIEW_APPLICATION', { phase: 'Application Review' }),
 *     handleFraudFlag:   task<FraudOutput>('HANDLE_FRAUD_FLAG', { phase: null }),
 *   }));
 *
 * Object form (legacy / codegen) — phases are validated at module load instead:
 *
 *   export const orderProcess = defineProcess('Order Fulfillment', {
 *     taskQueue: 'flowstile',
 *     plan: ['Approval', 'Shipment'],
 *     tasks: {
 *       approveOrder: defineTask<ApprovalDecision>('APPROVE_ORDER', { phase: 'Approval' }),
 *     },
 *   });
 *
 * Both forms throw at module load if a task's phase is not in the plan — a
 * worker with a stale plan fails to boot rather than rendering a wrong map.
 */
export function defineProcess<const TPlan extends readonly string[], TTasks extends TasksMap>(
  name: string,
  config: { taskQueue: string; plan: TPlan },
  tasks: (task: PhasedTaskFactory<TPlan[number]>) => TTasks,
): ProcessDefinition<TTasks>;
export function defineProcess<TTasks extends TasksMap>(
  name: string,
  config: ProcessConfig<TTasks>,
): ProcessDefinition<TTasks>;
export function defineProcess(
  name: string,
  config: { taskQueue: string; plan?: readonly string[]; tasks?: TasksMap },
  taskFactory?: (task: PhasedTaskFactory<string>) => TasksMap,
): ProcessDefinition {
  const plan = config.plan ?? [];
  const tasks = taskFactory ? taskFactory(defineTask) : (config.tasks ?? {});

  for (const [key, descriptor] of Object.entries(tasks)) {
    if (descriptor.phase !== null && !plan.includes(descriptor.phase)) {
      throw new Error(
        `defineProcess('${name}'): task '${key}' (${descriptor.taskDefinitionCode}) ` +
          `declares phase '${descriptor.phase}', which is not in the plan ` +
          `[${plan.join(', ') || '(empty)'}]. Add it to the plan or set phase: null.`,
      );
    }
  }

  return { name, taskQueue: config.taskQueue, plan, tasks };
}
