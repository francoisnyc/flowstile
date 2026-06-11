import type { CaseStatus } from './cases.js';

export type MilestoneState = 'pending' | 'active' | 'achieved' | 'skipped';

export interface Milestone {
  code: string;
  name: string;
}

export interface MilestoneView {
  code: string;
  name: string;
  state: MilestoneState;
}

// The slice of a task the derivation needs. Tasks whose definition has no
// milestoneCode (or one not in the plan) are unphased and never affect states.
export interface MilestoneTaskInput {
  status: 'created' | 'claimed' | 'completed' | 'cancelled';
  milestoneCode: string | null;
}

/**
 * Pure read-time projection of milestone states from the tasks that exist.
 * No stored milestone state anywhere — this can be re-derived (and re-tuned)
 * at any time without touching data.
 *
 * Rules (the behavioral spec lives in test/unit/milestones.spec.ts):
 * - A phase with an open (created/claimed) task is `active`. When open tasks
 *   span multiple phases, the earliest in plan order is current — so the bar
 *   regresses honestly during rework and never flickers as parallel work
 *   completes out of order.
 * - Phases before the current render `achieved`, later ones `pending` —
 *   a zero-task automated phase jumps pending → achieved when a later phase
 *   starts.
 * - With no open phased tasks on a live case, the high-water mark (latest
 *   phase with a completed task) and everything before it render `achieved`.
 * - On a closed case (completed/cancelled), phases past the high-water mark
 *   render `skipped` — a closed case never shows an eternally pending phase.
 */
export function deriveMilestoneStates(
  milestones: Milestone[],
  tasks: MilestoneTaskInput[],
  caseStatus: CaseStatus,
): MilestoneView[] {
  const indexByCode = new Map(milestones.map((m, i) => [m.code, i]));

  const openPhases = new Set<number>();
  let highWater = -1;
  for (const task of tasks) {
    if (!task.milestoneCode) continue;
    const idx = indexByCode.get(task.milestoneCode);
    if (idx === undefined) continue; // stale code after a plan edit — unphased
    if (task.status === 'created' || task.status === 'claimed') openPhases.add(idx);
    if (task.status === 'completed' && idx > highWater) highWater = idx;
  }

  const closed = caseStatus === 'completed' || caseStatus === 'cancelled';

  return milestones.map((m, i) => ({
    code: m.code,
    name: m.name,
    state: stateFor(i, openPhases, highWater, closed),
  }));
}

function stateFor(
  index: number,
  openPhases: Set<number>,
  highWater: number,
  closed: boolean,
): MilestoneState {
  if (closed) {
    // Open tasks on a closed case can't exist (case status derives from task
    // statuses), so only the high-water mark matters.
    return index <= highWater ? 'achieved' : 'skipped';
  }

  if (openPhases.size > 0) {
    const current = Math.min(...openPhases);
    if (openPhases.has(index)) return 'active';
    if (index < current) return 'achieved';
    return 'pending';
  }

  // Live case, no open phased work (e.g. an automated phase is running, or
  // only unphased tasks are open): show progress up to the high-water mark.
  return index <= highWater ? 'achieved' : 'pending';
}
