// Automated credit assessment — the CREDIT_ASSESSMENT phase of the loan plan.
// No human task is ever created for this phase: the milestone stepper shows it
// jumping from pending to achieved when underwriting starts. Deterministic so
// e2e assertions can rely on the score.
export async function fetchCreditScore(input: {
  customerName: string;
  amount: number;
}): Promise<number> {
  const base = 820 - Math.floor(input.amount / 5000);
  return Math.max(540, Math.min(820, base));
}
