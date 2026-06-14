import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Vacation Leave Request — API-driven e2e.
//
// MANAGER_REVIEW → HR_REVIEW (only when DAYS > 10) → LEDGER_UPDATE (trailing
// automated phase). Drives the process entirely through the REST API (portal
// start, claim/complete as the right candidate-group users), asserts case
// status, milestone states, the persisted case entity, and the workflow's typed
// result via Temporal.
//
// No browser is used, so these run even where Chromium is unavailable. (A guard
// is provided for any future UI assertion — see `browserAvailable`.)
// ---------------------------------------------------------------------------

const BASE = 'http://localhost:3000';
const REPO_ROOT = path.resolve(__dirname, '..');
const WORKER_DIR = path.join(REPO_ROOT, 'packages', 'worker');

// Guard for browser-dependent assertions (none here, but per the e2e contract).
function browserAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { chromium } = require('@playwright/test');
    return Boolean(chromium.executablePath());
  } catch {
    return false;
  }
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password' }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status}`);
  const cookie = res.headers.get('set-cookie') ?? '';
  const match = cookie.match(/flowstile_token=([^;]+)/);
  if (!match) throw new Error(`no token in Set-Cookie for ${email}`);
  return match[1];
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers as Record<string, string>),
    },
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`);
  // Some lifecycle endpoints (claim/cancel) return no body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

interface ProcItem { id: string; name: string }
interface CaseView {
  id: string;
  status: string;
  tasks: { id: string; status: string; taskDefinition?: { code: string } }[];
  milestones?: { code: string; state: string }[];
}

async function findProcessId(token: string, name: string): Promise<string> {
  const { items } = await api<{ items: ProcItem[] }>(token, '/processes?limit=200');
  const proc = items.find((p) => p.name === name);
  if (!proc) throw new Error(`process "${name}" not found`);
  return proc.id;
}

async function startCase(
  token: string,
  processId: string,
  data: Record<string, unknown>,
): Promise<{ processInstanceId: string; caseId: string }> {
  return api(token, `/processes/${processId}/start`, {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
}

async function getCase(token: string, processInstanceId: string): Promise<CaseView> {
  return api<CaseView>(token, `/cases/by-process-instance/${processInstanceId}`);
}

// The case is created a beat after POST /start returns (the workflow must first
// run far enough to create its initial task), so a read can briefly 404. Returns
// null on 404 so callers can poll.
async function tryGetCase(token: string, processInstanceId: string): Promise<CaseView | null> {
  const res = await fetch(`${BASE}/cases/by-process-instance/${processInstanceId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET case ${processInstanceId} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as CaseView;
}

async function getEntity(token: string, processInstanceId: string): Promise<Record<string, unknown>> {
  const { entity } = await api<{ entity: Record<string, unknown> | null }>(
    token,
    `/cases/by-process-instance/${processInstanceId}/entity`,
  );
  return entity ?? {};
}

