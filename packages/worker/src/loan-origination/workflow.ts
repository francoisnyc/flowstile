import { proxyActivities, log } from '@temporalio/workflow';
import { loanOriginationProcess } from './process.js';
import type * as loanActivities from './activities.js';

const { fetchCreditScore } = proxyActivities<typeof loanActivities>({
  startToCloseTimeout: '1 minute',
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
  | { status: 'approved'; creditScore: number; apr: number | null; terms: string | null }
  | { status: 'declined'; stage: 'underwriting' | 'senior-review' | 'final-decision'; reason: string }
  | { status: 'rejected'; reason: string };

const SENIOR_REVIEW_THRESHOLD = 50_000;

/**
 * Multi-stage loan approval. The case plan (APPLICATION_REVIEW →
 * CREDIT_ASSESSMENT → UNDERWRITING → FINAL_DECISION) is display metadata —
 * all sequencing lives here, in code: a rework loop from underwriting back to
 * application review, a fully automated credit phase, and a senior review
 * that only exists above the amount threshold.
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

    // Phase: CREDIT_ASSESSMENT — automated, no human task
    const creditScore = await fetchCreditScore({ customerName: CUSTOMER_NAME, amount: AMOUNT });
    log.info('Credit assessment complete', { pid, creditScore });

    // Phase: UNDERWRITING (underwriters)
    const risk = await loanAssessRisk.createAndWait({
      processInstanceId: pid,
      inputData: { CUSTOMER_NAME, AMOUNT, CREDIT_SCORE: creditScore },
    });
    if (risk.data.DECISION === 'SEND_BACK') {
      reworkReason = risk.data.RATIONALE;
      continue; // the stepper honestly regresses to APPLICATION_REVIEW
    }
    if (risk.data.DECISION === 'REJECT') {
      return { status: 'declined', stage: 'underwriting', reason: risk.data.RATIONALE };
    }

    // Still UNDERWRITING: senior review, only above the threshold
    if (AMOUNT > SENIOR_REVIEW_THRESHOLD) {
      const senior = await loanSeniorReview.createAndWait({
        processInstanceId: pid,
        inputData: { AMOUNT, CREDIT_SCORE: creditScore, RISK_RATIONALE: risk.data.RATIONALE },
      });
      if (senior.data.DECISION === 'REJECT') {
        return {
          status: 'declined',
          stage: 'senior-review',
          reason: senior.data.COMMENT ?? 'Rejected at senior review',
        };
      }
    }

    // Phase: FINAL_DECISION (loan-officers)
    const finalDecision = await loanFinalDecision.createAndWait({
      processInstanceId: pid,
      inputData: { CUSTOMER_NAME, AMOUNT, CREDIT_SCORE: creditScore },
    });
    if (finalDecision.data.DECISION === 'APPROVED') {
      return {
        status: 'approved',
        creditScore,
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
