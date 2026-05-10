// Re-export Flowstile SDK workflow functions. This file is the entry point
// Temporal bundles for the workflow sandbox — only @temporalio/workflow-safe
// imports are allowed here.
export { createTaskAndWait } from '@flowstile/sdk/workflows';

import { createTaskAndWait } from '@flowstile/sdk/workflows';

export interface LoanApprovalInput {
  taskDefinitionId: string;
  customerName: string;
  amount: number;
  processInstanceId: string;
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
    taskDefinitionId: input.taskDefinitionId,
    processInstanceId: input.processInstanceId,
    priority: 'high',
    contextData: {
      CUSTOMER_NAME: input.customerName,
      APPLICATION_REFERENCE: input.processInstanceId,
    },
    inputData: {
      AMOUNT: input.amount,
    },
  });

  return {
    decision: result.data.DECISION,
    notes: result.data.NOTES ?? null,
    customerName: input.customerName,
    amount: input.amount,
    completedBy: result.completedBy.email,
    completedAt: result.completedAt,
  };
}

export { orderFulfillmentWorkflow } from './order-fulfillment/workflow.js';
