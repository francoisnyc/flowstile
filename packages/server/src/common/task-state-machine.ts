import { TaskStatus } from './enums.js';

export type TaskAction = 'claim' | 'unclaim' | 'complete' | 'cancel';

const TRANSITIONS: Record<TaskStatus, Partial<Record<TaskAction, TaskStatus>>> = {
  [TaskStatus.CREATED]: {
    claim: TaskStatus.CLAIMED,
    cancel: TaskStatus.CANCELLED,
  },
  [TaskStatus.CLAIMED]: {
    unclaim: TaskStatus.CREATED,
    complete: TaskStatus.COMPLETED,
    cancel: TaskStatus.CANCELLED,
  },
  [TaskStatus.COMPLETED]: {},
  [TaskStatus.CANCELLED]: {},
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly currentStatus: TaskStatus,
    public readonly action: TaskAction,
  ) {
    super(
      `Invalid task transition: cannot '${action}' a task in '${currentStatus}' status`,
    );
    this.name = 'InvalidTransitionError';
  }
}

export class TaskStateMachine {
  static transition(currentStatus: TaskStatus, action: TaskAction): TaskStatus {
    const nextStatus = TRANSITIONS[currentStatus]?.[action];
    if (nextStatus === undefined) {
      throw new InvalidTransitionError(currentStatus, action);
    }
    return nextStatus;
  }

  static canTransition(currentStatus: TaskStatus, action: TaskAction): boolean {
    return TRANSITIONS[currentStatus]?.[action] !== undefined;
  }

  static availableActions(currentStatus: TaskStatus): TaskAction[] {
    return Object.keys(TRANSITIONS[currentStatus] ?? {}) as TaskAction[];
  }
}
