import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';

// ────────────────────────────────────────────────────────────────────────────
// Purchase Requisition Approval — API-driven e2e.
//
// Authored test-first (red → green) per the flowstile-authoring skill §1: this
// spec is the executable rubric. It exercises the full process via the REST API
// contracts documented in the skill §5 (portal start, case read-back, human task
// lifecycle, case-entity read-back) — no browser needed.
//
// Plan:  MANAGER_APPROVAL → FINANCE_APPROVAL (only when AMOUNT > 5000) → PO_ISSUANCE
//
// Scenarios:
//  1. Small request, manager approves        → APPROVED, finance skipped, PO issued
//  2. Large request, manager + finance approve→ APPROVED, finance ran,    PO issued
//  3. Manager rejects                         → REJECTED, no finance, no PO
//  4. Large request, finance declines         → DECLINED, no PO
// ────────────────────────────────────────────────────────────────────────────

const SERVER = 'http://localhost:3000';

// Seeded credentials (added to seed.ts for this process).
const ADMIN = { email: 'alice@example.com', password: 'password' };
const MANAGER = { email: 'pat@example.com', password: 'password' };
const FINANCE = { email: 'quinn@example.com', password: 'password' };

const PROCESS_NAME = 'Purchase Requisition Approval';

async function ctxFor(creds: { email: string; password: string }): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: SERVER });
  const res = await ctx.post('/auth/login', { data: creds });
  expect(res.ok(), `login ${creds.email}: ${res.status()}`).toBeTruthy();
  return ctx;
}

async function findProcessId(admin: APIRequestContext): Promise<string> {
  const res = await admin.get('/processes?limit=200');
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  const proc = body.items.find((p: { name: string }) => p.name === PROCESS_NAME);
  expect(proc, `process "${PROCESS_NAME}" must exist`).toBeTruthy();
  return proc.id;
}

async function startCase(
  admin: APIRequestContext,
  processId: string,
  data: Record<string, unknown>,
): Promise<{ processInstanceId: string; caseId: string }> {
  const res = await admin.post(`/processes/${processId}/start`, { data: { data } });
  expect(res.ok(), `start: ${res.status()} ${await res.text()}`).toBeTruthy();
  return res.json();
}

