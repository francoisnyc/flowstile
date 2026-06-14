// Automated reimbursement step — the REIMBURSEMENT phase of the expense plan.
// No human task is ever created for this phase: it's a Temporal activity that
// records (here, computes deterministically) a reimbursement reference so e2e
// assertions can rely on it. In a real system this would call out to a payments
// or ERP system; modelled as an activity because it's automated work, not a
// human decision.
export async function recordReimbursement(input: {
  processInstanceId: string;
  employeeName: string;
  amount: number;
}): Promise<{ reimbursementReference: string }> {
  // Deterministic reference derived from the process instance id so tests can
  // assert it without coupling to wall-clock time.
  const slug = input.processInstanceId.replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase();
  return { reimbursementReference: `RMB-${slug}` };
}
