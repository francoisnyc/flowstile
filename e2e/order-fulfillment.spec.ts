import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

const BASE = 'http://localhost:5173';
const SERVER = 'http://localhost:3000';

const TSX = path.resolve(__dirname, '..', 'node_modules', '.pnpm', 'node_modules', '.bin', 'tsx');
const ROOT = path.resolve(__dirname, '..');

let workflowId: string;

function runHelper(script: string, arg: string): string {
  return execSync(`${TSX} --tsconfig ${ROOT}/tsconfig.base.json ${script} '${arg}'`, {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15000,
  }).toString().trim();
}

async function loginAs(page: Page, email: string) {
  await page.goto(BASE);
  // If not on login page, logout first
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

test.describe.serial('Order Fulfillment Workflow', () => {
  test.setTimeout(60000);
  test.beforeAll(async () => {
    const token = await apiLogin('service@flowstile.local');

    // Get task definition IDs
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
    const approveOrder = taskDefs.items.find((td) => td.code === 'APPROVE_ORDER');
    const confirmShipment = taskDefs.items.find((td) => td.code === 'CONFIRM_SHIPMENT');
    const handleException = taskDefs.items.find((td) => td.code === 'HANDLE_EXCEPTION');

    if (!approveOrder || !confirmShipment || !handleException) {
      throw new Error('Missing task definitions');
    }

    const orderId = `ORD-E2E-${Date.now()}`;
    workflowId = `order-fulfillment-${orderId}`;

    const startArgs = JSON.stringify({
      workflowId,
      input: {
        orderId,
        customerName: 'E2E Test Customer',
        customerEmail: 'e2e@test.local',
        shippingAddress: '123 Test Street',
        items: [{ name: 'Widget', quantity: 2, price: 25 }],
        total: 50.00,
        approveOrderTaskDefId: approveOrder.id,
        confirmShipmentTaskDefId: confirmShipment.id,
        handleExceptionTaskDefId: handleException.id,
      },
    });

    const helperPath = path.resolve(__dirname, 'helpers', 'start-workflow.ts');
    runHelper(helperPath, startArgs);

    // Give the workflow time to create the first human task
    await new Promise((r) => setTimeout(r, 3000));
  });

  test('alice approves the order', async ({ page }) => {
    await loginAs(page, 'alice@example.com');

    // Wait for the APPROVE_ORDER task to appear in inbox
    const taskRow = page.locator('text=APPROVE_ORDER').first();
    await expect(taskRow).toBeVisible({ timeout: 15000 });
    await taskRow.click();

    // Claim the task
    const claimBtn = page.locator('button:has-text("Claim")');
    await expect(claimBtn).toBeVisible({ timeout: 5000 });
    await claimBtn.click();

    // Complete button should appear after claiming
    const completeBtn = page.locator('button:has-text("Complete")');
    await expect(completeBtn).toBeVisible({ timeout: 5000 });

    // JSON Forms renders enum as <select> — set approval decision
    // The DECISION field enum values are uppercase: APPROVED, REJECTED
    const decisionSelect = page.locator('select').first();
    if (await decisionSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await decisionSelect.selectOption({ label: 'APPROVED' });
    }

    await completeBtn.click();

    // Wait for the Complete button to disappear (action processed)
    await expect(completeBtn).not.toBeVisible({ timeout: 10000 });
  });

  test('bob confirms shipment', async ({ page }) => {
    await loginAs(page, 'bob@example.com');

    // Wait for the workflow-created CONFIRM_SHIPMENT task.
    // The seed has one already claimed by bob — we need the new unclaimed one.
    // Poll by reloading until we find a claimable CONFIRM_SHIPMENT task.
    let found = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) {
        await page.waitForTimeout(2000);
        await page.reload();
        await expect(page.locator('.inbox').first()).toBeVisible({ timeout: 5000 });
      }

      const taskRows = page.locator('.task-name:has-text("CONFIRM_SHIPMENT")');
      const count = await taskRows.count();
      for (let i = 0; i < count; i++) {
        await taskRows.nth(i).click();
        // Wait a moment for the detail panel to render
        await page.waitForTimeout(300);
        const claimBtn = page.locator('button:has-text("Claim")');
        if (await claimBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
          // Click claim immediately while it's stable
          await claimBtn.click();
          found = true;
          break;
        }
      }
      if (found) break;
    }

    expect(found, 'Should find and claim a CONFIRM_SHIPMENT task').toBe(true);

    // Fill form and complete
    const completeBtn = page.locator('button:has-text("Complete")');
    await expect(completeBtn).toBeVisible({ timeout: 5000 });

    // Set decision to CONFIRMED (enum values are uppercase)
    const decisionSelect = page.locator('select').first();
    if (await decisionSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      await decisionSelect.selectOption('CONFIRMED');
    }

    // Fill tracking number if field is visible
    const trackingInput = page.locator('input[id*="tracking"], input[id*="Tracking"]').first();
    if (await trackingInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await trackingInput.fill('TRACK-E2E-12345');
    }

    await completeBtn.click();

    // Wait for the Complete button to disappear (action processed)
    await expect(completeBtn).not.toBeVisible({ timeout: 10000 });
  });

  test('workflow completed successfully', async () => {
    // Give workflow a moment to finish
    await new Promise((r) => setTimeout(r, 2000));

    const helperPath = path.resolve(__dirname, 'helpers', 'check-workflow.ts');
    const output = runHelper(helperPath, workflowId);
    const { status } = JSON.parse(output);
    expect(status).toBe('COMPLETED');
  });
});
