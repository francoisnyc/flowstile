import { Task } from '../entities/task.entity.js';
import { TaskStatus } from './enums.js';

export type CaseStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export function deriveCaseStatus(tasks: Task[]): CaseStatus {
  if (tasks.length === 0) return 'pending';
  if (tasks.some((t) => t.status === TaskStatus.CREATED || t.status === TaskStatus.CLAIMED)) {
    return 'in_progress';
  }
  if (tasks.every((t) => t.status === TaskStatus.CANCELLED)) return 'cancelled';
  return 'completed';
}

// Snapshot top-level scalar values from a data object for use as initial case variables.
// Skips objects/arrays to avoid accidentally surfacing large blobs or attachment refs.
export function extractScalarVariables(
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data)) {
    if (val !== null && val !== undefined && typeof val !== 'object' && !Array.isArray(val)) {
      result[key] = val;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}