// The case 404s for a beat after start until the workflow creates its first task.
async function waitForOpenTask(
  user: APIRequestContext,
  pid: string,
  taskCode: string,
): Promise<{ id: string }> {
  for (let i = 0; i < 60; i++) {
    const res = await user.get(`/cases/by-process-instance/${pid}`);
    if (res.ok()) {
      const body = await res.json();
      const task = (body.tasks ?? []).find(
        (t: { taskDefinition?: { code?: string }; status: string }) =>
          t.taskDefinition?.code === taskCode &&
          (t.status === 'created' || t.status === 'claimed'),
      );
      if (task) return task;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for task ${taskCode} on ${pid}`);
}

async function completeTask(
  user: APIRequestContext,
  pid: string,
  taskCode: string,
  submission: Record<string, unknown>,
): Promise<void> {
  const task = await waitForOpenTask(user, pid, taskCode);
  const claim = await user.post(`/tasks/${task.id}/claim`);
  expect(claim.ok(), `claim ${taskCode}: ${claim.status()} ${await claim.text()}`).toBeTruthy();
  const complete = await user.post(`/tasks/${task.id}/complete`, { data: { data: submission } });
  expect(complete.ok(), `complete ${taskCode}: ${complete.status()} ${await complete.text()}`).toBeTruthy();
}

// The case entity is created (with start-form data) the moment the case starts,
// and `persist`/patch writes land a beat later (after the completion signal
// round-trips through the workflow). So poll until the expected keys appear,
// not just until the entity exists.
async function getEntity(
  user: APIRequestContext,
  pid: string,
  requireKeys: string[] = [],
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> | undefined;
  for (let i = 0; i < 60; i++) {
    const res = await user.get(`/cases/by-process-instance/${pid}/entity`);
    if (res.ok()) {
      const body = await res.json();
      if (body.entity) {
        last = body.entity;
        if (requireKeys.every((k) => k in (body.entity as Record<string, unknown>))) {
          return body.entity;
        }
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `timed out reading entity for ${pid} with keys [${requireKeys.join(', ')}]; last: ${JSON.stringify(last)}`,
  );
}

// Poll the case until all tasks terminal and status settles.
async function waitForCaseStatus(
  user: APIRequestContext,
  caseId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> | undefined;
  for (let i = 0; i < 60; i++) {
    const res = await user.get(`/cases/${caseId}`);
    if (res.ok()) {
      last = await res.json();
      if (last.status === expected) return last;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`case ${caseId} status ${JSON.stringify(last?.status)} != ${expected}`);
}

function milestoneState(caseBody: Record<string, unknown>, code: string): string | undefined {
  const ms = (caseBody.milestones as { code: string; state: string }[] | undefined) ?? [];
  return ms.find((m) => m.code === code)?.state;
}

let admin: APIRequestContext;
let manager: APIRequestContext;
let finance: APIRequestContext;
let processId: string;

test.beforeAll(async () => {
  // global-setup re-seeds the DB before the run; just authenticate here.
  admin = await ctxFor(ADMIN);
  manager = await ctxFor(MANAGER);
  finance = await ctxFor(FINANCE);
  processId = await findProcessId(admin);
});

test.afterAll(async () => {
  await admin?.dispose();
  await manager?.dispose();
  await finance?.dispose();
});

test('small request: manager approves → APPROVED, finance skipped, PO issued', async () => {
  const { processInstanceId: pid, caseId } = await startCase(admin, processId, {
    REQUESTER_NAME: 'Riley Small',
    ITEM: 'Standing desk',
    AMOUNT: 1200,
    JUSTIFICATION: 'Ergonomics',
  });

  await completeTask(manager, pid, 'PR_MANAGER_APPROVAL', { DECISION: 'APPROVED', NOTES: 'ok' });

  // Wait for the workflow to finish so all persists have landed before asserting.
  const result = await workflowResult(pid);
  expect(result.outcome).toBe('APPROVED');
  expect(result.managerDecision).toBe('APPROVED');
  expect(result.financeDecision).toBeNull();

  const entity = await getEntity(admin, pid, ['MANAGER_DECISION', 'PURCHASE_ORDER_NUMBER']);
  expect(entity.MANAGER_DECISION).toBe('APPROVED');
  expect(entity.FINANCE_DECISION).toBeUndefined();
  expect(typeof entity.PURCHASE_ORDER_NUMBER).toBe('string');
  expect(entity.PURCHASE_ORDER_NUMBER).toMatch(/^PO-/);
  expect(result.purchaseOrderNumber).toBe(entity.PURCHASE_ORDER_NUMBER);

  const caseBody = await waitForCaseStatus(admin, caseId, 'completed');
  expect(milestoneState(caseBody, 'MANAGER_APPROVAL')).toBe('achieved');
  // FINANCE_APPROVAL had no task (skipped for small request).
  expect(milestoneState(caseBody, 'FINANCE_APPROVAL')).toBe('skipped');
  // PO_ISSUANCE is a trailing automated phase → reads skipped once case closes.
  expect(milestoneState(caseBody, 'PO_ISSUANCE')).toBe('skipped');
});

test('large request: manager + finance approve → APPROVED, finance ran, PO issued', async () => {
  const { processInstanceId: pid, caseId } = await startCase(admin, processId, {
    REQUESTER_NAME: 'Dana Large',
    ITEM: 'Server rack',
    AMOUNT: 12000,
    JUSTIFICATION: 'Capacity',
  });

  await completeTask(manager, pid, 'PR_MANAGER_APPROVAL', { DECISION: 'APPROVED', NOTES: 'fine' });
  await completeTask(finance, pid, 'PR_FINANCE_APPROVAL', { DECISION: 'APPROVED', NOTES: 'budgeted' });

  const result = await workflowResult(pid);
  expect(result.outcome).toBe('APPROVED');
  expect(result.managerDecision).toBe('APPROVED');
  expect(result.financeDecision).toBe('APPROVED');

  const entity = await getEntity(admin, pid, [
    'MANAGER_DECISION',
    'FINANCE_DECISION',
    'PURCHASE_ORDER_NUMBER',
  ]);
  expect(entity.MANAGER_DECISION).toBe('APPROVED');
  expect(entity.FINANCE_DECISION).toBe('APPROVED');
  expect(entity.PURCHASE_ORDER_NUMBER).toMatch(/^PO-/);
  expect(result.purchaseOrderNumber).toBe(entity.PURCHASE_ORDER_NUMBER);

  const caseBody = await waitForCaseStatus(admin, caseId, 'completed');
  expect(milestoneState(caseBody, 'MANAGER_APPROVAL')).toBe('achieved');
  expect(milestoneState(caseBody, 'FINANCE_APPROVAL')).toBe('achieved');
  expect(milestoneState(caseBody, 'PO_ISSUANCE')).toBe('skipped');
});

test('manager rejects → REJECTED, no finance, no PO', async () => {
  const { processInstanceId: pid, caseId } = await startCase(admin, processId, {
    REQUESTER_NAME: 'Sam Reject',
    ITEM: 'Gold stapler',
    AMOUNT: 8000,
    JUSTIFICATION: 'Vanity',
  });

  await completeTask(manager, pid, 'PR_MANAGER_APPROVAL', { DECISION: 'REJECTED', NOTES: 'no' });

  const result = await workflowResult(pid);
  expect(result.outcome).toBe('REJECTED');
  expect(result.managerDecision).toBe('REJECTED');
  expect(result.financeDecision).toBeNull();
  expect(result.purchaseOrderNumber).toBeNull();

  const entity = await getEntity(admin, pid, ['MANAGER_DECISION']);
  expect(entity.MANAGER_DECISION).toBe('REJECTED');
  expect(entity.FINANCE_DECISION).toBeUndefined();
  expect(entity.PURCHASE_ORDER_NUMBER).toBeUndefined();

  await waitForCaseStatus(admin, caseId, 'completed');
});

test('large request: finance declines → DECLINED, no PO', async () => {
  const { processInstanceId: pid, caseId } = await startCase(admin, processId, {
    REQUESTER_NAME: 'Lee Decline',
    ITEM: 'Espresso machine',
    AMOUNT: 9000,
    JUSTIFICATION: 'Morale',
  });

  await completeTask(manager, pid, 'PR_MANAGER_APPROVAL', { DECISION: 'APPROVED', NOTES: 'sure' });
  await completeTask(finance, pid, 'PR_FINANCE_APPROVAL', { DECISION: 'REJECTED', NOTES: 'over budget' });

  const result = await workflowResult(pid);
  expect(result.outcome).toBe('DECLINED');
  expect(result.managerDecision).toBe('APPROVED');
  expect(result.financeDecision).toBe('REJECTED');
  expect(result.purchaseOrderNumber).toBeNull();

  const entity = await getEntity(admin, pid, ['MANAGER_DECISION', 'FINANCE_DECISION']);
  expect(entity.MANAGER_DECISION).toBe('APPROVED');
  expect(entity.FINANCE_DECISION).toBe('REJECTED');
  expect(entity.PURCHASE_ORDER_NUMBER).toBeUndefined();

  await waitForCaseStatus(admin, caseId, 'completed');
});

// ── Workflow typed-result read-back via @temporalio/client ──────────────────
// The worker's @temporalio/client dep isn't hoisted to the repo root, so this
// runs the query through a worker-cwd tsx helper authored alongside this spec.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

interface WorkflowResult {
  outcome: string;
  managerDecision: string | null;
  financeDecision: string | null;
  purchaseOrderNumber: string | null;
}

async function workflowResult(wfId: string): Promise<WorkflowResult> {
  const workerDir = path.resolve(__dirname, '../packages/worker');
  const helper = path.resolve(__dirname, 'helpers/pr-workflow-result.ts');
  // Poll: the workflow finishes a beat after the case completes (signal round-trip).
  let last = '';
  for (let i = 0; i < 40; i++) {
    const out = execFileSync('pnpm', ['exec', 'tsx', helper, wfId], {
      cwd: workerDir,
      encoding: 'utf-8',
    });
    last = out.trim().split('\n').filter(Boolean).pop() ?? '';
    const parsed = JSON.parse(last);
    if (parsed.status === 'COMPLETED' && parsed.result) return parsed.result as WorkflowResult;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`workflow for ${pid} never completed; last: ${last}`);
}
