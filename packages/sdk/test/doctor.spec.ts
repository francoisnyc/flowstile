import { describe, it, expect, vi } from 'vitest';
import {
  evaluateProcessHealth,
  formatDoctorReport,
  type DoctorSnapshot,
  type DoctorReport,
} from '../src/doctor.js';
import { defineProcess } from '../src/process.js';

// defineTask (via defineProcess) imports the workflow helper; mock it so these
// pure-logic tests run in a plain Node env (same pattern as process.spec.ts).
vi.mock('../src/workflows.js', () => ({ createTaskAndWait: vi.fn() }));

// ── builders ──────────────────────────────────────────────────────────────────

// A process declaration: plan + [key, taskCode, phase] tasks.
function makeProc(
  plan: string[],
  tasks: Array<[string, string, string | null]>,
  opts: { name?: string; taskQueue?: string } = {},
) {
  return defineProcess(opts.name ?? 'Loan', {
    taskQueue: opts.taskQueue ?? 'flowstile',
    plan,
    tasks: Object.fromEntries(
      tasks.map(([key, code, phase]) => [key, makeTask(code, phase)]),
    ),
  });
}

// Minimal TaskDescriptor — evaluateProcessHealth only reads code + phase.
function makeTask(code: string, phase: string | null) {
  return {
    taskDefinitionCode: code,
    phase,
    defaults: {},
    createAndWait: vi.fn(),
  };
}

function makeSnapshot(overrides: Partial<DoctorSnapshot> & {
  serverName?: string;
  taskQueue?: string | null;
  workflowType?: string | null;
  milestones?: { code: string; name: string }[] | null;
}): DoctorSnapshot {
  const {
    serverName = 'Loan',
    taskQueue = 'flowstile',
    workflowType = 'loanWorkflow',
    milestones = null,
    taskDefs = [],
    publishedFormCodes = new Set<string>(),
  } = overrides;
  return {
    process:
      overrides.process === null
        ? null
        : { id: 'p1', name: serverName, taskQueue, workflowType, milestones },
    taskDefs,
    publishedFormCodes,
  };
}

const td = (code: string, milestoneCode: string | null, formDefinitionCode = 'F') => ({
  id: `td-${code}`,
  code,
  formDefinitionCode,
  milestoneCode,
});

function find(report: DoctorReport, check: string) {
  return report.findings.find((f) => f.check === check);
}

// ── the decision logic, branch by branch ─────────────────────────────────────

