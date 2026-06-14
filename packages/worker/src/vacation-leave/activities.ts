// Activities for the Vacation Leave Request process.
//
// Re-export the built-in Flowstile case-entity activity so the workflow can
// proxy it (to persist the automated ledger reference) off a single
// `typeof activities` import.
export { patchFlowstileCaseEntity } from '@flowstile/sdk/activities';

//
// `recordLeaveLedger` is the trailing automated step: it records an approved
// leave request into the (simulated) HR ledger and returns a deterministic
// leave reference. Deterministic so tests can assert the exact value — the
// reference is derived purely from the process instance id, never from a clock
// or random source.

export interface LeaveLedgerInput {
  processInstanceId: string;
  employeeName: string;
  days: number;
  startDate: string;
  endDate: string;
}

export interface LeaveLedgerResult {
  leaveReference: string;
}

/** Derive a stable LEAVE-… reference from the process instance id. */
export function leaveReferenceFor(processInstanceId: string): string {
  // Take the last segment of the instance id (hyphen-delimited) and uppercase
  // it so the reference is human-legible and fully deterministic.
  const tail = processInstanceId.split('-').pop() ?? processInstanceId;
  return `LEAVE-${tail.toUpperCase()}`;
}

export async function recordLeaveLedger(input: LeaveLedgerInput): Promise<LeaveLedgerResult> {
  const leaveReference = leaveReferenceFor(input.processInstanceId);
  // In a real system this would write to an HR/payroll ledger. Here we just log.
  console.log(
    `[ledger] Recording leave ${leaveReference} for ${input.employeeName}: ` +
      `${input.days} day(s) ${input.startDate} → ${input.endDate}`,
  );
  return { leaveReference };
}
