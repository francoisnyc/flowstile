import { proxyActivities } from '@temporalio/workflow';
import { vacationLeaveRequestProcess } from './process.js';
import type * as activities from './activities.js';

const { vacationManagerReview, vacationHrReview } = vacationLeaveRequestProcess.tasks;

const { recordLeaveLedger } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

export interface VacationLeaveInput {
  processInstanceId: string;
  // Caller-supplied start-form payload (validated server-side against
  // VACATION_LEAVE_START). Nested under `data` so it can never collide with the
  // server-injected fields below. Typed as we actually read them.
  data: {
    EMPLOYEE_NAME: string;
    START_DATE: string;
    END_DATE: string;
    DAYS: number;
    REASON: string;
  };
  // Metadata injected by the server on portal start (unforgeable by the caller).
  startedBy?: { id: string; email: string; displayName: string } | null;
}

export type VacationOutcome = 'APPROVED' | 'REJECTED' | 'DECLINED';

export interface VacationLeaveResult {
  outcome: VacationOutcome;
  employeeName: string;
  days: number;
  managerDecision: string;
  managerBy: string;
  hrDecision: string | null;
  hrBy: string | null;
  leaveReference: string | null;
}

/**
 * Vacation Leave Request.
 *
 *   MANAGER_REVIEW → HR_REVIEW (only when DAYS > 10) → LEDGER_UPDATE
 *
 * Manager reject ends the case `REJECTED`. HR reject ends it `DECLINED`. A full
 * approval runs the trailing automated ledger activity and ends `APPROVED`.
 * Decisions and the ledger reference are persisted to the case entity.
 */
export async function vacationLeaveWorkflow(
  input: VacationLeaveInput,
): Promise<VacationLeaveResult> {
  const { processInstanceId } = input;
  const { EMPLOYEE_NAME, START_DATE, END_DATE, DAYS, REASON } = input.data;

  // 1 — Manager review (human task). persist the manager decision onto the case.
  const manager = await vacationManagerReview.createAndWait({
    processInstanceId,
    inputData: { EMPLOYEE_NAME, START_DATE, END_DATE, DAYS, REASON },
    persist: { DECISION: 'managerDecision' },
  });

  if (manager.data.DECISION === 'REJECT') {
    return {
      outcome: 'REJECTED',
      employeeName: EMPLOYEE_NAME,
      days: DAYS,
      managerDecision: manager.data.DECISION,
      managerBy: manager.completedBy.email,
      hrDecision: null,
      hrBy: null,
      leaveReference: null,
    };
  }

  // 2 — HR review (human task) — only for longer requests.
  let hrDecision: string | null = null;
  let hrBy: string | null = null;
  if (DAYS > 10) {
    const hr = await vacationHrReview.createAndWait({
      processInstanceId,
      inputData: {
        EMPLOYEE_NAME,
        DAYS,
        REASON,
        MANAGER_DECISION: manager.data.DECISION,
      },
      persist: { DECISION: 'hrDecision' },
    });
    hrDecision = hr.data.DECISION;
    hrBy = hr.completedBy.email;

    if (hr.data.DECISION === 'REJECT') {
      return {
        outcome: 'DECLINED',
        employeeName: EMPLOYEE_NAME,
        days: DAYS,
        managerDecision: manager.data.DECISION,
        managerBy: manager.completedBy.email,
        hrDecision,
        hrBy,
        leaveReference: null,
      };
    }
  }

  // 3 — Ledger update (trailing automated phase). Record the leave and persist
  // the deterministic reference onto the case entity.
  const { leaveReference } = await recordLeaveLedger({
    processInstanceId,
    employeeName: EMPLOYEE_NAME,
    days: DAYS,
    startDate: START_DATE,
    endDate: END_DATE,
  });
  await patchLeaveReference(processInstanceId, leaveReference);

  // 4 — Approved.
  return {
    outcome: 'APPROVED',
    employeeName: EMPLOYEE_NAME,
    days: DAYS,
    managerDecision: manager.data.DECISION,
    managerBy: manager.completedBy.email,
    hrDecision,
    hrBy,
    leaveReference,
  };
}

// Persist the ledger reference to the case entity via the built-in case-entity
// activity (the persist mapping only fires on human-task completion, so the
// automated ledger result is written here directly).
const { patchFlowstileCaseEntity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

async function patchLeaveReference(
  processInstanceId: string,
  leaveReference: string,
): Promise<void> {
  await patchFlowstileCaseEntity(processInstanceId, [
    { op: 'add', path: '/leaveReference', value: leaveReference },
  ]);
}
