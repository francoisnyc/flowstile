/**
 * Loan Origination e2e — the acceptance rubric for the multi-stage approval
 * demo built with the flowstile-authoring skill.
 *
 * Plan: APPLICATION_REVIEW → CREDIT_ASSESSMENT (automated, zero human tasks)
 *       → UNDERWRITING (rework loop + senior review > 50k) → FINAL_DECISION
 *
 * Scenarios:
 *  1. Happy path ≤ 50k — every milestone achieved, no senior review, stepper UI
 *  2. Early rejection — unreached milestones render skipped, never pending
 *  3. Rework loop — underwriting sends back; the stepper honestly regresses
 *  4. Senior review > 50k — the conditional task exists only above threshold
 *
 * Tasks are driven through the REST API as the seeded candidate-group users
 * (bob = loan-officers, dave = underwriters); milestone assertions read
 * GET /cases/:id as alice (oversight).
 */
import { test, expect, chromium, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// The stepper UI assertion needs a real browser. Everything else in this spec
// drives the REST API directly, so in environments where browsers can't be
// provisioned the suite still validates the full behavioral contract.
const HAS_BROWSER = (() => {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();
const uiTest = HAS_BROWSER ? test : test.skip;

const SERVER = 'http://localhost:3000';
const BASE = 'http://localhost:5173';
const SERVICE_KEY = 'fsk_dev_local_worker_DO_NOT_USE_IN_PROD';

const ROOT = path.resolve(__dirname, '..');
const WORKER_DIR = path.resolve(ROOT, 'packages', 'worker');

function checkWorkflowStatus(wfId: string): string {
  const helperPath = path.resolve(__dirname, 'helpers', 'check-workflow.ts');
  const output = execSync(
    `pnpm exec tsx --tsconfig ${ROOT}/tsconfig.base.json ${helperPath} '${wfId}'`,
    { cwd: WORKER_DIR, stdio: ['pipe', 'pipe', 'inherit'], timeout: 15000 },
  ).toString().trim();
  return JSON.parse(output).status;
}

// The case reads "completed" the moment its last task completes; the workflow
// itself finishes a beat later, when the completion signal is delivered and
// the function returns. Poll rather than asserting a single snapshot.
async function expectWorkflowCompleted(wfId: string) {
  let status = '';
  for (let i = 0; i < 15; i++) {
    status = checkWorkflowStatus(wfId);
    if (status === 'COMPLETED') return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  expect(status, `workflow ${wfId} should complete`).toBe('COMPLETED');
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiLogin(email: string): Promise<string> {
  const res = await fetch(`${SERVER}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password' }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const match = (res.headers.get('set-cookie') ?? '').match(/flowstile_token=([^;]+)/);
  if (!match) throw new Error('No token');
  return match[1];
}

async function api(
  method: string,
  pathName: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  // Content-Type only with a body — Fastify 400s an empty JSON body.
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${SERVER}${pathName}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function startLoan(amount: number, label: string) {
  const { body: procs } = await api('GET', '/processes?limit=200', SERVICE_KEY);
  const proc = procs.items.find((p: { name: string }) => p.name === 'Loan Origination');
  expect(proc, 'Loan Origination process must be seeded').toBeTruthy();
  const { status, body } = await api('POST', `/processes/${proc.id}/start`, SERVICE_KEY, {
    data: { CUSTOMER_NAME: label, AMOUNT: amount, PURPOSE: 'e2e scenario' },
    idempotencyKey: `${label}-${Date.now()}`,
  });
  expect([200, 201]).toContain(status);
  return { pid: body.processInstanceId as string, caseId: body.caseId as string };
}

// Polls the caller's inbox for an open task of the given code in this case.
async function findTask(token: string, code: string, pid: string) {
  for (let i = 0; i < 30; i++) {
    const { body } = await api('GET', '/tasks?limit=100', token);
    const task = (body.items ?? []).find(
      (t: any) =>
        t.processInstanceId === pid &&
        t.taskDefinition?.code === code &&
        (t.status === 'created' || t.status === 'claimed'),
    );
    if (task) return task;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Task ${code} for ${pid} never appeared`);
}

async function claimAndComplete(token: string, taskId: string, data: Record<string, unknown>) {
  const claim = await api('POST', `/tasks/${taskId}/claim`, token);
  expect(claim.status, JSON.stringify(claim.body)).toBe(200);
  const complete = await api('POST', `/tasks/${taskId}/complete`, token, { data });
  expect(complete.status, JSON.stringify(complete.body)).toBe(200);
}

async function getMilestones(token: string, caseId: string) {
  const { status, body } = await api('GET', `/cases/${caseId}`, token);
  expect(status).toBe(200);
  const states: Record<string, string> = {};
  for (const m of body.milestones ?? []) states[m.code] = m.state;
  return { states, caseStatus: body.status as string, tasks: body.tasks as any[] };
}

// Retry wrapper: case state updates arrive via the Temporal signal round-trip,
// so poll until the expectation holds (or time out).
async function eventually<T>(fn: () => Promise<T>, check: (v: T) => boolean, label: string): Promise<T> {
  let last: T;
  for (let i = 0; i < 25; i++) {
    last = await fn();
    if (check(last)) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for: ${label} — last: ${JSON.stringify(last!)}`);
}

async function loginUi(page: Page, email: string) {
  await page.goto(BASE);
  const loginForm = page.locator('form.login-form');
  if (!(await loginForm.isVisible({ timeout: 2000 }).catch(() => false))) {
    await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }));
    await page.goto(BASE);
  }
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', 'password');
  await page.click('button[type="submit"]');
  await expect(page.locator('.inbox').first()).toBeVisible({ timeout: 10000 });
}

let bob: string;
let dave: string;
let alice: string;

test.beforeAll(async () => {
  bob = await apiLogin('bob@example.com');
  dave = await apiLogin('dave@example.com');
  alice = await apiLogin('alice@example.com');
});

// ── 1. Happy path (≤ 50k, no senior review) ──────────────────────────────────

test.describe.serial('Loan Origination — Happy Path', () => {
  test.setTimeout(120_000);
  let pid: string;
  let caseId: string;

  test('start: all milestones pending except active review', async () => {
    ({ pid, caseId } = await startLoan(20_000, 'E2E-Happy'));
    await findTask(bob, 'LOAN_REVIEW_APPLICATION', pid);
    const { states } = await getMilestones(alice, caseId);
    expect(states).toEqual({
      APPLICATION_REVIEW: 'active',
      CREDIT_ASSESSMENT: 'pending',
      UNDERWRITING: 'pending',
      FINAL_DECISION: 'pending',
    });
  });

  test('review proceeds; automated credit phase jumps to achieved', async () => {
    const review = await findTask(bob, 'LOAN_REVIEW_APPLICATION', pid);
    await claimAndComplete(bob, review.id, {
      CUSTOMER_NAME: 'E2E-Happy',
      AMOUNT: 20_000,
      DECISION: 'PROCEED',
    });

    const risk = await findTask(dave, 'LOAN_ASSESS_RISK', pid);
    // The automated phase's output feeds the underwriting task
    expect(risk.inputData.CREDIT_SCORE).toBeGreaterThan(500);

    const { states } = await getMilestones(alice, caseId);
    expect(states).toEqual({
      APPLICATION_REVIEW: 'achieved',
      CREDIT_ASSESSMENT: 'achieved', // zero human tasks — achieved by progression
      UNDERWRITING: 'active',
      FINAL_DECISION: 'pending',
    });
  });

  uiTest('the stepper renders the same states in the UI', async ({ page }) => {
    await loginUi(page, 'alice@example.com');
    await page.goto(`${BASE}/cases/${caseId}`);
    const stepper = page.getByTestId('milestone-stepper');
    await expect(stepper).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('milestone-APPLICATION_REVIEW')).toHaveAttribute('data-state', 'achieved');
    await expect(page.getByTestId('milestone-CREDIT_ASSESSMENT')).toHaveAttribute('data-state', 'achieved');
    await expect(page.getByTestId('milestone-UNDERWRITING')).toHaveAttribute('data-state', 'active');
    await expect(page.getByTestId('milestone-FINAL_DECISION')).toHaveAttribute('data-state', 'pending');
  });

  test('underwriting approves, final decision approves, workflow completes', async () => {
    const risk = await findTask(dave, 'LOAN_ASSESS_RISK', pid);
    await claimAndComplete(dave, risk.id, {
      CUSTOMER_NAME: 'E2E-Happy',
      AMOUNT: 20_000,
      CREDIT_SCORE: risk.inputData.CREDIT_SCORE,
      DECISION: 'APPROVE',
      RATIONALE: 'Healthy ratios',
    });

    const final = await findTask(bob, 'LOAN_FINAL_DECISION', pid);
    await claimAndComplete(bob, final.id, {
      CUSTOMER_NAME: 'E2E-Happy',
      AMOUNT: 20_000,
      DECISION: 'APPROVED',
      APR: 6.2,
      TERMS: '60 months',
    });

    const result = await eventually(
      () => getMilestones(alice, caseId),
      (v) => v.caseStatus === 'completed',
      'case completed',
    );
    expect(Object.values(result.states)).toEqual(['achieved', 'achieved', 'achieved', 'achieved']);
    // No senior review below the threshold
    expect(result.tasks.some((t) => t.taskDefinition?.code === 'LOAN_SENIOR_REVIEW')).toBe(false);
    await expectWorkflowCompleted(pid);

    // The workflow accumulated case variables: computed (creditScore), derived
    // (riskTier), and promoted task outcomes (underwritingDecision, decision).
    // expectWorkflowCompleted guarantees the final persist landed before return.
    const entityRes = await api('GET', `/cases/by-process-instance/${pid}/entity`, alice);
    expect(entityRes.status).toBe(200);
    const vars = entityRes.body.entity;
    expect(vars.creditScore).toBeGreaterThan(500);
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(vars.riskTier);
    expect(vars.underwritingDecision).toBe('APPROVE');
    expect(vars.decision).toBe('APPROVED');
    expect(vars.apr).toBe(6.2);
  });
});

// ── 2. Early rejection — skipped, not eternally pending ──────────────────────

test.describe.serial('Loan Origination — Early Rejection', () => {
  test.setTimeout(120_000);

  test('rejecting at review skips every later milestone', async () => {
    const { pid, caseId } = await startLoan(15_000, 'E2E-Reject');
    const review = await findTask(bob, 'LOAN_REVIEW_APPLICATION', pid);
    await claimAndComplete(bob, review.id, {
      CUSTOMER_NAME: 'E2E-Reject',
      AMOUNT: 15_000,
      DECISION: 'REJECT',
      NOTES: 'Incomplete documentation',
    });

    const result = await eventually(
      () => getMilestones(alice, caseId),
      (v) => v.caseStatus === 'completed',
      'case completed after rejection',
    );
    expect(result.states).toEqual({
      APPLICATION_REVIEW: 'achieved',
      CREDIT_ASSESSMENT: 'skipped',
      UNDERWRITING: 'skipped',
      FINAL_DECISION: 'skipped',
    });
    await expectWorkflowCompleted(pid);
  });
});

// ── 3. Rework loop — the stepper regresses honestly ──────────────────────────

test.describe.serial('Loan Origination — Rework Loop', () => {
  test.setTimeout(180_000);
  let pid: string;
  let caseId: string;

  test('underwriting sends back; a fresh review task carries the reason', async () => {
    ({ pid, caseId } = await startLoan(30_000, 'E2E-Rework'));
    const review1 = await findTask(bob, 'LOAN_REVIEW_APPLICATION', pid);
    await claimAndComplete(bob, review1.id, {
      CUSTOMER_NAME: 'E2E-Rework',
      AMOUNT: 30_000,
      DECISION: 'PROCEED',
    });

    const risk1 = await findTask(dave, 'LOAN_ASSESS_RISK', pid);
    await claimAndComplete(dave, risk1.id, {
      CUSTOMER_NAME: 'E2E-Rework',
      AMOUNT: 30_000,
      CREDIT_SCORE: risk1.inputData.CREDIT_SCORE,
      DECISION: 'SEND_BACK',
      RATIONALE: 'Income verification missing',
    });

    // A second review task appears, carrying the underwriter's reason
    const review2 = await findTask(bob, 'LOAN_REVIEW_APPLICATION', pid);
    expect(review2.id).not.toBe(review1.id);
    expect(review2.inputData.REWORK_REASON).toBe('Income verification missing');

    // The bar regresses: APPLICATION_REVIEW is active again
    const { states } = await getMilestones(alice, caseId);
    expect(states.APPLICATION_REVIEW).toBe('active');
    expect(states.UNDERWRITING).toBe('pending');
  });

  test('second pass completes the loan', async () => {
    const review2 = await findTask(bob, 'LOAN_REVIEW_APPLICATION', pid);
    await claimAndComplete(bob, review2.id, {
      CUSTOMER_NAME: 'E2E-Rework',
      AMOUNT: 30_000,
      DECISION: 'PROCEED',
      NOTES: 'Income docs attached now',
    });

    const risk2 = await findTask(dave, 'LOAN_ASSESS_RISK', pid);
    await claimAndComplete(dave, risk2.id, {
      CUSTOMER_NAME: 'E2E-Rework',
      AMOUNT: 30_000,
      CREDIT_SCORE: risk2.inputData.CREDIT_SCORE,
      DECISION: 'APPROVE',
      RATIONALE: 'Verified on second pass',
    });

    const final = await findTask(bob, 'LOAN_FINAL_DECISION', pid);
    await claimAndComplete(bob, final.id, {
      CUSTOMER_NAME: 'E2E-Rework',
      AMOUNT: 30_000,
      DECISION: 'APPROVED',
    });

    const result = await eventually(
      () => getMilestones(alice, caseId),
      (v) => v.caseStatus === 'completed',
      'rework case completed',
    );
    expect(Object.values(result.states)).toEqual(['achieved', 'achieved', 'achieved', 'achieved']);
    // The loop left two completed review-task instances under one milestone
    const reviewTasks = result.tasks.filter(
      (t) => t.taskDefinition?.code === 'LOAN_REVIEW_APPLICATION',
    );
    expect(reviewTasks.length).toBe(2);
    await expectWorkflowCompleted(pid);
  });
});

// ── 4. Senior review above the threshold ─────────────────────────────────────

test.describe.serial('Loan Origination — Senior Review (> 50k)', () => {
  test.setTimeout(180_000);

  test('large loans require senior endorsement inside UNDERWRITING', async () => {
    const { pid, caseId } = await startLoan(80_000, 'E2E-Senior');
    const review = await findTask(bob, 'LOAN_REVIEW_APPLICATION', pid);
    await claimAndComplete(bob, review.id, {
      CUSTOMER_NAME: 'E2E-Senior',
      AMOUNT: 80_000,
      DECISION: 'PROCEED',
    });

    const risk = await findTask(dave, 'LOAN_ASSESS_RISK', pid);
    await claimAndComplete(dave, risk.id, {
      CUSTOMER_NAME: 'E2E-Senior',
      AMOUNT: 80_000,
      CREDIT_SCORE: risk.inputData.CREDIT_SCORE,
      DECISION: 'APPROVE',
      RATIONALE: 'Strong collateral',
    });

    // The conditional task only exists above the threshold — same milestone
    const senior = await findTask(dave, 'LOAN_SENIOR_REVIEW', pid);
    expect(senior.inputData.RISK_RATIONALE).toBe('Strong collateral');
    const mid = await getMilestones(alice, caseId);
    expect(mid.states.UNDERWRITING).toBe('active'); // still in UNDERWRITING

    await claimAndComplete(dave, senior.id, {
      AMOUNT: 80_000,
      CREDIT_SCORE: senior.inputData.CREDIT_SCORE,
      DECISION: 'ENDORSE',
      COMMENT: 'Endorsed',
    });

    const final = await findTask(bob, 'LOAN_FINAL_DECISION', pid);
    await claimAndComplete(bob, final.id, {
      CUSTOMER_NAME: 'E2E-Senior',
      AMOUNT: 80_000,
      DECISION: 'APPROVED',
      APR: 7.1,
    });

    const result = await eventually(
      () => getMilestones(alice, caseId),
      (v) => v.caseStatus === 'completed',
      'senior case completed',
    );
    expect(Object.values(result.states)).toEqual(['achieved', 'achieved', 'achieved', 'achieved']);
    await expectWorkflowCompleted(pid);
  });
});