describe('evaluateProcessHealth', () => {
  it('errors and short-circuits when the process is missing', () => {
    const proc = makeProc(['APPROVAL'], [['approve', 'APPROVE', 'APPROVAL']]);
    const report = evaluateProcessHealth(proc, makeSnapshot({ process: null }));

    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ severity: 'error', check: 'process' });
  });

  it('errors on a task-queue mismatch', () => {
    const proc = makeProc(['APPROVAL'], [['approve', 'APPROVE', 'APPROVAL']], { taskQueue: 'flowstile' });
    const report = evaluateProcessHealth(
      proc,
      makeSnapshot({
        taskQueue: 'other-queue',
        milestones: [{ code: 'APPROVAL', name: 'Approval' }],
        taskDefs: [td('APPROVE', 'APPROVAL')],
        publishedFormCodes: new Set(['F']),
      }),
    );

    expect(report.ok).toBe(false);
    expect(find(report, 'taskQueue')?.severity).toBe('error');
  });

  it('warns (not errors) when the server queue / workflowType are unset', () => {
    const proc = makeProc(['APPROVAL'], [['approve', 'APPROVE', 'APPROVAL']]);
    const report = evaluateProcessHealth(
      proc,
      makeSnapshot({
        taskQueue: null,
        workflowType: null,
        milestones: [{ code: 'APPROVAL', name: 'Approval' }],
        taskDefs: [td('APPROVE', 'APPROVAL')],
        publishedFormCodes: new Set(['F']),
      }),
    );

    expect(report.ok).toBe(true); // warnings don't fail the boot
    expect(find(report, 'taskQueue')?.severity).toBe('warn');
    expect(find(report, 'workflowType')?.severity).toBe('warn');
  });

  it('errors on an unknown task code, with a did-you-mean hint when one is close', () => {
    const proc = makeProc(['APPROVAL'], [['approve', 'APPROVE_ORDR', 'APPROVAL']]);
    const report = evaluateProcessHealth(
      proc,
      makeSnapshot({
        milestones: [{ code: 'APPROVAL', name: 'Approval' }],
        taskDefs: [td('APPROVE_ORDER', 'APPROVAL')],
        publishedFormCodes: new Set(['F']),
      }),
    );

    expect(report.ok).toBe(false);
    const f = find(report, 'task:approve');
    expect(f?.severity).toBe('error');
    expect(f?.detail).toContain("Did you mean 'APPROVE_ORDER'");
  });

  it('omits the hint when nothing is within edit distance', () => {
    const proc = makeProc(['APPROVAL'], [['approve', 'ZZZZZZZZ', 'APPROVAL']]);
    const report = evaluateProcessHealth(
      proc,
      makeSnapshot({
        milestones: [{ code: 'APPROVAL', name: 'Approval' }],
        taskDefs: [td('APPROVE_ORDER', 'APPROVAL')],
        publishedFormCodes: new Set(['F']),
      }),
    );

    const f = find(report, 'task:approve');
    expect(f?.severity).toBe('error');
    expect(f?.detail).not.toContain('Did you mean');
  });

  it('warns on a phase mismatch between code and server', () => {
    // Both REVIEW and APPROVAL are valid server milestones; the code just
    // placed the task in a different (valid) one than the server did.
    const proc = makeProc(['REVIEW', 'APPROVAL'], [['approve', 'APPROVE', 'APPROVAL']]);
    const report = evaluateProcessHealth(
      proc,
      makeSnapshot({
        milestones: [{ code: 'REVIEW', name: 'Review' }, { code: 'APPROVAL', name: 'Approval' }],
        taskDefs: [td('APPROVE', 'REVIEW')], // server says REVIEW, code says APPROVAL
        publishedFormCodes: new Set(['F']),
      }),
    );

    expect(report.ok).toBe(true);
    expect(find(report, 'task:approve')?.severity).toBe('warn');
    // the mismatch is a warn, not the dangling-milestone error
    expect(find(report, 'milestone:APPROVE')).toBeUndefined();
  });

  it('warns on plan drift (order-sensitive)', () => {
    const proc = makeProc(['A', 'B'], [['t', 'T', 'A']]);
    const report = evaluateProcessHealth(
      proc,
      makeSnapshot({
        milestones: [{ code: 'B', name: 'B' }, { code: 'A', name: 'A' }], // reordered
        taskDefs: [td('T', 'A')],
        publishedFormCodes: new Set(['F']),
      }),
    );

    expect(report.ok).toBe(true);
    expect(find(report, 'plan')?.severity).toBe('warn');
  });

  it('errors when a server task references a milestone not in the plan (seed bypass)', () => {
    // Code is clean; a *second*, unreferenced server task carries a dangling
    // milestoneCode the POST/PATCH 422 never saw (written via seed).
    const proc = makeProc(['APPROVAL'], [['approve', 'APPROVE', 'APPROVAL']]);
    const report = evaluateProcessHealth(
      proc,
      makeSnapshot({
        milestones: [{ code: 'APPROVAL', name: 'Approval' }],
        taskDefs: [td('APPROVE', 'APPROVAL'), td('LEGACY', 'GHOST')],
        publishedFormCodes: new Set(['F']),
      }),
    );

    expect(report.ok).toBe(false);
    const f = find(report, 'milestone:LEGACY');
    expect(f?.severity).toBe('error');
    expect(f?.detail).toContain("'GHOST'");
  });

  it('errors on a referenced form with no published version', () => {
    const proc = makeProc(['APPROVAL'], [['approve', 'APPROVE', 'APPROVAL']]);
    const report = evaluateProcessHealth(
      proc,
      makeSnapshot({
        milestones: [{ code: 'APPROVAL', name: 'Approval' }],
        taskDefs: [td('APPROVE', 'APPROVAL', 'UNPUBLISHED_FORM')],
        publishedFormCodes: new Set(), // nothing published
      }),
    );

    expect(report.ok).toBe(false);
    expect(find(report, 'form:UNPUBLISHED_FORM')?.severity).toBe('error');
  });

  it('passes a fully-consistent process with only ok findings', () => {
    const proc = makeProc(
      ['APPROVAL', 'SHIPMENT'],
      [
        ['approve', 'APPROVE', 'APPROVAL'],
        ['ship', 'SHIP', 'SHIPMENT'],
        ['handle', 'HANDLE', null], // unphased, fine
      ],
    );
    const report = evaluateProcessHealth(
      proc,
      makeSnapshot({
        milestones: [
          { code: 'APPROVAL', name: 'Approval' },
          { code: 'SHIPMENT', name: 'Shipment' },
        ],
        taskDefs: [
          td('APPROVE', 'APPROVAL'),
          td('SHIP', 'SHIPMENT'),
          td('HANDLE', null),
        ],
        publishedFormCodes: new Set(['F']),
      }),
    );

    expect(report.ok).toBe(true);
    expect(report.findings.every((f) => f.severity === 'ok')).toBe(true);
  });
});

describe('formatDoctorReport', () => {
  it('renders one icon-prefixed line per finding', () => {
    const report: DoctorReport = {
      ok: false,
      findings: [
        { severity: 'ok', check: 'process', detail: "'Loan' found" },
        { severity: 'warn', check: 'plan', detail: 'drift' },
        { severity: 'error', check: 'form:F', detail: 'not published' },
      ],
    };
    const out = formatDoctorReport(report);
    expect(out).toContain('✓');
    expect(out).toContain('⚠');
    expect(out).toContain('✗');
    expect(out.split('\n')).toHaveLength(4); // header + 3 findings
  });
});
