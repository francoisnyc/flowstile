import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { In } from 'typeorm';
import { Case } from '../entities/case.entity.js';
import { CaseComment } from '../entities/case-comment.entity.js';
import { CaseEvent } from '../entities/case-event.entity.js';
import { Task } from '../entities/task.entity.js';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { Attachment } from '../entities/attachment.entity.js';
import { ProcessDefinition } from '../entities/process-definition.entity.js';
import { AttachmentStatus, CaseEventActor } from '../common/enums.js';
import { requirePermission, requireUser } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { PaginationQuery, paginate } from '../common/pagination.js';
import { filterFormSchemas } from '../common/visibility.js';
import { toReference } from '../common/attachments.js';
import { deriveCaseStatus, type CaseStatus } from '../common/cases.js';
import { deriveMilestoneStates, type Milestone } from '../common/milestones.js';
import { validateAgainstSchema } from '../validation/schema-validator.js';
import { applyJsonPatch, JsonPatchError, type JsonPatchOperation } from '../common/json-patch.js';
import { canSeeCase, principalSeesAllCases } from '../common/task-scope.js';
import type { AuthPrincipal } from '../plugins/auth.js';

const UuidParam = z.object({ id: z.string().uuid() });
const PidParam = z.object({ processInstanceId: z.string().min(1) });

const CasesQuery = PaginationQuery.extend({
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
});

const JsonPatchOp = z.object({
  op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
  path: z.string(),
  value: z.unknown().optional(),
  from: z.string().optional(),
});

const PatchCaseEntityBody = z.object({
  // Bounded so one request can't queue an unreasonable number of ops (each is
  // applied over a fresh structuredClone of the entity).
  patch: z.array(JsonPatchOp).min(1).max(100),
  // Optimistic concurrency: reject with 409 if the stored version differs.
  expectedVersion: z.number().int().nonnegative().optional(),
});

const PutCaseEntityBody = z.object({
  entity: z.record(z.string(), z.unknown()),
  expectedVersion: z.number().int().nonnegative().optional(),
});

const CommentBody = z.object({
  body: z.string().min(1).max(2000),
});

const RecordEventBody = z.object({
  actor: z.enum(['human', 'system', 'agent']),
  label: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  phase: z.string().min(1).max(100).nullable().optional(),
});

function serializeCaseTask(task: Task) {
  return {
    id: task.id,
    name: task.name ?? null,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt ?? null,
    taskDefinition: task.taskDefinition
      ? {
          id: task.taskDefinition.id,
          code: task.taskDefinition.code,
          formDefinitionCode: task.taskDefinition.formDefinitionCode,
          milestoneCode: task.taskDefinition.milestoneCode ?? null,
        }
      : undefined,
    assignee: task.assignee
      ? { id: task.assignee.id, email: task.assignee.email, displayName: task.assignee.displayName }
      : null,
  };
}

function serializeCaseSummary(
  c: Case,
  tasks: Task[],
  processName: string | null,
  status: CaseStatus,
) {
  const openTaskCount = tasks.filter(
    (t) => t.status === 'created' || t.status === 'claimed',
  ).length;
  return {
    id: c.id,
    processInstanceId: c.processInstanceId,
    processDefinitionName: processName,
    title: c.title,
    entity: c.entity,
    entityVersion: c.entityVersion,
    status,
    startedById: c.startedById,
    createdAt: c.createdAt,
    taskCount: tasks.length,
    openTaskCount,
  };
}

