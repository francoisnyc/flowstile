import { proxyActivities, log } from '@temporalio/workflow';
import { expenseApprovalProcess } from './process.js';
import type * as expenseActivities from './activities.js';
import type * as flowstileActivities from '@flowstile/sdk/activities';

const { recordReimbursement } = proxyActivities<typeof expenseActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

// Built-in Flowstile case-entity activity, used here for the *computed* value
// (reimbursementReference) that isn't a submission field. Submission-field
// plumbing uses the declarative persist/contextFrom mappings on createAndWait.
const { patchFlowstileCaseEntity } = proxyActivities<typeof flowstileActivities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

// Shape produced by POST /processes/:id/start (portal start): the validated
// start-form payload under `data`, plus server-injected metadata.
export interface ExpenseApprovalInput {
  processInstanceId: string;
  data: {
    EMPLOYEE_NAME: string;
    AMOUNT: number;
    CATEGORY: 'TRAVEL' | 'MEALS' | 'EQUIPMENT' | 'OTHER';
    DESCRIPTION?: string;
  };
  startedBy?: { id: string; email: string; displayName: string } | null;
}

export type ExpenseApprovalResult =
  | { status: 'approved'; reimbursementReference: string; financeReviewed: boolean }
  | { status: 'rejected'; stage: 'manager'; reason: string }
  | { status: 'declined'; stage: 'finance'; reason: string };

// Expenses above this amount require a second pair of eyes from Finance.
const FINANCE_REVIEW_THRESHOLD = 1000;

/**
 * Expense Approval. The case plan (MANAGER_REVIEW → FINANCE_REVIEW →
 * REIMBURSEMENT) is display metadata — all sequencing lives here, in code:
 *   - Manager review (human) gates the whole process; a reject ends it.
 *   - Finance review (human) exists ONLY when AMOUNT exceeds the threshold;
 *     a reject ends the process as declined.
 *   - Reimbursement is fully automated (a Temporal activity) — no human task,
 *     so that milestone is achieved by progression, never claimed.
 *
 * Variable lifecycle, mirroring the loan reference:
 *   - PERSIST submission outcomes (the manager/finance DECISION) to the case
 *     entity declaratively via `persist` on createAndWait.
 *   - COMPUTE the reimbursement reference in an activity and PERSIST it
 *     explicitly with patchFlowstileCaseEntity (it's not a submission field).
 * All writes are disjoint-field adds, so no expectedVersion is needed.
 */
export async function expenseApprovalWorkflow(
  input: ExpenseApprovalInput,
): Promise<ExpenseApprovalResult> {
  const { expenseManagerReview, expenseFinanceReview } = expenseApprovalProcess.tasks;
  const { EMPLOYEE_NAME, AMOUNT, CATEGORY, DESCRIPTION } = input.data;
  const pid = input.processInstanceId;

  // Phase: MANAGER_REVIEW (managers).
  log.info('Awaiting manager review', { pid, amount: AMOUNT });
  const manager = await expenseManagerReview.createAndWait({
    processInstanceId: pid,
    inputData: { EMPLOYEE_NAME, AMOUNT, CATEGORY, ...(DESCRIPTION ? { DESCRIPTION } : {}) },
    contextData: { EXPENSE_REFERENCE: pid },
    // OUTPUT MAPPING: promote the manager decision to the case entity.
    persist: { DECISION: 'managerDecision' },
  });
  if (manager.data.DECISION === 'REJECT') {
    return {
      status: 'rejected',
      stage: 'manager',
      reason: manager.data.NOTES ?? 'Rejected at manager review',
    };
  }

  // Phase: FINANCE_REVIEW (finance) — only above the threshold.
  let financeReviewed = false;
  if (AMOUNT > FINANCE_REVIEW_THRESHOLD) {
    financeReviewed = true;
    log.info('Amount over threshold — awaiting finance review', { pid, amount: AMOUNT });
    const finance = await expenseFinanceReview.createAndWait({
      processInstanceId: pid,
      inputData: { EMPLOYEE_NAME, AMOUNT, CATEGORY },
      // INPUT MAPPING: project the manager decision into the finance task for display.
      contextFrom: ['managerDecision'],
      // OUTPUT MAPPING: promote the finance decision to the case entity.
      persist: { DECISION: 'financeDecision' },
    });
    if (finance.data.DECISION === 'REJECT') {
      return {
        status: 'declined',
        stage: 'finance',
        reason: finance.data.NOTES ?? 'Declined at finance review',
      };
    }
  }

  // Phase: REIMBURSEMENT — automated, no human task. COMPUTE the reference and
  // PERSIST it explicitly (it's a computed value, not a submission field).
  log.info('Recording reimbursement', { pid });
  const { reimbursementReference } = await recordReimbursement({
    processInstanceId: pid,
    employeeName: EMPLOYEE_NAME,
    amount: AMOUNT,
  });
  await patchFlowstileCaseEntity(pid, [
    { op: 'add', path: '/reimbursementReference', value: reimbursementReference },
    { op: 'add', path: '/financeReviewed', value: financeReviewed },
  ]);
  log.info('Expense approved', { pid, reimbursementReference });

  return { status: 'approved', reimbursementReference, financeReviewed };
}
