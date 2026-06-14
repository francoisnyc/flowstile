import { proxyActivities, log } from '@temporalio/workflow';
import { loanOriginationProcess } from './process.js';
import type * as loanActivities from './activities.js';
import type * as flowstileActivities from '@flowstile/sdk/activities';

const { fetchCreditScore } = proxyActivities<typeof loanActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

// Built-in Flowstile activities for the case entity (the durable cross-task
// "variables" store). Registered on every worker by createFlowstileWorker.
const { getFlowstileCaseEntity, patchFlowstileCaseEntity } =
  proxyActivities<typeof flowstileActivities>({
    startToCloseTimeout: '30 seconds',
    retry: { maximumAttempts: 3 },
  });

// Shape produced by POST /processes/:id/start (portal start): the validated
// start-form payload under `data`, plus server-injected metadata.
export interface LoanOriginationInput {
  processInstanceId: string;
  data: {
    CUSTOMER_NAME: string;
    AMOUNT: number;
    PURPOSE: string;
  };
  startedBy?: { id: string; email: string; displayName: string } | null;
}

export type LoanOriginationResult =
  | { status: 'approved'; creditScore: number; riskTier: RiskTier; apr: number | null; terms: string | null }
  | { status: 'declined'; stage: 'underwriting' | 'senior-review' | 'final-decision'; reason: string }
  | { status: 'rejected'; reason: string };

const SENIOR_REVIEW_THRESHOLD = 50_000;

type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

// A derived ("calculated") business value: computed in workflow code from the
// automated credit score and the loan amount, then persisted as a case
// variable. This is the deliberate pattern — calculation lives in the workflow
// (the source of truth), never in a form-side or server-side expression engine.
function deriveRiskTier(creditScore: number, amount: number): RiskTier {
  if (creditScore < 640 || amount > 75_000) return 'HIGH';
  if (creditScore < 720) return 'MEDIUM';
  return 'LOW';
}

/**
 * Multi-stage loan approval. The case plan (APPLICATION_REVIEW →
 * CREDIT_ASSESSMENT → UNDERWRITING → FINAL_DECISION) is display metadata —
 * all sequencing lives here, in code: a rework loop from underwriting back to
 * application review, a fully automated credit phase, and a senior review
 * that only exists above the amount threshold.
 *
 * This workflow also doubles as the reference for the variable lifecycle:
 *   - COMPUTE in workflow code (creditScore via an activity; riskTier derived),
 *   - PERSIST to the durable case entity via patchFlowstileCaseEntity (the
 *     cross-task "variables" store, readable by the case overview and any
 *     later step),
 *   - PROJECT into a task for display via contextData (a point-in-time copy).
 *
 * Concurrency note: every write here is a disjoint-field `add`, so no
 * expectedVersion is needed — the server applies them under a row lock and
 * distinct paths never collide. A *same-field* write from concurrent branches
 * (e.g. two parallel approvers incrementing one counter) is the case that needs
 * optimistic concurrency: read { entity, entityVersion }, recompute, write back
 * with expectedVersion, and on a 409 re-read and retry — that retry loop belongs
 * in workflow code, NOT in this activity's Temporal retry policy (blindly
 * retrying a 409 just re-sends the same stale version).
 */