async function loadCaseDetail(
  app: { db: { getRepository: (...args: any[]) => any } },
  c: Case,
  processMeta: { name: string | null; milestones: Milestone[] | null },
  userRoleNames: string[],
  userGroupNames: string[],
  principal: AuthPrincipal,
) {
  const tasks = await app.db
    .getRepository(Task)
    .find({
      where: { processInstanceId: c.processInstanceId },
      relations: ['taskDefinition', 'assignee'],
      order: { createdAt: 'ASC' },
    });

  // Need-to-know: visible only to those involved in the case (started it or can
  // see one of its tasks) or holding oversight. null → handler returns 404.
  if (!canSeeCase(c.startedById, tasks, principal)) return null;

  const status = deriveCaseStatus(tasks);

  // Read-time projection of the case plan — no stored milestone state.
  const milestones = processMeta.milestones?.length
    ? deriveMilestoneStates(
        processMeta.milestones,
        tasks.map((task: Task) => ({
          status: task.status,
          milestoneCode: task.taskDefinition?.milestoneCode ?? null,
        })),
        status,
      )
    : null;

  // Visibility-filtered attachments for the case
  const allAttachments = await app.db
    .getRepository(Attachment)
    .find({ where: { processInstanceId: c.processInstanceId, status: AttachmentStatus.LINKED } });

  const visibleAttachments = await filterAttachmentsByVisibility(
    app,
    allAttachments,
    tasks,
    userRoleNames,
    userGroupNames,
  );

  const commentCount = await app.db
    .getRepository(CaseComment)
    .count({ where: { caseId: c.id } });

  // Display-only timeline of automated/agent/system events recorded against the
  // case. Visible to anyone who can see the case (case-level scope already
  // enforced above); payloads are curated by the author at write time.
  const events = await app.db
    .getRepository(CaseEvent)
    .find({ where: { caseId: c.id }, order: { recordedAt: 'ASC' } });

  return {
    id: c.id,
    processInstanceId: c.processInstanceId,
    processDefinitionName: processMeta.name,
    title: c.title,
    entity: c.entity,
    entityVersion: c.entityVersion,
    status,
    startedById: c.startedById,
    createdAt: c.createdAt,
    milestones,
    tasks: tasks.map(serializeCaseTask),
    attachments: visibleAttachments,
    commentCount,
    events: events.map(serializeCaseEvent),
  };
}

function serializeCaseEvent(e: CaseEvent) {
  return {
    id: e.id,
    actor: e.actor,
    label: e.label,
    payload: e.payload,
    phase: e.phase,
    recordedAt: e.recordedAt,
  };
}

// Filters LINKED attachments to only those whose fieldKey is visible to the caller
// in the task's form at the locked form version.
async function filterAttachmentsByVisibility(
  app: { db: { getRepository: (...args: any[]) => any } },
  attachments: Attachment[],
  tasks: Task[],
  userRoleNames: string[],
  userGroupNames: string[],
) {
  if (attachments.length === 0) return [];

  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Load form definitions for all unique (formCode, version) pairs
  const formKeys = new Map<string, { code: string; version: number }>();
  for (const task of tasks) {
    // Ad-hoc tasks (inline form, no locked version) have no field-visibility
    // rules to apply, so skip them — their attachments are unfiltered.
    if (!task.taskDefinition || task.formDefinitionVersion === null) continue;
    const key = `${task.taskDefinition.formDefinitionCode}@${task.formDefinitionVersion}`;
    formKeys.set(key, {
      code: task.taskDefinition.formDefinitionCode,
      version: task.formDefinitionVersion,
    });
  }

  const forms = await Promise.all(
    [...formKeys.values()].map(({ code, version }) =>
      app.db
        .getRepository(FormDefinition)
        .findOne({ where: { code, version } }),
    ),
  );

  const formByKey = new Map<string, FormDefinition>();
  for (const form of forms) {
    if (!form) continue;
    formByKey.set(`${form.code}@${form.version}`, form);
  }

  // Compute visible field sets per task
  const visibleFieldsByTask = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!task.taskDefinition) continue;
    const key = `${task.taskDefinition.formDefinitionCode}@${task.formDefinitionVersion}`;
    const form = formByKey.get(key);
    if (!form) continue;
    const { jsonSchema } = filterFormSchemas(form, userRoleNames, userGroupNames);
    const visible = new Set(Object.keys((jsonSchema.properties ?? {}) as Record<string, unknown>));
    visibleFieldsByTask.set(task.id, visible);
  }

  return attachments
    .filter((att) => {
      if (!att.taskId || !att.fieldKey) return false;
      return visibleFieldsByTask.get(att.taskId)?.has(att.fieldKey) ?? false;
    })
    .map((att) => ({
      ...toReference(att),
      // The owning task + field, so the case view can build a download URL
      // (/tasks/:taskId/attachments/:id/content) and group documents by field.
      taskId: att.taskId,
      fieldKey: att.fieldKey,
    }));
}

