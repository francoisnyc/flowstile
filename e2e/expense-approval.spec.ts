/**
 * Expense Approval e2e — the acceptance rubric for the reimbursement flow built
 * with the flowstile-authoring skill.
 *
 * Plan: MANAGER_REVIEW → FINANCE_REVIEW (only when AMOUNT > 1000) →
 *       REIMBURSEMENT (automated, zero human tasks — a Temporal activity records
 *       the reimbursement reference)
 *
 * Scenarios:
 *  1. Happy path > $1000 — manager approves, finance approves, reimbursement
 *     activity runs, workflow COMPLETED, case entity accumulates the persisted
 *     variables (managerDecision, financeDecision, reimbursementReference).
 *  2. Happy path ≤ $1000 — finance review is skipped entirely; no finance task
 *     ever exists; reimbursement still runs and the loan completes.
 *  3. Early rejection at manager review — process ends rejected, later
 *     milestones never go active.
 *  4. Finance decline (> $1000) — manager approves but finance rejects; process
 *     ends declined, no reimbursement reference is recorded.
 *
 * Tasks are driven through the REST API as the seeded candidate-group users
 * (erin = managers, frank = finance); milestone/entity assertions read
 * GET /cases/:id and the case entity as alice (oversight). The stepper UI
 * assertion needs a real browser and skips where none can be provisioned.
 */
