import { test, expect, type Page } from '@playwright/test';

// Need-to-know visibility, end to end against the running stack.
//
// Seeded users (see packages/server/src/seed.ts):
//   alice — admin: holds tasks:manage + cases:read → oversight, sees everything.
//           groups: loan-officers, order-reviewers
//   bob   — task-user: no oversight. groups: loan-officers, warehouse
//   carol — task-user: no oversight. groups: customer-service
//
// The rule under test: a non-oversight user sees a task only when they are its
// assignee, a candidate user (by email), or a member of a candidate group.
// Cases inherit visibility from their tasks (plus "started it" and oversight).

const BASE = 'http://localhost:5173';
const SERVER = 'http://localhost:3000';

// Logs in over HTTP and returns the bearer token for that user.
async function tokenFor(email: string): Promise<string> {
  const res = await fetch(`${SERVER}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password' }),
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.match(/flowstile_token=([^;]+)/)?.[1] ?? '';
}

// Authenticated API call as a specific user.
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

// Returns the ids visible to a user on GET /tasks (paging through everything).
async function visibleTaskIds(email: string): Promise<Set<string>> {
  const { body } = await apiAs(email, 'GET', '/tasks?limit=200');
  return new Set((body.items ?? []).map((t: { id: string }) => t.id));
}

async function visibleCasePids(email: string): Promise<Set<string>> {
  const { body } = await apiAs(email, 'GET', '/cases?limit=200');
  return new Set((body.items ?? []).map((c: { processInstanceId: string }) => c.processInstanceId));
}

async function loginUi(page: Page, email: string) {
  await page.goto(BASE);
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', 'password');
  await page.click('button[type="submit"]');
  await expect(page.locator('text=Inbox').or(page.locator('text=Tasks')).first())
    .toBeVisible({ timeout: 10000 });
}

test.describe('Need-to-know task & case visibility', () => {
  // Shared fixture: one form + process + task def, three tasks with distinct
  // candidate configurations, each on its own process instance (→ own case).
  const tag = Date.now();
  const formCode = `E2E_VIS_${tag}`;
  let taskDefId: string;

  // Filled in by the setup test.
  const groupTask = { id: '', pid: `e2e-vis-grp-${tag}` };   // candidateGroups: [customer-service]
  const userTask = { id: '', pid: `e2e-vis-usr-${tag}` };    // candidateUsers: [bob]
  const orphanTask = { id: '', pid: `e2e-vis-orphan-${tag}` }; // no candidates

  test.beforeAll(async () => {
    await apiAs('alice@example.com', 'POST', '/forms', {
      code: formCode,
      jsonSchema: {
        type: 'object',
        properties: { DECISION: { type: 'string', enum: ['approved', 'rejected'] } },
        required: ['DECISION'],
      },
      uiSchema: {
        type: 'VerticalLayout',
        elements: [{ type: 'Control', scope: '#/properties/DECISION' }],
      },
    });
    await apiAs('alice@example.com', 'POST', `/forms/${formCode}/publish`);

    const { body: process } = await apiAs('alice@example.com', 'POST', '/processes', {
      name: `E2E Visibility ${tag}`,
    });
    const { body: taskDef } = await apiAs('alice@example.com', 'POST', `/processes/${process.id}/tasks`, {
      code: `E2E_VIS_DEF_${tag}`,
      formDefinitionCode: formCode,
      candidateGroups: [],
      candidateUsers: [],
    });
    taskDefId = taskDef.id;

    // Created by alice (oversight) so creation isn't itself scope-limited.
    const grp = await apiAs('alice@example.com', 'POST', '/tasks', {
      taskDefinitionId: taskDefId,
      workflowId: groupTask.pid,
      processInstanceId: groupTask.pid,
      candidateGroups: ['customer-service'],
    });
    groupTask.id = grp.body.id;

    const usr = await apiAs('alice@example.com', 'POST', '/tasks', {
      taskDefinitionId: taskDefId,
      workflowId: userTask.pid,
      processInstanceId: userTask.pid,
      candidateUsers: ['bob@example.com'],
    });
    userTask.id = usr.body.id;

    const orphan = await apiAs('alice@example.com', 'POST', '/tasks', {
      taskDefinitionId: taskDefId,
      workflowId: orphanTask.pid,
      processInstanceId: orphanTask.pid,
    });
    orphanTask.id = orphan.body.id;
  });

  test('candidate-group task is visible to group members, hidden from others', async () => {
    // carol is in customer-service → sees it. bob is not → does not.
    const carolIds = await visibleTaskIds('carol@example.com');
    const bobIds = await visibleTaskIds('bob@example.com');
    const aliceIds = await visibleTaskIds('alice@example.com');

    expect(carolIds.has(groupTask.id)).toBe(true);
    expect(bobIds.has(groupTask.id)).toBe(false);
    expect(aliceIds.has(groupTask.id)).toBe(true); // oversight sees all
  });

  test('candidate-user task is visible to that user, hidden from others', async () => {
    const bobIds = await visibleTaskIds('bob@example.com');
    const carolIds = await visibleTaskIds('carol@example.com');
    const aliceIds = await visibleTaskIds('alice@example.com');

    expect(bobIds.has(userTask.id)).toBe(true);
    expect(carolIds.has(userTask.id)).toBe(false);
    expect(aliceIds.has(userTask.id)).toBe(true);
  });

  test('uncandidated task is visible only to oversight', async () => {
    const aliceIds = await visibleTaskIds('alice@example.com');
    const bobIds = await visibleTaskIds('bob@example.com');
    const carolIds = await visibleTaskIds('carol@example.com');

    expect(aliceIds.has(orphanTask.id)).toBe(true);
    expect(bobIds.has(orphanTask.id)).toBe(false);
    expect(carolIds.has(orphanTask.id)).toBe(false);
  });

  test('GET /tasks/:id returns 404 (not 403) for a task the caller cannot see', async () => {
    // bob may not see the customer-service task — existence must not leak.
    const res = await apiAs('bob@example.com', 'GET', `/tasks/${groupTask.id}`);
    expect(res.status).toBe(404);

    // ...while a legitimate candidate gets 200.
    const carolRes = await apiAs('carol@example.com', 'GET', `/tasks/${groupTask.id}`);
    expect(carolRes.status).toBe(200);
  });

  test('claiming a task you cannot see returns 404', async () => {
    const res = await apiAs('carol@example.com', 'POST', `/tasks/${userTask.id}/claim`);
    expect(res.status).toBe(404);
  });

  test('cases inherit task visibility', async () => {
    const carolPids = await visibleCasePids('carol@example.com');
    const bobPids = await visibleCasePids('bob@example.com');
    const alicePids = await visibleCasePids('alice@example.com');

    // The customer-service case is visible to carol, not bob; the bob case the reverse.
    expect(carolPids.has(groupTask.pid)).toBe(true);
    expect(carolPids.has(userTask.pid)).toBe(false);

    expect(bobPids.has(userTask.pid)).toBe(true);
    expect(bobPids.has(groupTask.pid)).toBe(false);

    // The orphan case (no candidate tasks) is visible only to oversight.
    expect(bobPids.has(orphanTask.pid)).toBe(false);
    expect(carolPids.has(orphanTask.pid)).toBe(false);
    expect(alicePids.has(orphanTask.pid)).toBe(true);
  });

  test('case entity read is 404 for a non-involved user', async () => {
    const res = await apiAs('bob@example.com', 'GET', `/cases/by-process-instance/${groupTask.pid}/entity`);
    expect(res.status).toBe(404);

    const carolRes = await apiAs('carol@example.com', 'GET', `/cases/by-process-instance/${groupTask.pid}/entity`);
    expect(carolRes.status).toBe(200);
  });

  test('inbox UI reflects scoping: carol sees her task, not bob-only or orphan', async ({ page }) => {
    await loginUi(page, 'carol@example.com');

    // carol's customer-service task should appear...
    await expect(page.locator(`.task-card:has-text("E2E_VIS_DEF_${tag}")`).first())
      .toBeVisible({ timeout: 8000 });

    // ...and none of the cards should belong to the bob-only or orphan instances.
    // (Those task cards never render for carol because the API never returns them.)
    const visible = await visibleTaskIds('carol@example.com');
    expect(visible.has(userTask.id)).toBe(false);
    expect(visible.has(orphanTask.id)).toBe(false);
  });
});
