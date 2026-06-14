import { proxyActivities } from '@temporalio/workflow';
import { purchaseRequisitionApprovalProcess } from './process.js';
import type * as flowstileActivities from '@flowstile/sdk/activities';
import type * as prActivities from './activities.js';

// Built-in Flowstile activities (registered by createFlowstileWorker). We use
// patchFlowstileCaseEntity to record the issued PO number on the case entity.
const { patchFlowstileCaseEntity } = proxyActivities<typeof flowstileActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5 },
});

// Custom activity: PO_ISSUANCE. The unique purchase-order number is generated
// here (an activity), NOT in the workflow body — generating a unique id is
// non-deterministic, and per the temporal-developer determinism guidance,
// non-determinism must live in an activity so its result is recorded in history
// and replayed verbatim. The workflow body stays pure/deterministic.
const { issuePurchaseOrder } = proxyActivities<typeof prActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 5 },
});

const { prManagerApproval, prFinanceApproval } = purchaseRequisitionApprovalProcess.tasks;

const FINANCE_THRESHOLD = 5000;

export interface PurchaseRequisitionInput {
  processInstanceId: string;
  // Start-form payload (validated server-side against PURCHASE_REQUISITION_START).
  data: {
    REQUESTER_NAME: string;
    ITEM: string;
    AMOUNT: number;
    JUSTIFICATION: string;
  };
  startedBy?: { id: string; email: string; displayName: string } | null;
}

export type PurchaseRequisitionOutcome = 'APPROVED' | 'REJECTED' | 'DECLINED';

export interface PurchaseRequisitionResult {
  outcome: PurchaseRequisitionOutcome;
  managerDecision: string | null;
  financeDecision: string | null;
  purchaseOrderNumber: string | null;
}

export async function purchaseRequisitionWorkflow(
  input: PurchaseRequisitionInput,
): Promise<PurchaseRequisitionResult> {
  const { processInstanceId } = input;
  const { REQUESTER_NAME, ITEM, AMOUNT, JUSTIFICATION } = input.data;

  const sharedContext = { REQUESTER_NAME, ITEM, AMOUNT, JUSTIFICATION };

  // ── MANAGER_APPROVAL ──────────────────────────────────────────────────────
  const manager = await prManagerApproval.createAndWait({
    processInstanceId,
    contextData: sharedContext,
    // Promote the manager's decision to the case entity (output mapping).
    persist: { DECISION: 'MANAGER_DECISION' },
  });
  const managerDecision = manager.data.DECISION;

  if (managerDecision === 'REJECTED') {
    return {
      outcome: 'REJECTED',
      managerDecision,
      financeDecision: null,
      purchaseOrderNumber: null,
    };
  }

  // ── FINANCE_APPROVAL (only above the threshold) ───────────────────────────
  let financeDecision: string | null = null;
  if (AMOUNT > FINANCE_THRESHOLD) {
    const finance = await prFinanceApproval.createAndWait({
      processInstanceId,
      contextData: { ...sharedContext, MANAGER_DECISION: managerDecision },
      persist: { DECISION: 'FINANCE_DECISION' },
    });
    financeDecision = finance.data.DECISION;

    if (financeDecision === 'REJECTED') {
      return {
        outcome: 'DECLINED',
        managerDecision,
        financeDecision,
        purchaseOrderNumber: null,
      };
    }
  }

  // ── PO_ISSUANCE (trailing automated phase, no human task) ─────────────────
  // Issue the unique PO number in an activity, then record it on the case.
  const { purchaseOrderNumber } = await issuePurchaseOrder({ processInstanceId, amount: AMOUNT });
  await patchFlowstileCaseEntity(processInstanceId, [
    { op: 'add', path: '/PURCHASE_ORDER_NUMBER', value: purchaseOrderNumber },
  ]);

  return {
    outcome: 'APPROVED',
    managerDecision,
    financeDecision,
    purchaseOrderNumber,
  };
}