import { test, expect, chromium, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

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
// itself finishes a beat later, when the completion signal is delivered and the
// function returns. Poll rather than asserting a single snapshot.
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

async function startExpense(amount: number, label: string) {
  const { body: procs } = await api('GET', '/processes?limit=200', SERVICE_KEY);
  const proc = procs.items.find((p: { name: string }) => p.name === 'Expense Approval');
  expect(proc, 'Expense Approval process must be seeded').toBeTruthy();
  const { status, body } = await api('POST', `/processes/${proc.id}/start`, SERVICE_KEY, {
    data: {
      EMPLOYEE_NAME: label,
      AMOUNT: amount,
      CATEGORY: 'TRAVEL',
      DESCRIPTION: 'e2e scenario',
    },
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

// Asserts a task of the given code never shows up for this case within a window.
async function expectNoTask(token: string, code: string, pid: string, windowMs = 8000) {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const { body } = await api('GET', '/tasks?limit=100', token);
    const task = (body.items ?? []).find(
      (t: any) => t.processInstanceId === pid && t.taskDefinition?.code === code,
    );
    expect(task, `${code} should never be created for ${pid}`).toBeFalsy();
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function claimAndComplete(token: string, taskId: string, data: Record<string, unknown>) {
  const claim = await api('POST', `/tasks/${taskId}/claim`, token);
  expect(claim.status, JSON.stringify(claim.body)).toBe(200);
  const complete = await api('POST', `/tasks/${taskId}/complete`, token, { data });
  expect(complete.status, JSON.stringify(complete.body)).toBe(200);
}

async function getCase(token: string, caseId: string) {
  const { status, body } = await api('GET', `/cases/${caseId}`, token);
  expect(status).toBe(200);
  const states: Record<string, string> = {};
  for (const m of body.milestones ?? []) states[m.code] = m.state;
  return { states, caseStatus: body.status as string, tasks: body.tasks as any[] };
}

async function getEntity(token: string, pid: string) {
  const { status, body } = await api('GET', `/cases/by-process-instance/${pid}/entity`, token);
  expect(status).toBe(200);
  return body.entity as Record<string, any>;
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

let erin: string;
let frank: string;
let alice: string;

test.beforeAll(async () => {
  erin = await apiLogin('erin@example.com');
  frank = await apiLogin('frank@example.com');
  alice = await apiLogin('alice@example.com');
});

// ── 1. Happy path > $1000 (manager + finance, then reimbursement) ─────────────

test.describe.serial('Expense Approval — Happy Path (> $1000)', () => {
  test.setTimeout(120_000);
  let pid: string;
  let caseId: string;

  test('start: manager review active, later milestones pending', async () => {
    ({ pid, caseId } = await startExpense(2_500, 'E2E-Expense-Big'));
    await findTask(erin, 'EXPENSE_MANAGER_REVIEW', pid);
    const { states } = await getCase(alice, caseId);
    expect(states).toEqual({
      MANAGER_REVIEW: 'active',
      FINANCE_REVIEW: 'pending',
      REIMBURSEMENT: 'pending',
    });
  });

  test('manager approves; finance review appears with the manager decision', async () => {
    const review = await findTask(erin, 'EXPENSE_MANAGER_REVIEW', pid);
    await claimAndComplete(erin, review.id, {
      EMPLOYEE_NAME: 'E2E-Expense-Big',
      AMOUNT: 2_500,
      CATEGORY: 'TRAVEL',
      DECISION: 'APPROVE',
      NOTES: 'Looks fine',
    });

    const finance = await findTask(frank, 'EXPENSE_FINANCE_REVIEW', pid);
    // The manager decision was projected into the finance task via contextFrom.
    expect(finance.contextData.managerDecision).toBe('APPROVE');

    const { states } = await getCase(alice, caseId);
    expect(states.MANAGER_REVIEW).toBe('achieved');
    expect(states.FINANCE_REVIEW).toBe('active');
  });

  uiTest('the stepper renders the same states in the UI', async ({ page }) => {
    await loginUi(page, 'alice@example.com');
    await page.goto(`${BASE}/cases/${caseId}`);
    const stepper = page.getByTestId('milestone-stepper');
    await expect(stepper).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('milestone-MANAGER_REVIEW')).toHaveAttribute('data-state', 'achieved');
    await expect(page.getByTestId('milestone-FINANCE_REVIEW')).toHaveAttribute('data-state', 'active');
  });

  test('finance approves; reimbursement runs; workflow completes with entity', async () => {
    const finance = await findTask(frank, 'EXPENSE_FINANCE_REVIEW', pid);
    await claimAndComplete(frank, finance.id, {
      EMPLOYEE_NAME: 'E2E-Expense-Big',
      AMOUNT: 2_500,
      CATEGORY: 'TRAVEL',
      DECISION: 'APPROVE',
      NOTES: 'Within budget',
    });

    const result = await eventually(
      () => getCase(alice, caseId),
      (v) => v.caseStatus === 'completed',
      'case completed',
    );
    // MANAGER_REVIEW and FINANCE_REVIEW achieved; REIMBURSEMENT is automated with
    // no human task, and is the terminal milestone, so the stepper reads it as
    // skipped once the case is terminal (no task ever materializes for it).
    expect(result.states.MANAGER_REVIEW).toBe('achieved');
    expect(result.states.FINANCE_REVIEW).toBe('achieved');
    await expectWorkflowCompleted(pid);

    // The workflow accumulated case variables: promoted task outcomes
    // (managerDecision, financeDecision) and a computed reimbursement reference.
    const vars = await getEntity(alice, pid);
    expect(vars.managerDecision).toBe('APPROVE');
    expect(vars.financeDecision).toBe('APPROVE');
    expect(vars.financeReviewed).toBe(true);
    expect(typeof vars.reimbursementReference).toBe('string');
    expect(vars.reimbursementReference).toMatch(/^RMB-/);
  });
});

// ── 2. Happy path ≤ $1000 (finance review skipped) ────────────────────────────

test.describe.serial('Expense Approval — Small Expense (≤ $1000, no finance)', () => {
  test.setTimeout(120_000);

  test('manager approval alone completes the expense; finance never appears', async () => {
    const { pid, caseId } = await startExpense(750, 'E2E-Expense-Small');
    const review = await findTask(erin, 'EXPENSE_MANAGER_REVIEW', pid);
    await claimAndComplete(erin, review.id, {
      EMPLOYEE_NAME: 'E2E-Expense-Small',
      AMOUNT: 750,
      CATEGORY: 'MEALS',
      DECISION: 'APPROVE',
    });

    // No finance task is ever created at or below the threshold.
    await expectNoTask(frank, 'EXPENSE_FINANCE_REVIEW', pid);

    const result = await eventually(
      () => getCase(alice, caseId),
      (v) => v.caseStatus === 'completed',
      'small expense completed',
    );
    expect(result.states.MANAGER_REVIEW).toBe('achieved');
    // Finance review was never reached — skipped, never pending forever.
    expect(result.states.FINANCE_REVIEW).toBe('skipped');
    await expectWorkflowCompleted(pid);

    const vars = await getEntity(alice, pid);
    expect(vars.managerDecision).toBe('APPROVE');
    expect(vars.financeReviewed).toBe(false);
    expect(vars.financeDecision).toBeUndefined();
    expect(vars.reimbursementReference).toMatch(/^RMB-/);
  });
});

// ── 3. Early rejection at manager review ──────────────────────────────────────

test.describe.serial('Expense Approval — Manager Rejection', () => {
  test.setTimeout(120_000);

  test('rejecting at manager review ends the process; later milestones skipped', async () => {
    const { pid, caseId } = await startExpense(3_000, 'E2E-Expense-Reject');
    const review = await findTask(erin, 'EXPENSE_MANAGER_REVIEW', pid);
    await claimAndComplete(erin, review.id, {
      EMPLOYEE_NAME: 'E2E-Expense-Reject',
      AMOUNT: 3_000,
      CATEGORY: 'EQUIPMENT',
      DECISION: 'REJECT',
      NOTES: 'Not pre-approved',
    });

    const result = await eventually(
      () => getCase(alice, caseId),
      (v) => v.caseStatus === 'completed',
      'rejected case completed',
    );
    expect(result.states).toEqual({
      MANAGER_REVIEW: 'achieved',
      FINANCE_REVIEW: 'skipped',
      REIMBURSEMENT: 'skipped',
    });
    await expectWorkflowCompleted(pid);

    const vars = await getEntity(alice, pid);
    expect(vars.managerDecision).toBe('REJECT');
    // No reimbursement on a rejected expense.
    expect(vars.reimbursementReference).toBeUndefined();
  });
});

// ── 4. Finance decline (> $1000) ──────────────────────────────────────────────

test.describe.serial('Expense Approval — Finance Decline (> $1000)', () => {
  test.setTimeout(120_000);

  test('manager approves but finance rejects; process ends declined', async () => {
    const { pid, caseId } = await startExpense(5_000, 'E2E-Expense-Decline');
    const review = await findTask(erin, 'EXPENSE_MANAGER_REVIEW', pid);
    await claimAndComplete(erin, review.id, {
      EMPLOYEE_NAME: 'E2E-Expense-Decline',
      AMOUNT: 5_000,
      CATEGORY: 'OTHER',
      DECISION: 'APPROVE',
    });

    const finance = await findTask(frank, 'EXPENSE_FINANCE_REVIEW', pid);
    await claimAndComplete(frank, finance.id, {
      EMPLOYEE_NAME: 'E2E-Expense-Decline',
      AMOUNT: 5_000,
      CATEGORY: 'OTHER',
      DECISION: 'REJECT',
      NOTES: 'Over budget for the quarter',
    });

    const result = await eventually(
      () => getCase(alice, caseId),
      (v) => v.caseStatus === 'completed',
      'declined case completed',
    );
    expect(result.states.MANAGER_REVIEW).toBe('achieved');
    expect(result.states.FINANCE_REVIEW).toBe('achieved');
    expect(result.states.REIMBURSEMENT).toBe('skipped');
    await expectWorkflowCompleted(pid);

    const vars = await getEntity(alice, pid);
    expect(vars.managerDecision).toBe('APPROVE');
    expect(vars.financeDecision).toBe('REJECT');
    // Declined: reimbursement never recorded.
    expect(vars.reimbursementReference).toBeUndefined();
  });
});
