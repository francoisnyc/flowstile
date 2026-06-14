// Re-export Flowstile SDK workflow functions. This file is the entry point
// Temporal bundles for the workflow sandbox — only @temporalio/workflow-safe
// imports are allowed here.
export { createTaskAndWait } from '@flowstile/sdk/workflows';

import { createTaskAndWait } from '@flowstile/sdk/workflows';

export interface LoanApprovalInput {
  processInstanceId: string;
  // Caller-supplied start-form payload (validated server-side against
  // LOAN_APPLICATION_START). Nested under `data` so it can never collide with
  // the server-injected fields below.
  data: {
    CUSTOMER_NAME: string;
    AMOUNT: number;
  };
  // Metadata injected by the server on portal start (unforgeable by the caller).
  startedBy?: { id: string; email: string; displayName: string } | null;
}

export interface LoanApprovalResult {
  decision: string;
  notes: string | null;
  customerName: string;
  amount: number;
  completedBy: string;
  completedAt: string;
}

interface LoanDecision extends Record<string, unknown> {
  DECISION: string;
  NOTES: string;
}

export async function loanApprovalWorkflow(
  input: LoanApprovalInput,
): Promise<LoanApprovalResult> {
  const { CUSTOMER_NAME, AMOUNT } = input.data;
  const result = await createTaskAndWait<LoanDecision>({
    taskDefinitionCode: 'REVIEW_LOAN',
    processInstanceId: input.processInstanceId,
    priority: 'high',
    contextData: {
      CUSTOMER_NAME,
      APPLICATION_REFERENCE: input.processInstanceId,
    },
    inputData: {
      AMOUNT,
    },
  });

  return {
    decision: result.data.DECISION,
    notes: result.data.NOTES ?? null,
    customerName: CUSTOMER_NAME,
    amount: AMOUNT,
    completedBy: result.completedBy.email,
    completedAt: result.completedAt,
  };
}

export { orderFulfillmentWorkflow } from './order-fulfillment/workflow.js';
export { loanOriginationWorkflow } from './loan-origination/workflow.js';
export { expenseApprovalWorkflow } from './expense-approval/workflow.js';
export { vacationLeaveWorkflow } from './vacation-leave/workflow.js';
export { purchaseRequisitionWorkflow } from './purchase-requisition/workflow.js';
