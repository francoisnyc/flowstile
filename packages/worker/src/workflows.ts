// Re-export Flowstile SDK workflow functions. This file is the entry point
// Temporal bundles for the workflow sandbox — only @temporalio/workflow-safe
// imports are allowed here.
export { createTaskAndWait } from '@flowstile/sdk/workflows';

import { createTaskAndWait } from '@flowstile/sdk/workflows';

export interface LoanApprovalInput {
  processInstanceId: string;
  // Portal-start fields (from the LOAN_APPLICATION_START form)
  CUSTOMER_NAME: string;
  AMOUNT: number;
  // Optional metadata injected by the server on portal start
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
  const result = await createTaskAndWait<LoanDecision>({
    taskDefinitionCode: 'REVIEW_LOAN',
    processInstanceId: input.processInstanceId,
    priority: 'high',
    contextData: {
      CUSTOMER_NAME: input.CUSTOMER_NAME,
      APPLICATION_REFERENCE: input.processInstanceId,
    },
    inputData: {
      AMOUNT: input.AMOUNT,
    },
  });

  return {
    decision: result.data.DECISION,
    notes: result.data.NOTES ?? null,
    customerName: input.CUSTOMER_NAME,
    amount: input.AMOUNT,
    completedBy: result.completedBy.email,
    completedAt: result.completedAt,
  };
}

export { orderFulfillmentWorkflow } from './order-fulfillment/workflow.js';
