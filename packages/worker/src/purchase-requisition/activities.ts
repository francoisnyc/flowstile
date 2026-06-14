// Temporal activities for the Purchase Requisition Approval process.
//
// `issuePurchaseOrder` is the PO_ISSUANCE service task. Generating a "unique"
// purchase-order number is a source of NON-DETERMINISM (it depends on the
// current time / a counter / randomness), and the temporal-developer skill's
// determinism guidance is explicit: place non-determinism inside an activity so
// its result is recorded in workflow history and replayed verbatim. Doing this
// in the workflow body (e.g. Date.now()/Math.random()) would risk a
// NondeterminismError on replay. The activity result is durable.

export interface IssuePurchaseOrderInput {
  processInstanceId: string;
  amount: number;
}

export interface IssuePurchaseOrderResult {
  purchaseOrderNumber: string;
}

export async function issuePurchaseOrder(
  input: IssuePurchaseOrderInput,
): Promise<IssuePurchaseOrderResult> {
  // Side-effecting, non-deterministic value generation lives here (not the
  // workflow). In a real system this would reserve a number from a PO ledger /
  // sequence; here we synthesize a unique-enough reference. Because this runs
  // in an activity, the produced value is persisted to history and reused on
  // replay — the workflow stays deterministic.
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1e6)
    .toString(36)
    .toUpperCase()
    .padStart(4, '0');
  const purchaseOrderNumber = `PO-${stamp}-${rand}`;
  return { purchaseOrderNumber };
}