export async function loanOriginationWorkflow(
  input: LoanOriginationInput,
): Promise<LoanOriginationResult> {
  const { loanReviewApplication, loanAssessRisk, loanSeniorReview, loanFinalDecision } =
    loanOriginationProcess.tasks;
  const { CUSTOMER_NAME, AMOUNT, PURPOSE } = input.data;
  const pid = input.processInstanceId;

  let reworkReason: string | null = null;

  // Rework loop: underwriting can send the application back to review.
  for (;;) {
    // Phase: APPLICATION_REVIEW (loan-officers)
    log.info('Awaiting application review', { pid, rework: reworkReason !== null });
    const review = await loanReviewApplication.createAndWait({
      processInstanceId: pid,
      inputData: {
        CUSTOMER_NAME,
        AMOUNT,
        PURPOSE,
        ...(reworkReason !== null ? { REWORK_REASON: reworkReason } : {}),
      },
      contextData: { APPLICATION_REFERENCE: pid },
    });
    if (review.data.DECISION === 'REJECT') {
      return { status: 'rejected', reason: review.data.NOTES ?? 'Rejected at application review' };
    }

    // Phase: CREDIT_ASSESSMENT — automated, no human task.
    // COMPUTE creditScore, derive riskTier, then PERSIST both as case variables
    // (disjoint-field adds; on a rework re-pass these replace prior values).
    const creditScore = await fetchCreditScore({ customerName: CUSTOMER_NAME, amount: AMOUNT });
    const riskTier = deriveRiskTier(creditScore, AMOUNT);
    log.info('Credit assessment complete', { pid, creditScore, riskTier });
    await patchFlowstileCaseEntity(pid, [
      { op: 'add', path: '/creditScore', value: creditScore },
      { op: 'add', path: '/riskTier', value: riskTier },
    ]);

    // Phase: UNDERWRITING (underwriters). PROJECT the derived riskTier into the
    // task for display alongside the working input.
    const risk = await loanAssessRisk.createAndWait({
      processInstanceId: pid,
      inputData: { CUSTOMER_NAME, AMOUNT, CREDIT_SCORE: creditScore },
      contextData: { RISK_TIER: riskTier },
    });
    if (risk.data.DECISION === 'SEND_BACK') {
      reworkReason = risk.data.RATIONALE;
      continue; // the stepper honestly regresses to APPLICATION_REVIEW
    }
    if (risk.data.DECISION === 'REJECT') {
      return { status: 'declined', stage: 'underwriting', reason: risk.data.RATIONALE };
    }
    // PERSIST the underwriting outcome (output promotion — an allowlist of
    // submission fields written back to the durable entity).
    await patchFlowstileCaseEntity(pid, [
      { op: 'add', path: '/underwritingDecision', value: risk.data.DECISION },
      { op: 'add', path: '/underwritingRationale', value: risk.data.RATIONALE },
    ]);

    // Still UNDERWRITING: senior review, only above the threshold.
    if (AMOUNT > SENIOR_REVIEW_THRESHOLD) {
      const senior = await loanSeniorReview.createAndWait({
        processInstanceId: pid,
        inputData: { AMOUNT, CREDIT_SCORE: creditScore, RISK_RATIONALE: risk.data.RATIONALE },
        contextData: { RISK_TIER: riskTier },
      });
      if (senior.data.DECISION === 'REJECT') {
        return {
          status: 'declined',
          stage: 'senior-review',
          reason: senior.data.COMMENT ?? 'Rejected at senior review',
        };
      }
    }

    // Phase: FINAL_DECISION (loan-officers). RETRIEVE the accumulated case
    // entity so the final reviewer sees the full picture assembled across the
    // case — the read matters most when earlier data came from another branch;
    // here it also confirms the variables persisted.
    const { entity } = await getFlowstileCaseEntity(pid);
    const finalDecision = await loanFinalDecision.createAndWait({
      processInstanceId: pid,
      inputData: { CUSTOMER_NAME, AMOUNT, CREDIT_SCORE: creditScore },
      contextData: { CREDIT_SCORE: creditScore, RISK_TIER: riskTier, CASE_VARIABLES: entity },
    });
    await patchFlowstileCaseEntity(pid, [
      { op: 'add', path: '/decision', value: finalDecision.data.DECISION },
      ...(finalDecision.data.APR !== undefined
        ? [{ op: 'add' as const, path: '/apr', value: finalDecision.data.APR }]
        : []),
    ]);

    if (finalDecision.data.DECISION === 'APPROVED') {
      return {
        status: 'approved',
        creditScore,
        riskTier,
        apr: finalDecision.data.APR ?? null,
        terms: finalDecision.data.TERMS ?? null,
      };
    }
    return {
      status: 'declined',
      stage: 'final-decision',
      reason: finalDecision.data.TERMS ?? 'Declined at final decision',
    };
  }
}
