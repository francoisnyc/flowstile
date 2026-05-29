import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:5173';
const SERVER = 'http://localhost:3000';

async function loginUi(page: Page, email: string) {
  await page.goto(BASE);
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', 'password');
  await page.click('button[type="submit"]');
  await expect(page.locator('text=Inbox').or(page.locator('text=Tasks')).first())
    .toBeVisible({ timeout: 10000 });
}

// Authenticated API helper. Logs in as alice (admin) and returns the parsed body.
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const loginRes = await fetch(`${SERVER}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'password' }),
  });
  const cookie = loginRes.headers.get('set-cookie') ?? '';
  const token = cookie.match(/flowstile_token=([^;]+)/)?.[1] ?? '';

  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test.describe('Form outcome buttons', () => {
  test('designer adds outcomes, publishes, and persists the enum + config', async ({ page }) => {
    await loginUi(page, 'alice@example.com');

    // Open the form designer
    await page.locator('text=Forms').or(page.locator('text=Designer')).first().click();
    await expect(page.locator('.form-sidebar')).toBeVisible({ timeout: 5000 });

    // Create a new form
    const formCode = `E2E_OUTCOMES_${Date.now()}`;
    await page.fill('.new-form input', formCode);
    await page.click('.new-form button');
    await expect(page.locator('.designer-toolbar')).toBeVisible({ timeout: 8000 });

    // Go to the Outcomes tab
    await page.click('.tab:has-text("Outcomes")');
    await expect(page.locator('.outcomes-panel')).toBeVisible({ timeout: 5000 });

    // outcomeKey defaults to DECISION when the first outcome is added
    await page.click('button:has-text("Add outcome")');
    await page.click('button:has-text("Add outcome")');

    const rows = page.locator('.outcomes-table tbody tr');
    await expect(rows).toHaveCount(2);

    // Row 1 — Approve / primary
    await rows.nth(0).locator('td').nth(0).locator('input').fill('approved');
    await rows.nth(0).locator('td').nth(1).locator('input').fill('Approve');
    await rows.nth(0).locator('td').nth(2).locator('select').selectOption('primary');

    // Row 2 — Reject / danger / requires NOTES
    await rows.nth(1).locator('td').nth(0).locator('input').fill('rejected');
    await rows.nth(1).locator('td').nth(1).locator('input').fill('Reject');
    await rows.nth(1).locator('td').nth(2).locator('select').selectOption('danger');
    await rows.nth(1).locator('td').nth(3).locator('input').fill('NOTES');

    // Save draft, then publish
    await page.click('button:has-text("Save draft")');
    await expect(page.locator('button:has-text("Save draft")')).toBeEnabled({ timeout: 5000 });
    await page.click('button:has-text("Publish")');
    await expect(page.locator(`.form-item:has-text("${formCode}") .version`))
      .toBeVisible({ timeout: 8000 });

    // Verify the published form via API
    const { body: form } = await api('GET', `/forms/${formCode}`);
    expect(form.outcomeKey).toBe('DECISION');
    expect(form.outcomes).toHaveLength(2);
    expect(form.outcomes[1]).toMatchObject({ value: 'rejected', requireFields: ['NOTES'] });
    // The outcomeKey was injected into the schema as a string enum
    expect(form.jsonSchema.properties.DECISION).toEqual({
      type: 'string',
      enum: ['approved', 'rejected'],
    });
  });

  test('task view renders styled outcome buttons and enforces requireFields', async ({ page }) => {
    const tag = Date.now();
    const formCode = `E2E_OUT_TASK_${tag}`;

    // ── API setup: form with outcomes → publish → process → task def → task ──
    await api('POST', '/forms', {
      code: formCode,
      jsonSchema: {
        type: 'object',
        properties: {
          DECISION: { type: 'string', enum: ['approved', 'rejected'] },
          NOTES: { type: 'string' },
        },
        required: ['DECISION'],
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [
          { type: 'Control', scope: '#/properties/DECISION' },
          { type: 'Control', scope: '#/properties/NOTES' },
        ],
      },
      outcomes: [
        { value: 'approved', label: 'Approve', style: 'primary' },
        { value: 'rejected', label: 'Reject', style: 'danger', requireFields: ['NOTES'] },
      ],
      outcomeKey: 'DECISION',
    });
    await api('POST', `/forms/${formCode}/publish`);

    const { body: process } = await api('POST', '/processes', { name: `E2E Outcomes ${tag}` });
    const taskDefCode = `E2E_OUT_DEF_${tag}`;
    const { body: taskDef } = await api('POST', `/processes/${process.id}/tasks`, {
      code: taskDefCode,
      formDefinitionCode: formCode,
      candidateGroups: [],
      candidateUsers: [],
    });
    const { body: task } = await api('POST', '/tasks', {
      taskDefinitionId: taskDef.id,
      workflowId: `e2e-wf-${tag}`,
    });

    // ── UI: open the task, claim, and exercise the outcome buttons ──
    await loginUi(page, 'alice@example.com');

    const card = page.locator(`.task-card:has-text("${taskDefCode}")`).first();
    await expect(card).toBeVisible({ timeout: 8000 });
    await card.click();

    await expect(page.locator('.task-detail h2')).toBeVisible({ timeout: 5000 });
    await page.click('button:has-text("Claim")');
    await expect(page.locator('.status-badge')).toContainText('claimed', { timeout: 5000 });

    // Both outcome buttons render with their styles; no generic Complete button
    const approve = page.locator('.task-actions button:has-text("Approve")');
    const reject = page.locator('.task-actions button:has-text("Reject")');
    await expect(approve).toBeVisible();
    await expect(approve).toHaveClass(/primary/);
    await expect(reject).toHaveClass(/danger/);
    await expect(page.locator('.task-actions button:has-text("Complete")')).toHaveCount(0);

    // Reject without NOTES is blocked by the server's requireFields guard
    await reject.click();
    await expect(page.locator('.error-banner')).toBeVisible({ timeout: 5000 });

    // Provide NOTES, then Reject completes the task
    await page.locator('.form-container input').first().fill('Insufficient documentation');
    await reject.click();
    await expect(page.locator('.status-badge')).toContainText('completed', { timeout: 8000 });

    // Verify the outcome landed in submissionData
    const { body: completed } = await api('GET', `/tasks/${task.id}`);
    expect(completed.submissionData.DECISION).toBe('rejected');
    expect(completed.submissionData.NOTES).toBe('Insufficient documentation');
  });
});