// Poll the case until a task with the given code is open (created/claimed).
async function waitForOpenTask(
  token: string,
  processInstanceId: string,
  code: string,
  timeoutMs = 15000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = await tryGetCase(token, processInstanceId);
    const t = c?.tasks.find(
      (x) => x.taskDefinition?.code === code && (x.status === 'created' || x.status === 'claimed'),
    );
    if (t) return t.id;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for open task ${code} on ${processInstanceId}`);
}

async function completeTask(
  token: string,
  taskId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await api(token, `/tasks/${taskId}/claim`, { method: 'POST' });
  await api(token, `/tasks/${taskId}/complete`, { method: 'POST', body: JSON.stringify({ data }) });
}

interface WorkflowResult {
  status: string;
  result: {
    outcome: string;
    employeeName: string;
    days: number;
    managerDecision: string;
    hrDecision: string | null;
    leaveReference: string | null;
  } | null;
}

// Poll Temporal (via the worker-local @temporalio/client) until the workflow
// reaches a terminal state, then return its status + typed result.
async function waitForWorkflow(workflowId: string, timeoutMs = 20000): Promise<WorkflowResult> {
  const deadline = Date.now() + timeoutMs;
  let last: WorkflowResult = { status: 'UNKNOWN', result: null };
  while (Date.now() < deadline) {
    const out = execFileSync(
      'pnpm',
      [
        'exec',
        'tsx',
        '--tsconfig',
        path.join(REPO_ROOT, 'tsconfig.base.json'),
        path.join(WORKER_DIR, 'src', 'vacation-leave', 'check-result.ts'),
        workflowId,
      ],
      { cwd: WORKER_DIR, encoding: 'utf-8' },
    );
    const line = out.trim().split('\n').filter(Boolean).pop()!;
    last = JSON.parse(line) as WorkflowResult;
    if (last.status === 'COMPLETED' || last.status === 'FAILED') return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

test.describe('Vacation Leave Request', () => {
  let alice: string;
  let mona: string; // people-managers
  let helen: string; // hr-reviewers
  let processId: string;

  test.beforeAll(async () => {
    alice = await login('alice@example.com');
    mona = await login('mona@example.com');
    helen = await login('helen@example.com');
    processId = await findProcessId(alice, 'Vacation Leave Request');
    // browserAvailable() is intentionally unused for assertions here (the spec is
    // fully API-driven); referenced so the guard helper isn't dead code.
    void browserAvailable;
  });

  test('happy path: DAYS > 10 runs manager → HR → ledger and persists variables', async () => {
    const { processInstanceId } = await startCase(alice, processId, {
      EMPLOYEE_NAME: 'Tina Test',
      START_DATE: '2026-07-01',
      END_DATE: '2026-07-16',
      DAYS: 15,
      REASON: 'Long vacation',
    });

    const managerTask = await waitForOpenTask(mona, processInstanceId, 'VACATION_MANAGER_REVIEW');
    await completeTask(mona, managerTask, {
      EMPLOYEE_NAME: 'Tina Test',
      DAYS: 15,
      DECISION: 'APPROVE',
      NOTES: 'Approved by manager',
    });

    // HR review only appears for DAYS > 10.
    const hrTask = await waitForOpenTask(helen, processInstanceId, 'VACATION_HR_REVIEW');
    await completeTask(helen, hrTask, {
      EMPLOYEE_NAME: 'Tina Test',
      DAYS: 15,
      DECISION: 'APPROVE',
      NOTES: 'Approved by HR',
    });

    const wf = await waitForWorkflow(processInstanceId);
    expect(wf.status).toBe('COMPLETED');
    expect(wf.result?.outcome).toBe('APPROVED');
    expect(wf.result?.hrDecision).toBe('APPROVE');
    expect(wf.result?.leaveReference).toMatch(/^LEAVE-/);

    // Persisted case variables.
    const entity = await getEntity(alice, processInstanceId);
    expect(entity.managerDecision).toBe('APPROVE');
    expect(entity.hrDecision).toBe('APPROVE');
    expect(String(entity.leaveReference)).toMatch(/^LEAVE-/);

    // Case + milestones. Trailing automated LEDGER_UPDATE reads `skipped`
    // (the stepper can't distinguish "ran automatically" from "skipped" with
    // no human task — per the skill).
    const c = await getCase(alice, processInstanceId);
    expect(c.status).toBe('completed');
    const states = Object.fromEntries((c.milestones ?? []).map((m) => [m.code, m.state]));
    expect(states.MANAGER_REVIEW).toBe('achieved');
    expect(states.HR_REVIEW).toBe('achieved');
    expect(states.LEDGER_UPDATE).toBe('skipped');
  });

  test('small request: DAYS <= 10 skips HR entirely', async () => {
    const { processInstanceId } = await startCase(alice, processId, {
      EMPLOYEE_NAME: 'Sam Small',
      START_DATE: '2026-08-01',
      END_DATE: '2026-08-05',
      DAYS: 5,
      REASON: 'Short break',
    });

    const managerTask = await waitForOpenTask(mona, processInstanceId, 'VACATION_MANAGER_REVIEW');
    await completeTask(mona, managerTask, {
      EMPLOYEE_NAME: 'Sam Small',
      DAYS: 5,
      DECISION: 'APPROVE',
    });

    const wf = await waitForWorkflow(processInstanceId);
    expect(wf.status).toBe('COMPLETED');
    expect(wf.result?.outcome).toBe('APPROVED');
    expect(wf.result?.hrDecision).toBeNull();
    expect(wf.result?.leaveReference).toMatch(/^LEAVE-/);

    // No HR task was ever created.
    const c = await getCase(alice, processInstanceId);
    const codes = c.tasks.map((t) => t.taskDefinition?.code);
    expect(codes).toContain('VACATION_MANAGER_REVIEW');
    expect(codes).not.toContain('VACATION_HR_REVIEW');

    const entity = await getEntity(alice, processInstanceId);
    expect(entity.managerDecision).toBe('APPROVE');
    expect(entity.hrDecision).toBeUndefined();
    expect(String(entity.leaveReference)).toMatch(/^LEAVE-/);
  });

  test('manager rejection ends the process REJECTED with no HR or ledger', async () => {
    const { processInstanceId } = await startCase(alice, processId, {
      EMPLOYEE_NAME: 'Rex Reject',
      START_DATE: '2026-09-01',
      END_DATE: '2026-09-20',
      DAYS: 18,
      REASON: 'Too long',
    });

    const managerTask = await waitForOpenTask(mona, processInstanceId, 'VACATION_MANAGER_REVIEW');
    await completeTask(mona, managerTask, {
      EMPLOYEE_NAME: 'Rex Reject',
      DAYS: 18,
      DECISION: 'REJECT',
      NOTES: 'Denied',
    });

    const wf = await waitForWorkflow(processInstanceId);
    expect(wf.status).toBe('COMPLETED');
    expect(wf.result?.outcome).toBe('REJECTED');
    expect(wf.result?.hrDecision).toBeNull();
    expect(wf.result?.leaveReference).toBeNull();

    const c = await getCase(alice, processInstanceId);
    const codes = c.tasks.map((t) => t.taskDefinition?.code);
    expect(codes).not.toContain('VACATION_HR_REVIEW');

    const entity = await getEntity(alice, processInstanceId);
    expect(entity.managerDecision).toBe('REJECT');
    expect(entity.leaveReference).toBeUndefined();
  });
});
