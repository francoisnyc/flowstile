import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

const BASE = 'http://localhost:5173';
const SERVER = 'http://localhost:3000';

const ROOT = path.resolve(__dirname, '..');
// Run helpers from the worker package so @temporalio/client resolves correctly
// (it's a dep of packages/worker, not hoisted to the monorepo root).
const WORKER_DIR = path.resolve(ROOT, 'packages', 'worker');

function runHelper(script: string, arg: string): string {
  return execSync(`pnpm exec tsx --tsconfig ${ROOT}/tsconfig.base.json ${script} '${arg}'`, {
    cwd: WORKER_DIR,
    stdio: ['pipe', 'pipe', 'inherit'], // inherit stderr so failures are visible
    timeout: 15000,
  }).toString().trim();
}

async function loginAs(page: Page, email: string) {
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

async function apiLogin(email: string): Promise<string> {
  const res = await fetch(`${SERVER}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password' }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie') ?? '';
  const match = cookie.match(/flowstile_token=([^;]+)/);
  if (!match) throw new Error('No token');
  return match[1];
}

interface TaskDefIds {
  approveOrder: string;
  confirmShipment: string;
  handleException: string;
}

async function getTaskDefIds(): Promise<TaskDefIds> {
  const token = await apiLogin('service@flowstile.local');
  const processRes = await fetch(`${SERVER}/processes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const processes = (await processRes.json()) as { items: { id: string; name: string }[] };
  const orderProcess = processes.items.find((p) => p.name === 'Order Fulfillment');
  if (!orderProcess) throw new Error('Order Fulfillment process not found');

  const taskDefsRes = await fetch(`${SERVER}/processes/${orderProcess.id}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const taskDefs = (await taskDefsRes.json()) as { items: { id: string; code: string }[] };
  return {
    approveOrder: taskDefs.items.find((td) => td.code === 'APPROVE_ORDER')!.id,
    confirmShipment: taskDefs.items.find((td) => td.code === 'CONFIRM_SHIPMENT')!.id,
    handleException: taskDefs.items.find((td) => td.code === 'HANDLE_EXCEPTION')!.id,
  };
}

function startWorkflow(wfId: string, taskDefIds: TaskDefIds, orderId: string) {
  const startArgs = JSON.stringify({
    workflowId: wfId,
    input: {
      orderId,
      customerName: 'E2E Test Customer',
      customerEmail: 'e2e@test.local',
      shippingAddress: '123 Test Street',
      items: [{ name: 'Widget', quantity: 2, price: 25 }],
      total: 50.00,
      approveOrderTaskDefId: taskDefIds.approveOrder,
      confirmShipmentTaskDefId: taskDefIds.confirmShipment,
      handleExceptionTaskDefId: taskDefIds.handleException,
    },
  });
  const helperPath = path.resolve(__dirname, 'helpers', 'start-workflow.ts');
  runHelper(helperPath, startArgs);
}

function checkWorkflowStatus(wfId: string): string {
  const helperPath = path.resolve(__dirname, 'helpers', 'check-workflow.ts');
  const output = runHelper(helperPath, wfId);
  return JSON.parse(output).status;
}

/**
 * Find and claim the task matching both `taskCode` and `instanceId` (the
 * orderId shown in `.task-meta`).  Scoping by processInstanceId prevents
 * accidentally claiming a seeded task that shares the same task-definition code.
 */
async function findAndClaimTaskForProcess(
  page: Page,
  taskCode: string,
  instanceId: string,
): Promise<void> {
  let found = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (attempt > 0) {
      await page.waitForTimeout(2000);
      await page.reload();
      await expect(page.locator('.inbox').first()).toBeVisible({ timeout: 5000 });
    }

    // Wait for the task list to finish its initial API fetch (loading indicator gone).
    await expect(page.locator('.task-list-items p:has-text("Loading")')).toBeHidden({ timeout: 5000 }).catch(() => {});

    // Match a card that shows this task code AND the specific process instance.
    // filter({ hasText }) checks the full text content of the card element, which
    // includes the .task-meta span that renders task.processInstanceId.
    const card = page.locator('.task-card')
      .filter({ has: page.locator(`.task-name:has-text("${taskCode}")`) })
      .filter({ hasText: instanceId })
      .first();

    if (await card.isVisible({ timeout: 2000 }).catch(() => false)) {
      await card.click();
      await page.waitForTimeout(300);
      const claimBtn = page.locator('button:has-text("Claim")');
      if (await claimBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await claimBtn.click();
        found = true;
        break;
      }
    }
  }
  expect(found, `Should find and claim ${taskCode} for process ${instanceId}`).toBe(true);
}

// ─── Happy Path: approve → confirm → shipped ─────────────────────────────────

test.describe.serial('Order Fulfillment — Happy Path', () => {
  test.setTimeout(60000);
  let wfId: string;
  let orderId: string;

  test.beforeAll(async () => {
    const taskDefIds = await getTaskDefIds();
    orderId = `ORD-HAPPY-${Date.now()}`;
    wfId = `order-fulfillment-${orderId}`;
    startWorkflow(wfId, taskDefIds, orderId);
    await new Promise((r) => setTimeout(r, 8000));
  });

  test('alice approves the order', async ({ page }) => {
    await loginAs(page, 'alice@example.com');
    await findAndClaimTaskForProcess(page, 'APPROVE_ORDER', orderId);

    const completeBtn = page.locator('button:has-text("Complete")');
    await expect(completeBtn).toBeVisible({ timeout: 5000 });

    const decisionSelect = page.locator('select').first();
    if (await decisionSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await decisionSelect.selectOption({ label: 'APPROVED' });
    }

    await completeBtn.click();
    await expect(completeBtn).not.toBeVisible({ timeout: 10000 });
  });

  test('bob confirms shipment', async ({ page }) => {
    await loginAs(page, 'bob@example.com');
    await findAndClaimTaskForProcess(page, 'CONFIRM_SHIPMENT', orderId);

    const completeBtn = page.locator('button:has-text("Complete")');
    await expect(completeBtn).toBeVisible({ timeout: 5000 });

    const decisionSelect = page.locator('select').first();
    await expect(decisionSelect).toBeVisible({ timeout: 5000 });
    await decisionSelect.selectOption({ label: 'CONFIRMED' });

    const trackingInput = page.locator('input[id*="tracking"], input[id*="Tracking"]').first();
    if (await trackingInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await trackingInput.fill('TRACK-HAPPY-12345');
    }

    await completeBtn.click();
    await expect(completeBtn).not.toBeVisible({ timeout: 10000 });
  });

  test('workflow completes with status shipped', async () => {
    await new Promise((r) => setTimeout(r, 2000));
    expect(checkWorkflowStatus(wfId)).toBe('COMPLETED');
  });
});

// ─── Saga Path: approve → warehouse rejects → compensation → handle exception ─

test.describe.serial('Order Fulfillment — Saga Compensation', () => {
  test.setTimeout(60000);
  let wfId: string;
  let orderId: string;

  test.beforeAll(async () => {
    const taskDefIds = await getTaskDefIds();
    orderId = `ORD-SAGA-${Date.now()}`;
    wfId = `order-fulfillment-${orderId}`;
    startWorkflow(wfId, taskDefIds, orderId);
    await new Promise((r) => setTimeout(r, 8000));
  });

  test('alice approves the order', async ({ page }) => {
    await loginAs(page, 'alice@example.com');
    await findAndClaimTaskForProcess(page, 'APPROVE_ORDER', orderId);

    const completeBtn = page.locator('button:has-text("Complete")');
    await expect(completeBtn).toBeVisible({ timeout: 5000 });

    const decisionSelect = page.locator('select').first();
    if (await decisionSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await decisionSelect.selectOption({ label: 'APPROVED' });
    }

    await completeBtn.click();
    await expect(completeBtn).not.toBeVisible({ timeout: 10000 });
  });

  test('bob rejects at warehouse (triggers saga)', async ({ page }) => {
    await loginAs(page, 'bob@example.com');
    await findAndClaimTaskForProcess(page, 'CONFIRM_SHIPMENT', orderId);

    const completeBtn = page.locator('button:has-text("Complete")');
    await expect(completeBtn).toBeVisible({ timeout: 5000 });

    // REJECT the shipment — this triggers saga compensation
    const decisionSelect = page.locator('select').first();
    await expect(decisionSelect).toBeVisible({ timeout: 5000 });
    await decisionSelect.selectOption({ label: 'REJECTED' });

    // Fill in rejection reason
    const reasonTextarea = page.locator('textarea').first();
    if (await reasonTextarea.isVisible({ timeout: 1000 }).catch(() => false)) {
      await reasonTextarea.fill('Item out of stock');
    }

    await completeBtn.click();
    await expect(completeBtn).not.toBeVisible({ timeout: 10000 });
  });

  test('carol handles the customer exception', async ({ page }) => {
    await loginAs(page, 'carol@example.com');

    // After saga compensation (refund), the HANDLE_EXCEPTION task is created
    await findAndClaimTaskForProcess(page, 'HANDLE_EXCEPTION', orderId);

    const completeBtn = page.locator('button:has-text("Complete")');
    await expect(completeBtn).toBeVisible({ timeout: 5000 });

    // Set resolution
    const resolutionSelect = page.locator('select').first();
    if (await resolutionSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await resolutionSelect.selectOption('CONTACTED');
    }

    // Fill notes
    const notesTextarea = page.locator('textarea').first();
    if (await notesTextarea.isVisible({ timeout: 1000 }).catch(() => false)) {
      await notesTextarea.fill('Customer contacted and offered voucher');
    }

    await completeBtn.click();
    await expect(completeBtn).not.toBeVisible({ timeout: 10000 });
  });

  test('workflow completes with status rejected', async () => {
    await new Promise((r) => setTimeout(r, 2000));
    expect(checkWorkflowStatus(wfId)).toBe('COMPLETED');
  });
});

// ─── Early Exit: order rejected at approval ───────────────────────────────────

test.describe.serial('Order Fulfillment — Rejection at Approval', () => {
  test.setTimeout(60000);
  let wfId: string;
  let orderId: string;

  test.beforeAll(async () => {
    const taskDefIds = await getTaskDefIds();
    orderId = `ORD-REJECT-${Date.now()}`;
    wfId = `order-fulfillment-${orderId}`;
    startWorkflow(wfId, taskDefIds, orderId);
    await new Promise((r) => setTimeout(r, 8000));
  });

  test('alice rejects the order', async ({ page }) => {
    await loginAs(page, 'alice@example.com');
    await findAndClaimTaskForProcess(page, 'APPROVE_ORDER', orderId);

    const completeBtn = page.locator('button:has-text("Complete")');
    await expect(completeBtn).toBeVisible({ timeout: 5000 });

    // REJECT the order
    const decisionSelect = page.locator('select').first();
    if (await decisionSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await decisionSelect.selectOption({ label: 'REJECTED' });
    }

    // Fill reason
    const reasonTextarea = page.locator('textarea').first();
    if (await reasonTextarea.isVisible({ timeout: 1000 }).catch(() => false)) {
      await reasonTextarea.fill('Suspected fraud');
    }

    await completeBtn.click();
    await expect(completeBtn).not.toBeVisible({ timeout: 10000 });
  });

  test('workflow completes immediately (no payment, no shipment)', async () => {
    await new Promise((r) => setTimeout(r, 2000));
    expect(checkWorkflowStatus(wfId)).toBe('COMPLETED');
  });
});
