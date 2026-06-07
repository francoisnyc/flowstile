import { test, expect, type Page } from '@playwright/test';

// Requires a running stack (server + ui + worker) and seeded users.
// Seeded users:
//   alice — admin (tasks:manage + cases:read), groups: loan-officers, order-reviewers
//   bob   — task-user, groups: loan-officers, warehouse
//   carol — task-user, groups: customer-service

const BASE = 'http://localhost:5173';
const SERVER = 'http://localhost:3000';

async function tokenFor(email: string): Promise<string> {
  const res = await fetch(`${SERVER}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password' }),
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.match(/flowstile_token=([^;]+)/)?.[1] ?? '';
}

async function apiAs(
  email: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const token = await tokenFor(email);
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

async function loginUi(page: Page, email: string) {
  await page.goto(BASE);
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', 'password');
  await page.click('button[type="submit"]');
  await expect(page.locator('text=Inbox').or(page.locator('text=Tasks')).first())
    .toBeVisible({ timeout: 10000 });
}

test.describe('Case overview', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(60000);

  const tag = Date.now();
  const formCode = `E2E_CASE_OV_${tag}`;
  const processInstanceId = `e2e-case-overview-${tag}`;
  let taskDefId: string;
  let caseId: string;
  let taskId: string;

  test('setup: create form, process, task def, and a task', async () => {
    // Create and publish a form
    const formRes = await apiAs('alice@example.com', 'POST', '/forms', {
      code: formCode,
      jsonSchema: {
        type: 'object',
        properties: {
          DECISION: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
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
    });
    expect(formRes.status).toBeLessThan(300);

    const pubRes = await apiAs('alice@example.com', 'POST', `/forms/${formCode}/publish`);
    expect(pubRes.status).toBe(201);

    // Create process definition
    const procRes = await apiAs('alice@example.com', 'POST', '/processes', {
      name: `E2E Case Overview Process ${tag}`,
    });
    expect(procRes.status).toBe(201);
    const processId = procRes.body.id;

    // Create task definition — visible to loan-officers group (alice + bob)
    const tdRes = await apiAs('alice@example.com', 'POST', `/processes/${processId}/tasks`, {
      code: `E2E_CASE_OV_REVIEW_${tag}`,
      formDefinitionCode: formCode,
      candidateGroups: ['loan-officers'],
    });
    expect(tdRes.status).toBe(201);
    taskDefId = tdRes.body.id;

    // Create task (auto-creates case)
    const taskRes = await apiAs('alice@example.com', 'POST', '/tasks', {
      taskDefinitionId: taskDefId,
      workflowId: `wf-case-ov-${tag}`,
      processInstanceId,
      candidateGroups: ['loan-officers'],
    });
    expect(taskRes.status).toBe(201);
    taskId = taskRes.body.id;

    // Get the case
    const caseRes = await apiAs('alice@example.com', 'GET', `/cases/by-process-instance/${processInstanceId}`);
    expect(caseRes.status).toBe(200);
    caseId = caseRes.body.id;
  });

  test('case detail page shows timeline with task', async ({ page }) => {
    await loginUi(page, 'alice@example.com');

    // Navigate to the case
    await page.goto(`${BASE}/cases/${caseId}`);

    // Verify header
    await expect(page.locator('.case-detail-header h1')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.status-badge')).toBeVisible();

    // Verify progress summary
    await expect(page.locator('[data-testid="case-progress"]')).toContainText('0 of 1 tasks completed');

    // Verify timeline shows the task
    await expect(page.locator('.timeline-entry')).toHaveCount(1);
    await expect(page.locator('.timeline-task-name')).toContainText(`E2E_CASE_OV_REVIEW_${tag}`);
    await expect(page.locator('.timeline-status')).toContainText('created');
  });

  test('timeline updates after claim and completion', async ({ page }) => {
    // Claim the task
    const claimRes = await apiAs('bob@example.com', 'POST', `/tasks/${taskId}/claim`);
    expect(claimRes.status).toBe(200);

    await loginUi(page, 'bob@example.com');
    await page.goto(`${BASE}/cases/${caseId}`);

    // Should show claimed status
    await expect(page.locator('.timeline-status.active')).toContainText('claimed', { timeout: 10000 });

    // Complete the task
    const completeRes = await apiAs('bob@example.com', 'POST', `/tasks/${taskId}/complete`, {
      data: { DECISION: 'APPROVED', NOTES: 'Looks good' },
    });
    expect(completeRes.status).toBe(200);

    // Reload to see updated timeline
    await page.reload();

    // Should show completed
    await expect(page.locator('.timeline-status.completed')).toContainText('completed', { timeout: 10000 });
    await expect(page.locator('[data-testid="case-progress"]')).toContainText('1 of 1 tasks completed');
  });

  test('user can post and see comments', async ({ page }) => {
    await loginUi(page, 'alice@example.com');
    await page.goto(`${BASE}/cases/${caseId}`);

    // Wait for the page to load
    await expect(page.locator('.case-detail-header h1')).toBeVisible({ timeout: 10000 });

    // Type a comment
    await page.fill('[data-testid="comment-input"]', 'Great work on this case!');
    await page.click('[data-testid="comment-post-btn"]');

    // Verify comment appears
    await expect(page.locator('[data-testid="case-comment"]')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.comment-body').first()).toContainText('Great work on this case!');
  });

  test('second user can see existing comments and post their own', async ({ page }) => {
    await loginUi(page, 'bob@example.com');
    await page.goto(`${BASE}/cases/${caseId}`);

    // Bob should see Alice's comment
    await expect(page.locator('[data-testid="case-comment"]')).toHaveCount(1, { timeout: 10000 });

    // Bob posts a comment
    await page.fill('[data-testid="comment-input"]', 'Thanks, approved it.');
    await page.click('[data-testid="comment-post-btn"]');

    // Both comments visible
    await expect(page.locator('[data-testid="case-comment"]')).toHaveCount(2, { timeout: 5000 });
  });

  test('collapsible panels work', async ({ page }) => {
    await loginUi(page, 'alice@example.com');
    await page.goto(`${BASE}/cases/${caseId}`);
    await expect(page.locator('.case-detail-header h1')).toBeVisible({ timeout: 10000 });

    // Panels should be expanded by default — chevron shows ▼
    const firstChevron = page.locator('.panel-chevron').first();
    await expect(firstChevron).toHaveText('▼');

    // Click to collapse the first panel — chevron flips to ▶
    await page.locator('.detail-panel-header').first().click();
    await expect(firstChevron).toHaveText('▶');

    // Click to expand again — chevron back to ▼
    await page.locator('.detail-panel-header').first().click();
    await expect(firstChevron).toHaveText('▼');
  });
});

test.describe('Case overview — need-to-know security', () => {
  test.setTimeout(30000);

  const tag = Date.now() + 1;
  let caseId: string;

  test.beforeAll(async () => {
    // Create a task visible only to customer-service group
    const formCode = `E2E_SEC_${tag}`;
    await apiAs('alice@example.com', 'POST', '/forms', {
      code: formCode,
      jsonSchema: { type: 'object', properties: { NOTE: { type: 'string' } } },
      uiSchema: { type: 'VerticalLayout', elements: [{ type: 'Control', scope: '#/properties/NOTE' }] },
    });
    await apiAs('alice@example.com', 'POST', `/forms/${formCode}/publish`);

    const procRes = await apiAs('alice@example.com', 'POST', '/processes', {
      name: `E2E Sec Process ${tag}`,
    });
    const tdRes = await apiAs('alice@example.com', 'POST', `/processes/${procRes.body.id}/tasks`, {
      code: `E2E_SEC_TASK_${tag}`,
      formDefinitionCode: formCode,
      candidateGroups: ['customer-service'],
    });
    await apiAs('alice@example.com', 'POST', '/tasks', {
      taskDefinitionId: tdRes.body.id,
      workflowId: `wf-sec-${tag}`,
      processInstanceId: `e2e-sec-${tag}`,
      candidateGroups: ['customer-service'],
    });

    const caseRes = await apiAs('alice@example.com', 'GET', `/cases/by-process-instance/e2e-sec-${tag}`);
    caseId = caseRes.body.id;

    // Alice (admin/oversight) posts a comment
    await apiAs('alice@example.com', 'POST', `/cases/${caseId}/comments`, { body: 'Internal note' });
  });

  test('carol (customer-service) can see the case and its comments', async () => {
    const caseRes = await apiAs('carol@example.com', 'GET', `/cases/${caseId}`);
    expect(caseRes.status).toBe(200);
    expect(caseRes.body.commentCount).toBe(1);

    const commentsRes = await apiAs('carol@example.com', 'GET', `/cases/${caseId}/comments`);
    expect(commentsRes.status).toBe(200);
    expect(commentsRes.body.items).toHaveLength(1);
  });

  test('bob (loan-officers, not customer-service) gets 404 on case', async () => {
    const caseRes = await apiAs('bob@example.com', 'GET', `/cases/${caseId}`);
    expect(caseRes.status).toBe(404);
  });

  test('bob gets 404 on case comments (not 403 — no existence leak)', async () => {
    const commentsRes = await apiAs('bob@example.com', 'GET', `/cases/${caseId}/comments`);
    expect(commentsRes.status).toBe(404);
  });

  test('bob cannot post comments on invisible case', async () => {
    const postRes = await apiAs('bob@example.com', 'POST', `/cases/${caseId}/comments`, { body: 'sneaky' });
    expect(postRes.status).toBe(404);
  });

  test('carol can post a comment (has tasks:write via task-user role)', async () => {
    const postRes = await apiAs('carol@example.com', 'POST', `/cases/${caseId}/comments`, { body: 'Noted' });
    expect(postRes.status).toBe(201);
  });

  test('case overview page returns 404 for bob in the UI', async ({ page }) => {
    await loginUi(page, 'bob@example.com');
    await page.goto(`${BASE}/cases/${caseId}`);
    // Should show an error or redirect — not the case detail
    await expect(page.locator('.error-banner').or(page.locator('text=Failed')).first())
      .toBeVisible({ timeout: 10000 });
  });
});