export const caseRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: [requirePermission(Permissions.TASKS_READ)] };
  const write = { preHandler: [requirePermission(Permissions.TASKS_WRITE)] };

  const caseRepo = () => app.db.getRepository(Case);
  const commentRepo = () => app.db.getRepository(CaseComment);

  function serializeComment(c: CaseComment) {
    return {
      id: c.id,
      caseId: c.caseId,
      author: {
        id: c.author.id,
        email: c.author.email,
        displayName: c.author.displayName,
      },
      body: c.body,
      createdAt: c.createdAt,
    };
  }

  async function resolveProcessMeta(
    processDefinitionId: string | null,
  ): Promise<{ name: string | null; milestones: Milestone[] | null }> {
    if (!processDefinitionId) return { name: null, milestones: null };
    const pd = await app.db
      .getRepository(ProcessDefinition)
      .findOne({ where: { id: processDefinitionId }, select: ['id', 'name', 'milestones'] });
    return { name: pd?.name ?? null, milestones: pd?.milestones ?? null };
  }

  // GET /cases
  app.get('/cases', { ...read, schema: { querystring: CasesQuery, tags: ['Cases'] } }, async (request) => {
    const { status: statusFilter, limit, offset } = request.query;
    const principal = request.principal!;

    const [allCases] = await caseRepo().findAndCount({
      order: { createdAt: 'DESC' },
    });

    // Batch-load tasks for all cases in one query (needed for involvement scoping)
    const processInstanceIds = allCases.map((c) => c.processInstanceId);
    const allTasks =
      processInstanceIds.length > 0
        ? await app.db
            .getRepository(Task)
            .find({ where: { processInstanceId: In(processInstanceIds) } })
        : [];

    const tasksByPid = new Map<string, Task[]>();
    for (const t of allTasks) {
      if (!t.processInstanceId) continue;
      const bucket = tasksByPid.get(t.processInstanceId) ?? [];
      bucket.push(t);
      tasksByPid.set(t.processInstanceId, bucket);
    }

    // Batch-load process definition names
    const pdIds = [...new Set(allCases.map((c) => c.processDefinitionId).filter(Boolean))] as string[];
    const processDefs =
      pdIds.length > 0
        ? await app.db.getRepository(ProcessDefinition).findBy({ id: In(pdIds) })
        : [];
    const pdNameById = new Map(processDefs.map((p) => [p.id, p.name]));

    // Need-to-know: each case is visible only to those involved or holding oversight.
    let items = allCases
      .filter((c) => {
        const tasks = tasksByPid.get(c.processInstanceId) ?? [];
        return canSeeCase(c.startedById, tasks, principal);
      })
      .map((c) => {
        const tasks = tasksByPid.get(c.processInstanceId) ?? [];
        const status = deriveCaseStatus(tasks);
        const processName = c.processDefinitionId ? (pdNameById.get(c.processDefinitionId) ?? null) : null;
        return serializeCaseSummary(c, tasks, processName, status);
      });

    if (statusFilter) {
      items = items.filter((i) => i.status === statusFilter);
    }

    return paginate(items.slice(offset, offset + limit), items.length, limit, offset);
  });

  // GET /cases/by-process-instance/:processInstanceId  — must be before /cases/:id
  app.get(
    '/cases/by-process-instance/:processInstanceId',
    { ...read, schema: { params: PidParam, tags: ['Cases'] } },
    async (request, reply) => {
      const { processInstanceId } = request.params;
      const user = requireUser(request, reply);
      if (!user) return reply;

      const c = await caseRepo().findOne({ where: { processInstanceId } });
      if (!c) return reply.code(404).send({ error: 'Case not found' });

      const userRoleNames = user.roles.map((r) => r.name);
      const userGroupNames = user.groups.map((g) => g.name);
      const processMeta = await resolveProcessMeta(c.processDefinitionId);

      const detail = await loadCaseDetail(app, c, processMeta, userRoleNames, userGroupNames, request.principal!);
      if (!detail) return reply.code(404).send({ error: 'Case not found' });
      return detail;
    },
  );

  // GET /cases/:id
  app.get(
    '/cases/:id',
    { ...read, schema: { params: UuidParam, tags: ['Cases'] } },
    async (request, reply) => {
      const { id } = request.params;
      const user = requireUser(request, reply);
      if (!user) return reply;

      const c = await caseRepo().findOne({ where: { id } });
      if (!c) return reply.code(404).send({ error: 'Case not found' });

      const userRoleNames = user.roles.map((r) => r.name);
      const userGroupNames = user.groups.map((g) => g.name);
      const processMeta = await resolveProcessMeta(c.processDefinitionId);

      const detail = await loadCaseDetail(app, c, processMeta, userRoleNames, userGroupNames, request.principal!);
      if (!detail) return reply.code(404).send({ error: 'Case not found' });
      return detail;
    },
  );

  // Loads the caseEntitySchema for a process definition, if one is configured.
  async function resolveCaseEntitySchema(
    processDefinitionId: string | null,
  ): Promise<Record<string, unknown> | null> {
    if (!processDefinitionId) return null;
    const pd = await app.db
      .getRepository(ProcessDefinition)
      .findOne({ where: { id: processDefinitionId }, select: ['id', 'caseEntitySchema'] });
    return pd?.caseEntitySchema ?? null;
  }

  // GET /cases/by-process-instance/:processInstanceId/entity  — read-back
  app.get(
    '/cases/by-process-instance/:processInstanceId/entity',
    { ...read, schema: { params: PidParam, tags: ['Cases'] } },
    async (request, reply) => {
      const { processInstanceId } = request.params;
      const c = await caseRepo().findOne({ where: { processInstanceId } });
      if (!c) return reply.code(404).send({ error: 'Case not found' });

      if (!principalSeesAllCases(request.principal!)) {
        const tasks = await app.db.getRepository(Task).find({ where: { processInstanceId } });
        if (!canSeeCase(c.startedById, tasks, request.principal!)) {
          return reply.code(404).send({ error: 'Case not found' });
        }
      }

      return { entity: c.entity, entityVersion: c.entityVersion };
    },
  );

  // Persists a new entity value for a case under a row lock, validating against
  // the process's caseEntitySchema and bumping entityVersion. `compute` derives
  // the next entity from the current one (or throws for a bad patch).
  async function writeEntity(
    processInstanceId: string,
    expectedVersion: number | undefined,
    compute: (current: Record<string, unknown>) => Record<string, unknown>,
    reply: import('fastify').FastifyReply,
  ) {
    const outcome = await app.db.transaction(async (manager) => {
      const repo = manager.getRepository(Case);
      const c = await repo.findOne({
        where: { processInstanceId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!c) return { kind: 'not_found' as const };

      if (expectedVersion !== undefined && c.entityVersion !== expectedVersion) {
        return { kind: 'conflict' as const, current: c.entityVersion };
      }

      let next: Record<string, unknown>;
      try {
        next = compute((c.entity ?? {}) as Record<string, unknown>);
      } catch (err) {
        if (err instanceof JsonPatchError) return { kind: 'patch_error' as const, message: err.message };
        throw err;
      }

      const schema = await resolveCaseEntitySchema(c.processDefinitionId);
      if (schema) {
        const validation = validateAgainstSchema(next, schema);
        if (!validation.valid) {
          return { kind: 'invalid' as const, errors: validation.errors };
        }
      }

      c.entity = next;
      c.entityVersion += 1;
      const saved = await repo.save(c);
      return { kind: 'ok' as const, entity: saved.entity, entityVersion: saved.entityVersion };
    });

    switch (outcome.kind) {
      case 'not_found':
        return reply.code(404).send({ error: 'Case not found' });
      case 'conflict':
        return reply
          .code(409)
          .send({ error: 'Case entity version conflict', currentVersion: outcome.current });
      case 'patch_error':
        return reply.code(422).send({ error: 'Invalid JSON Patch', details: outcome.message });
      case 'invalid':
        return reply
          .code(422)
          .send({ error: 'Case entity validation failed', details: outcome.errors });
      case 'ok':
        return { entity: outcome.entity, entityVersion: outcome.entityVersion };
    }
  }

  // PATCH /cases/by-process-instance/:processInstanceId/entity  — JSON Patch
  app.patch(
    '/cases/by-process-instance/:processInstanceId/entity',
    { ...write, schema: { params: PidParam, body: PatchCaseEntityBody, tags: ['Cases'] } },
    async (request, reply) => {
      const { processInstanceId } = request.params;
      const { patch, expectedVersion } = request.body;

      if (!principalSeesAllCases(request.principal!)) {
        const c = await caseRepo().findOne({ where: { processInstanceId } });
        if (!c) return reply.code(404).send({ error: 'Case not found' });
        const tasks = await app.db.getRepository(Task).find({ where: { processInstanceId } });
        if (!canSeeCase(c.startedById, tasks, request.principal!)) {
          return reply.code(404).send({ error: 'Case not found' });
        }
      }

      return writeEntity(
        processInstanceId,
        expectedVersion,
        (current) => applyJsonPatch(current, patch as JsonPatchOperation[]),
        reply,
      );
    },
  );

  // PUT /cases/by-process-instance/:processInstanceId/entity  — full replace
  app.put(
    '/cases/by-process-instance/:processInstanceId/entity',
    { ...write, schema: { params: PidParam, body: PutCaseEntityBody, tags: ['Cases'] } },
    async (request, reply) => {
      const { processInstanceId } = request.params;
      const { entity, expectedVersion } = request.body;

      if (!principalSeesAllCases(request.principal!)) {
        const c = await caseRepo().findOne({ where: { processInstanceId } });
        if (!c) return reply.code(404).send({ error: 'Case not found' });
        const tasks = await app.db.getRepository(Task).find({ where: { processInstanceId } });
        if (!canSeeCase(c.startedById, tasks, request.principal!)) {
          return reply.code(404).send({ error: 'Case not found' });
        }
      }

      return writeEntity(processInstanceId, expectedVersion, () => entity, reply);
    },
  );

  // GET /cases/:id/comments
  app.get(
    '/cases/:id/comments',
    { ...read, schema: { params: UuidParam, tags: ['Cases'] } },
    async (request, reply) => {
      const { id } = request.params;
      const user = requireUser(request, reply);
      if (!user) return reply;

      const c = await caseRepo().findOne({ where: { id } });
      if (!c) return reply.code(404).send({ error: 'Case not found' });

      // Need-to-know visibility check
      const tasks = await app.db.getRepository(Task).find({
        where: { processInstanceId: c.processInstanceId },
      });
      if (!canSeeCase(c.startedById, tasks, request.principal!)) {
        return reply.code(404).send({ error: 'Case not found' });
      }

      const comments = await commentRepo().find({
        where: { caseId: id },
        order: { createdAt: 'ASC' },
      });

      return { items: comments.map(serializeComment) };
    },
  );

  // POST /cases/:id/comments
  app.post(
    '/cases/:id/comments',
    {
      preHandler: [requirePermission(Permissions.TASKS_READ), requirePermission(Permissions.TASKS_WRITE)],
      schema: { params: UuidParam, body: CommentBody, tags: ['Cases'] },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { body } = request.body;
      const user = requireUser(request, reply);
      if (!user) return reply;

      const c = await caseRepo().findOne({ where: { id } });
      if (!c) return reply.code(404).send({ error: 'Case not found' });

      // Need-to-know visibility check
      const tasks = await app.db.getRepository(Task).find({
        where: { processInstanceId: c.processInstanceId },
      });
      if (!canSeeCase(c.startedById, tasks, request.principal!)) {
        return reply.code(404).send({ error: 'Case not found' });
      }

      const comment = await commentRepo().save({
        caseId: id,
        authorId: user.id,
        body,
      });

      // Reload with author relation (eager on entity, but save doesn't hydrate)
      const saved = await commentRepo().findOneOrFail({ where: { id: comment.id } });

      return reply.code(201).send(serializeComment(saved));
    },
  );

  // POST /cases/by-process-instance/:processInstanceId/events — record a
  // display-only timeline event (system/agent/automated work). Written by the
  // worker (service credential) with tasks:write; appears on the case timeline.
  app.post(
    '/cases/by-process-instance/:processInstanceId/events',
    { ...write, schema: { params: PidParam, body: RecordEventBody, tags: ['Cases'] } },
    async (request, reply) => {
      const { processInstanceId } = request.params;
      const { actor, label, payload, phase } = request.body;

      let c = await caseRepo().findOne({ where: { processInstanceId } });
      if (!c) {
        // An event can be the first thing recorded for an instance — e.g. an
        // agent step before any human task. Materialize the case (the process is
        // backfilled when the first task is created).
        try {
          c = await caseRepo().save({ processInstanceId, processDefinitionId: null, entity: null });
        } catch {
          c = await caseRepo().findOne({ where: { processInstanceId } });
        }
        if (!c) return reply.code(404).send({ error: 'Case not found' });
      } else if (!principalSeesAllCases(request.principal!)) {
        const tasks = await app.db.getRepository(Task).find({ where: { processInstanceId } });
        if (!canSeeCase(c.startedById, tasks, request.principal!)) {
          return reply.code(404).send({ error: 'Case not found' });
        }
      }

      const event = await app.db.getRepository(CaseEvent).save({
        caseId: c.id,
        actor: actor as CaseEventActor,
        label,
        payload: payload ?? null,
        phase: phase ?? null,
      });

      return reply.code(201).send(serializeCaseEvent(event));
    },
  );
};
