import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { Case } from '../../src/entities/case.entity.js';
import { ProcessDefinition } from '../../src/entities/process-definition.entity.js';
import { FormDefinition } from '../../src/entities/form-definition.entity.js';
import { TaskDefinition } from '../../src/entities/task-definition.entity.js';
import { FormDefinitionStatus, Priority } from '../../src/common/enums.js';
import { Permissions } from '../../src/common/permissions.js';
import { createTestUser, loginAs, authed, cleanupTestData } from './helpers.js';

let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  const user = await createTestUser(app, {
    permissions: [
      Permissions.TASKS_READ,
      Permissions.TASKS_WRITE,
      Permissions.TASKS_MANAGE,
      Permissions.PROCESSES_WRITE,
    ],
  });
  cookie = await loginAs(app, user.email);
});

afterAll(async () => {
  await cleanupTestData(app);
  await app.close();
});

// A process with a 3-phase plan and one task definition per phase
// (plus one deliberately unphased exception task definition).
async function createPlannedProcess() {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const db = app.db;

  const form = await db.getRepository(FormDefinition).save({
    code: `MS_FORM_${tag}`,
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: { DECISION: { type: 'string', enum: ['APPROVED', 'REJECTED'] } },
      required: ['DECISION'],
    },
    uiSchema: { type: 'VerticalLayout', elements: [{ type: 'Control', scope: '#/properties/DECISION' }] },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const process = await db.getRepository(ProcessDefinition).save({
    name: `Milestone Process ${tag}`,
    milestones: [
      { code: 'REVIEW', name: 'Review' },
      { code: 'ASSESS', name: 'Assess' },
      { code: 'DECIDE', name: 'Decide' },
    ],
  });

  const defs: Record<string, TaskDefinition> = {};
  for (const [code, milestoneCode] of [
    [`MS_REVIEW_${tag}`, 'REVIEW'],
    [`MS_ASSESS_${tag}`, 'ASSESS'],
    [`MS_DECIDE_${tag}`, 'DECIDE'],
    [`MS_EXCEPTION_${tag}`, null],
  ] as const) {
    defs[milestoneCode ?? 'EXCEPTION'] = await db.getRepository(TaskDefinition).save({
      code,
      processDefinitionId: process.id,
      formDefinitionCode: form.code,
      milestoneCode,
      candidateGroups: [],
      candidateUsers: [],
      defaultPriority: Priority.NORMAL,
    });
  }

  return { process, defs, tag };
}

async function createTaskFor(defId: string, pid: string) {
  const res = await authed(app, cookie, {
    method: 'POST',
    url: '/tasks',
    payload: {
      taskDefinitionId: defId,
      workflowId: `wf-${pid}`,
      processInstanceId: pid,
    },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body);
}

async function claimAndComplete(taskId: string) {
  const claim = await authed(app, cookie, { method: 'POST', url: `/tasks/${taskId}/claim` });
  expect(claim.statusCode).toBe(200);
  const complete = await authed(app, cookie, {
    method: 'POST',
    url: `/tasks/${taskId}/complete`,
    payload: { data: { DECISION: 'APPROVED' } },
  });
  expect(complete.statusCode).toBe(200);
}

async function getCaseDetail(pid: string) {
  const c = await app.db.getRepository(Case).findOne({ where: { processInstanceId: pid } });
  expect(c).toBeTruthy();
  const res = await authed(app, cookie, { method: 'GET', url: `/cases/${c!.id}` });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
}

describe('Case milestone projection', () => {
  it('computes active/pending from open tasks and includes name + code', async () => {
    const { defs, tag } = await createPlannedProcess();
    const pid = `ms-pid-${tag}-a`;
    await createTaskFor(defs.REVIEW.id, pid);

    const detail = await getCaseDetail(pid);
    expect(detail.milestones).toEqual([
      { code: 'REVIEW', name: 'Review', state: 'active' },
      { code: 'ASSESS', name: 'Assess', state: 'pending' },
      { code: 'DECIDE', name: 'Decide', state: 'pending' },
    ]);
  });

  it('achieves earlier phases (including zero-task ones) when a later phase opens', async () => {
    const { defs, tag } = await createPlannedProcess();
    const pid = `ms-pid-${tag}-b`;
    const review = await createTaskFor(defs.REVIEW.id, pid);
    await claimAndComplete(review.id);
    // Skip ASSESS entirely (an automated phase) — open DECIDE directly
    await createTaskFor(defs.DECIDE.id, pid);

    const detail = await getCaseDetail(pid);
    expect(detail.milestones.map((m: { state: string }) => m.state)).toEqual([
      'achieved',
      'achieved',
      'active',
    ]);
  });

  it('marks unreached phases skipped when the case closes early', async () => {
    const { defs, tag } = await createPlannedProcess();
    const pid = `ms-pid-${tag}-c`;
    const review = await createTaskFor(defs.REVIEW.id, pid);
    await claimAndComplete(review.id); // case now completed (all tasks terminal)

    const detail = await getCaseDetail(pid);
    expect(detail.status).toBe('completed');
    expect(detail.milestones.map((m: { state: string }) => m.state)).toEqual([
      'achieved',
      'skipped',
      'skipped',
    ]);
  });

  it('ignores unphased tasks and exposes milestoneCode on case tasks', async () => {
    const { defs, tag } = await createPlannedProcess();
    const pid = `ms-pid-${tag}-d`;
    await createTaskFor(defs.REVIEW.id, pid);
    await createTaskFor(defs.EXCEPTION.id, pid);

    const detail = await getCaseDetail(pid);
    expect(detail.milestones.map((m: { state: string }) => m.state)).toEqual([
      'active',
      'pending',
      'pending',
    ]);
    const codes = detail.tasks.map((t: { taskDefinition?: { milestoneCode: string | null } }) =>
      t.taskDefinition?.milestoneCode ?? null,
    );
    expect(codes).toEqual(['REVIEW', null]);
  });

  it('returns milestones: null for processes without a plan', async () => {
    const db = app.db;
    const tag = `${Date.now()}-planless`;
    const form = await db.getRepository(FormDefinition).save({
      code: `MS_NOPLAN_FORM_${tag}`,
      version: 1,
      jsonSchema: { type: 'object', properties: {} },
      uiSchema: { type: 'VerticalLayout', elements: [] },
      status: FormDefinitionStatus.PUBLISHED,
    });
    const proc = await db.getRepository(ProcessDefinition).save({ name: `No Plan ${tag}` });
    const def = await db.getRepository(TaskDefinition).save({
      code: `MS_NOPLAN_${tag}`,
      processDefinitionId: proc.id,
      formDefinitionCode: form.code,
      candidateGroups: [],
      candidateUsers: [],
      defaultPriority: Priority.NORMAL,
    });
    const pid = `ms-pid-${tag}`;
    await createTaskFor(def.id, pid);

    const detail = await getCaseDetail(pid);
    expect(detail.milestones).toBeNull();
  });
});

describe('Milestone write validation', () => {
  it('accepts milestones on POST /processes and milestoneCode on task definitions', async () => {
    const tag = `${Date.now()}-w`;
    const created = await authed(app, cookie, {
      method: 'POST',
      url: '/processes',
      payload: {
        name: `Plan Write ${tag}`,
        milestones: [{ code: 'A', name: 'Phase A' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const proc = JSON.parse(created.body);
    expect(proc.milestones).toEqual([{ code: 'A', name: 'Phase A' }]);

    const td = await authed(app, cookie, {
      method: 'POST',
      url: `/processes/${proc.id}/tasks`,
      payload: { code: `PW_TASK_${tag}`, formDefinitionCode: 'whatever', milestoneCode: 'A' },
    });
    expect(td.statusCode).toBe(201);
    expect(JSON.parse(td.body).milestoneCode).toBe('A');
  });

  it('rejects a task definition referencing a milestone not in the plan (422)', async () => {
    const tag = `${Date.now()}-x`;
    const created = await authed(app, cookie, {
      method: 'POST',
      url: '/processes',
      payload: { name: `Plan Reject ${tag}`, milestones: [{ code: 'A', name: 'Phase A' }] },
    });
    const proc = JSON.parse(created.body);

    const td = await authed(app, cookie, {
      method: 'POST',
      url: `/processes/${proc.id}/tasks`,
      payload: { code: `PR_TASK_${tag}`, formDefinitionCode: 'whatever', milestoneCode: 'NOPE' },
    });
    expect(td.statusCode).toBe(422);
    expect(JSON.parse(td.body).error).toContain("Unknown milestone code 'NOPE'");
  });

  it('rejects duplicate milestone codes in a plan (400)', async () => {
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/processes',
      payload: {
        name: `Plan Dup ${Date.now()}`,
        milestones: [
          { code: 'A', name: 'One' },
          { code: 'A', name: 'Two' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('validates milestoneCode on PATCH /task-definitions/:id', async () => {
    const { defs } = await createPlannedProcess();
    const ok = await authed(app, cookie, {
      method: 'PATCH',
      url: `/task-definitions/${defs.REVIEW.id}`,
      payload: { milestoneCode: 'DECIDE' },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).milestoneCode).toBe('DECIDE');

    const bad = await authed(app, cookie, {
      method: 'PATCH',
      url: `/task-definitions/${defs.REVIEW.id}`,
      payload: { milestoneCode: 'NOT_A_PHASE' },
    });
    expect(bad.statusCode).toBe(422);

    const cleared = await authed(app, cookie, {
      method: 'PATCH',
      url: `/task-definitions/${defs.REVIEW.id}`,
      payload: { milestoneCode: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(JSON.parse(cleared.body).milestoneCode).toBeNull();
  });
});
