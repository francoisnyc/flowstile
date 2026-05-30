import { z } from 'zod';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Task } from '../entities/task.entity.js';
import { TaskDefinition } from '../entities/task-definition.entity.js';
import { FormDefinition, DEFAULT_OUTCOME_KEY } from '../entities/form-definition.entity.js';
import { TaskStatus, FormDefinitionStatus, Priority, SignalStatus } from '../common/enums.js';
import { TaskStateMachine, InvalidTransitionError } from '../common/task-state-machine.js';
import { filterFormSchemas, filterSubmissionData, getWritableFields } from '../common/visibility.js';
import { requirePermission, requireUser } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { PaginationQuery, paginate } from '../common/pagination.js';
import { validateAgainstSchema, validateInputData } from '../validation/schema-validator.js';
import {
  enqueueSignal,
  reenqueueForTask,
  buildCompletedPayload,
  completedSignalName,
  cancelledSignalName,
} from '../signals/outbox.js';
import { validateAndCollectReferences } from '../common/attachments.js';
import { Attachment } from '../entities/attachment.entity.js';
import { AttachmentStatus } from '../common/enums.js';
import { In } from 'typeorm';
import { Case } from '../entities/case.entity.js';
import { extractScalarVariables } from '../common/cases.js';

function serializeTask(task: Task) {
  return {
    id: task.id,
    formDefinitionVersion: task.formDefinitionVersion,
    workflowId: task.workflowId,
    processInstanceId: task.processInstanceId ?? null,
    status: task.status,
    priority: task.priority,
    dueDate: task.dueDate ?? null,
    followUpDate: task.followUpDate ?? null,
    inputData: task.inputData,
    contextData: task.contextData,
    submissionData: task.submissionData,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt ?? null,
    signalStatus: task.signalStatus ?? null,
    signalDeliveredAt: task.signalDeliveredAt ?? null,
    signalFailedAt: task.signalFailedAt ?? null,
    taskDefinition: task.taskDefinition ? {
      id: task.taskDefinition.id,
      code: task.taskDefinition.code,
      formDefinitionCode: task.taskDefinition.formDefinitionCode,
      candidateGroups: task.taskDefinition.candidateGroups,
      candidateUsers: task.taskDefinition.candidateUsers,
      defaultPriority: task.taskDefinition.defaultPriority,
    } : undefined,
    assigneeId: task.assignee?.id ?? task.assigneeId ?? null,
    assignee: task.assignee ? {
      id: task.assignee.id,
      email: task.assignee.email,
      displayName: task.assignee.displayName,
    } : null,
  };
}

const UuidParam = z.object({ id: z.string().uuid() });

const TasksQuery = PaginationQuery.extend({
  status: z.nativeEnum(TaskStatus).optional(),
  assigneeId: z.string().uuid().optional(),
  group: z.string().optional(),
  signalStatus: z.nativeEnum(SignalStatus).optional(),
});

const CreateTaskBody = z.object({
  taskDefinitionId: z.string().uuid(),
  workflowId: z.string().min(1),
  processInstanceId: z.string().min(1).optional(),
  priority: z.nativeEnum(Priority).optional(),
  dueDate: z.coerce.date().optional(),
  followUpDate: z.coerce.date().optional(),
  inputData: z.record(z.string(), z.unknown()).optional(),
  contextData: z.record(z.string(), z.unknown()).optional(),
  submissionData: z.record(z.string(), z.unknown()).optional(),
});

const CompleteTaskBody = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
});

const VariableFilter = z.object({
  name: z.string().min(1),
  operator: z.enum(['eq', 'like']).default('eq'),
  value: z.union([z.string(), z.number(), z.boolean()]),
}).refine(
  (f) => f.operator !== 'like' || (typeof f.value === 'string' && f.value.includes('%')),
  { message: 'like operator requires a string value containing at least one % wildcard' },
);

const SearchTasksBody = z.object({
  status: z.nativeEnum(TaskStatus).optional(),
  assigneeId: z.string().uuid().optional(),
  group: z.string().optional(),
  signalStatus: z.nativeEnum(SignalStatus).optional(),
  inputVariables: z.array(VariableFilter).optional(),
  contextVariables: z.array(VariableFilter).optional(),
  submissionVariables: z.array(VariableFilter).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
}).refine(
  (body) => {
    const total = (body.inputVariables?.length ?? 0)
      + (body.contextVariables?.length ?? 0)
      + (body.submissionVariables?.length ?? 0);
    return total <= 10;
  },
  { message: 'Maximum 10 variable filters total across all scopes' },
);

type VariableFilterInput = { name: string; operator: 'eq' | 'like'; value: string | number | boolean };

// The only column names ever interpolated into the variable-search SQL.
// Sourced exclusively from this allowlist — never from the request — so the
// `t."${column}"` interpolation below carries no injection risk.
const SEARCHABLE_COLUMNS = {
  input: 'inputData',
  context: 'contextData',
  submission: 'submissionData',
} as const;

type SearchableColumn = (typeof SEARCHABLE_COLUMNS)[keyof typeof SEARCHABLE_COLUMNS];

// Shared scaffolding for both GET /tasks and POST /tasks/search: the same joins,
// ordering, and metadata filters. Keeps the two endpoints from drifting.
function baseTaskQuery(
  repo: Repository<Task>,
  filters: { status?: TaskStatus; assigneeId?: string; group?: string; signalStatus?: SignalStatus },
): SelectQueryBuilder<Task> {
  const qb = repo
    .createQueryBuilder('t')
    .leftJoinAndSelect('t.taskDefinition', 'td')
    .leftJoinAndSelect('t.assignee', 'a')
    .orderBy('t.createdAt', 'DESC');

  if (filters.status) qb.andWhere('t.status = :status', { status: filters.status });
  if (filters.assigneeId) qb.andWhere('t.assigneeId = :assigneeId', { assigneeId: filters.assigneeId });
  // Filter to tasks whose candidateGroups contains the given group name
  if (filters.group) qb.andWhere(':group = ANY(td.candidateGroups)', { group: filters.group });
  if (filters.signalStatus) qb.andWhere('t.signalStatus = :signalStatus', { signalStatus: filters.signalStatus });

  return qb;
}

// Returns true if the user is eligible to claim a task governed by the given definition.
// An empty candidateGroups+candidateUsers means open to anyone with tasks:write.
function isEligibleToClaim(
  user: { email: string; groups: { name: string }[] },
  td: { candidateGroups: string[]; candidateUsers: string[] },
): boolean {
  if (td.candidateGroups.length === 0 && td.candidateUsers.length === 0) return true;
  const userGroupNames = user.groups.map((g) => g.name);
  return td.candidateUsers.includes(user.email) || td.candidateGroups.some((g) => userGroupNames.includes(g));
}

function applyVariableFilters(
  qb: SelectQueryBuilder<Task>,
  column: SearchableColumn,
  filters: VariableFilterInput[] | undefined,
  counter: { n: number },
): void {
  if (!filters?.length) return;
  for (const filter of filters) {
    const idx = counter.n++;
    if (filter.operator === 'like') {
      // jsonb_extract_path_text cannot use the GIN index — falls back to seq scan.
      // Acceptable for low-frequency admin queries; add expression indexes for hot fields.
      // ILIKE is case-insensitive: users expect `alice%` to match `Alice`.
      qb.andWhere(
        `jsonb_extract_path_text(t."${column}", :vname_${idx}) ILIKE :vval_${idx}`,
        { [`vname_${idx}`]: filter.name, [`vval_${idx}`]: filter.value },
      );
    } else {
      const containment = JSON.stringify({ [filter.name]: filter.value });
      qb.andWhere(`t."${column}" @> :vval_${idx}::jsonb`, { [`vval_${idx}`]: containment });
    }
  }
}

export const taskRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: [requirePermission(Permissions.TASKS_READ)] };
  const write = { preHandler: [requirePermission(Permissions.TASKS_WRITE)] };
  const repo = () => app.db.getRepository(Task);

  const userHasPermission = (user: { roles: { permissions: string[] }[] }, perm: string) =>
    user.roles.some((r) => r.permissions.includes(perm));

  app.get('/tasks', { ...read, schema: { querystring: TasksQuery, tags: ['Tasks'] } }, async (request) => {
    const { status, assigneeId, group, signalStatus, limit, offset } = request.query;

    const qb = baseTaskQuery(repo(), { status, assigneeId, group, signalStatus }).limit(limit).offset(offset);

    const [items, total] = await qb.getManyAndCount();
    return paginate(items.map(serializeTask), total, limit, offset);
  });

  app.post('/tasks/search', { ...read, schema: { body: SearchTasksBody, tags: ['Tasks'] } }, async (request) => {
    const {
      status, assigneeId, group, signalStatus,
      inputVariables, contextVariables, submissionVariables,
      limit, offset,
    } = request.body;

    const qb = baseTaskQuery(repo(), { status, assigneeId, group, signalStatus }).limit(limit).offset(offset);

    const counter = { n: 0 };
    applyVariableFilters(qb, SEARCHABLE_COLUMNS.input, inputVariables, counter);
    applyVariableFilters(qb, SEARCHABLE_COLUMNS.context, contextVariables, counter);
    applyVariableFilters(qb, SEARCHABLE_COLUMNS.submission, submissionVariables, counter);

    const [items, total] = await qb.getManyAndCount();
    return paginate(items.map(serializeTask), total, limit, offset);
  });

  app.post('/tasks', { ...write, schema: { body: CreateTaskBody, tags: ['Tasks'] } }, async (request, reply) => {
    const {
      taskDefinitionId,
      workflowId,
      processInstanceId,
      priority,
      dueDate,
      followUpDate,
      inputData,
      contextData,
      submissionData,
    } = request.body;

    const td = await app.db.getRepository(TaskDefinition).findOne({
      where: { id: taskDefinitionId },
    });
    if (!td) return reply.code(404).send({ error: 'Task definition not found' });

    const form = await app.db.getRepository(FormDefinition).findOne({
      where: { code: td.formDefinitionCode, status: FormDefinitionStatus.PUBLISHED },
      order: { version: 'DESC' },
    });
    if (!form) {
      return reply.code(422).send({
        error: `No published form found for code '${td.formDefinitionCode}'`,
      });
    }

    // Validate inputData against the form's JSON Schema (lenient — no required enforcement)
    if (inputData && Object.keys(inputData).length > 0) {
      const validation = validateInputData(inputData, form.jsonSchema as Record<string, unknown>);
      if (!validation.valid) {
        return reply.code(422).send({
          error: 'inputData validation failed',
          details: validation.errors,
        });
      }
    }

    const task = await repo().save({
      taskDefinitionId,
      workflowId,
      ...(processInstanceId ? { processInstanceId } : {}),
      formDefinitionVersion: form.version,
      status: TaskStatus.CREATED,
      priority: priority ?? td.defaultPriority,
      dueDate: dueDate ?? null,
      followUpDate: followUpDate ?? null,
      inputData: inputData ?? {},
      contextData: contextData ?? {},
      submissionData: submissionData ?? {},
    });

    // Lazily upsert a Case row the first time a task is created for a workflow instance.
    // If two tasks race on the same processInstanceId the unique constraint causes one
    // insert to fail — safe to ignore.
    if (processInstanceId) {
      const caseRepo = app.db.getRepository(Case);
      const existing = await caseRepo.findOne({ where: { processInstanceId } });
      if (!existing) {
        try {
          await caseRepo.save({
            processInstanceId,
            processDefinitionId: td.processDefinitionId,
            variables: extractScalarVariables(inputData ?? {}),
          });
        } catch {
          // Concurrent insert on the unique key — the case row already exists.
        }
      }
    }

    return reply.code(201).send(serializeTask(task));
  });

  app.get(
    '/tasks/:id',
    { ...read, schema: { params: UuidParam, tags: ['Tasks'] } },
    async (request, reply) => {
      const { id } = request.params;
      const user = requireUser(request, reply);
      if (!user) return reply;

      const task = await repo().findOne({
        where: { id },
        relations: ['taskDefinition', 'assignee'],
      });
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      const form = await app.db.getRepository(FormDefinition).findOne({
        where: {
          code: task.taskDefinition.formDefinitionCode,
          version: task.formDefinitionVersion,
        },
      });
      if (!form) return reply.code(500).send({ error: 'Locked form version not found' });

      const userRoleNames = user.roles.map((r) => r.name);
      const userGroupNames = user.groups.map((g) => g.name);

      const { jsonSchema, uiSchema } = filterFormSchemas(form, userRoleNames, userGroupNames);
      const filteredData = filterSubmissionData(
        task.submissionData,
        form,
        userRoleNames,
        userGroupNames,
      );

      const hasWrite = userHasPermission(user, Permissions.TASKS_WRITE);
      const hasManage = userHasPermission(user, Permissions.TASKS_MANAGE);
      const isAssignee = task.assigneeId === user.id;

      const actions = {
        canClaim: hasWrite && TaskStateMachine.canTransition(task.status, 'claim') && isEligibleToClaim(user, task.taskDefinition),
        canUnclaim: TaskStateMachine.canTransition(task.status, 'unclaim') && (isAssignee || hasManage),
        canComplete: hasWrite && TaskStateMachine.canTransition(task.status, 'complete') && isAssignee,
        canCancel: hasWrite && TaskStateMachine.canTransition(task.status, 'cancel') && (task.status === 'created' || isAssignee || hasManage),
      };

      const hasOutcomes = Array.isArray(form.outcomes) && form.outcomes.length > 0;

      return {
        ...serializeTask(task),
        form: {
          code: form.code,
          version: form.version,
          jsonSchema,
          uiSchema,
          formMessages: form.formMessages,
          outcomes: hasOutcomes ? form.outcomes : null,
          outcomeKey: hasOutcomes ? (form.outcomeKey ?? DEFAULT_OUTCOME_KEY) : null,
        },
        submissionData: filteredData,
        actions,
      };
    },
  );

  app.post(
    '/tasks/:id/claim',
    { ...write, schema: { params: UuidParam, tags: ['Tasks'] } },
    async (request, reply) => {
      const { id } = request.params;
      const user = requireUser(request, reply);
      if (!user) return reply;

      const task = await repo().findOne({ where: { id }, relations: ['taskDefinition'] });
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      if (!isEligibleToClaim(user, task.taskDefinition)) {
        return reply.code(403).send({ error: 'You are not eligible to claim this task' });
      }

      try {
        task.status = TaskStateMachine.transition(task.status, 'claim');
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }

      task.assigneeId = user.id;
      await repo().save(task);
      return serializeTask(task);
    },
  );

  app.post(
    '/tasks/:id/unclaim',
    { ...write, schema: { params: UuidParam, tags: ['Tasks'] } },
    async (request, reply) => {
      const { id } = request.params;
      const user = requireUser(request, reply);
      if (!user) return reply;

      const task = await repo().findOne({ where: { id } });
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      try {
        task.status = TaskStateMachine.transition(task.status, 'unclaim');
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }

      if (task.assigneeId && task.assigneeId !== user.id && !userHasPermission(user, Permissions.TASKS_MANAGE)) {
        return reply.code(403).send({ error: 'Only the assignee or a manager can unclaim this task' });
      }

      task.assigneeId = null;
      await repo().save(task);
      return serializeTask(task);
    },
  );

  app.post(
    '/tasks/:id/complete',
    { ...write, schema: { params: UuidParam, body: CompleteTaskBody, tags: ['Tasks'] } },
    async (request, reply) => {
      const { id } = request.params;
      const { data } = request.body;

      const user = requireUser(request, reply);
      if (!user) return reply;

      const task = await repo().findOne({
        where: { id },
        relations: ['taskDefinition'],
      });
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      // Check state machine first — no point validating data for a non-completable task
      try {
        task.status = TaskStateMachine.transition(task.status, 'complete');
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }

      // Load the locked form version
      const form = await app.db.getRepository(FormDefinition).findOne({
        where: {
          code: task.taskDefinition.formDefinitionCode,
          version: task.formDefinitionVersion,
        },
      });

      // Strip non-writable fields from submitted data before merging
      let acceptedData = data ?? {};
      if (form) {
        const userRoleNames = user.roles.map((r) => r.name);
        const userGroupNames = user.groups.map((g) => g.name);
        const writableFields = getWritableFields(form, userRoleNames, userGroupNames);
        acceptedData = Object.fromEntries(
          Object.entries(acceptedData).filter(([key]) => writableFields.has(key)),
        );
      }

      // Merge existing stored data with accepted submitted fields
      const mergedSubmission = { ...task.submissionData, ...acceptedData };

      if (form) {
        const validation = validateAgainstSchema(
          mergedSubmission,
          form.jsonSchema as Record<string, unknown>,
        );
        if (!validation.valid) {
          return reply.code(422).send({
            error: 'submissionData validation failed',
            details: validation.errors,
          });
        }

        // If the form declares outcome buttons, enforce that the submitted
        // outcome value is one we recognise and that its requireFields are
        // present. Defense in depth — the schema enum covers the value too.
        if (Array.isArray(form.outcomes) && form.outcomes.length > 0) {
          const outcomeKey = form.outcomeKey ?? DEFAULT_OUTCOME_KEY;
          const chosen = mergedSubmission[outcomeKey];
          const outcome = form.outcomes.find((o) => o.value === chosen);
          if (!outcome) {
            return reply.code(422).send({
              error: 'submissionData validation failed',
              details: [{
                path: `/${outcomeKey}`,
                message: `must be one of the declared outcomes: ${form.outcomes.map((o) => o.value).join(', ')}`,
              }],
            });
          }
          const missing = (outcome.requireFields ?? []).filter((field) => {
            const v = mergedSubmission[field];
            return v === undefined || v === null || v === '';
          });
          if (missing.length > 0) {
            return reply.code(422).send({
              error: 'submissionData validation failed',
              details: missing.map((field) => ({
                path: `/${field}`,
                message: `required for outcome '${outcome.value}'`,
              })),
            });
          }
        }
      }

      // Validate and collect attachment references from the merged submission
      const ATTACHMENT_MAX_BYTES = parseInt(process.env.ATTACHMENT_MAX_BYTES ?? String(25 * 1024 * 1024), 10);
      let attachmentIdsToLink: string[] = [];
      if (form) {
        const refResult = validateAndCollectReferences(
          mergedSubmission,
          form.jsonSchema as Record<string, unknown>,
          { globalMaxBytes: ATTACHMENT_MAX_BYTES },
        );
        if (refResult.errors.length > 0) {
          return reply.code(422).send({
            error: 'submissionData validation failed',
            details: refResult.errors,
          });
        }
        attachmentIdsToLink = refResult.attachmentIds;
      }

      // Verify each referenced attachment is pending and belongs to this task
      if (attachmentIdsToLink.length > 0) {
        const atts = await app.db.getRepository(Attachment).find({ where: { id: In(attachmentIdsToLink) } });
        const attMap = new Map(atts.map((a) => [a.id, a]));
        for (const attId of attachmentIdsToLink) {
          const att = attMap.get(attId);
          if (!att || att.taskId !== id || att.status !== AttachmentStatus.PENDING) {
            return reply.code(422).send({
              error: 'submissionData validation failed',
              details: [{ path: '/', message: `Attachment ${attId} is not a pending upload for this task` }],
            });
          }
        }
      }

      task.submissionData = mergedSubmission;
      task.completedAt = new Date();

      const enqueue = app.temporalEnabled && Boolean(task.workflowId);
      task.signalStatus = enqueue ? SignalStatus.PENDING : SignalStatus.NOT_APPLICABLE;

      const linkedAt = new Date();

      // Build a map of fieldKey → payloadScope for linking. We iterate the schema
      // attachment fields and find which keys are referenced in mergedSubmission.
      const fieldToScope = form
        ? (() => {
            const fields = new Map<string, string>();
            const props = (form.jsonSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
            for (const [k, v] of Object.entries(props)) {
              if (v['x-flowstile-attachment']) fields.set(k, 'submission');
            }
            return fields;
          })()
        : new Map<string, string>();

      // Build attachmentId → fieldKey reverse lookup from mergedSubmission
      const attIdToField = new Map<string, string>();
      if (form) {
        const props = (form.jsonSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
        for (const key of Object.keys(props)) {
          const val = mergedSubmission[key];
          if (val === undefined || val === null) continue;
          const refs = Array.isArray(val) ? val : [val];
          for (const ref of refs) {
            if (ref && typeof ref === 'object' && typeof (ref as Record<string, unknown>).attachmentId === 'string') {
              attIdToField.set((ref as Record<string, unknown>).attachmentId as string, key);
            }
          }
        }
      }

      // Persist the task, link attachments, and the signal intent atomically.
      const savedTask = await app.db.transaction(async (manager) => {
        const saved = await manager.getRepository(Task).save(task);

        // Flip pending → linked for all referenced attachments
        for (const attId of attachmentIdsToLink) {
          const fieldKey = attIdToField.get(attId) ?? null;
          await manager.getRepository(Attachment).update(
            { id: attId },
            {
              status: AttachmentStatus.LINKED,
              fieldKey,
              payloadScope: 'submission',
              processInstanceId: saved.processInstanceId,
              linkedAt,
            },
          );
        }

        if (enqueue) {
          await enqueueSignal(manager, {
            taskId: saved.id,
            workflowId: saved.workflowId,
            signalName: completedSignalName(saved.id),
            payload: buildCompletedPayload({
              submissionData: saved.submissionData,
              completedAt: saved.completedAt,
              formDefinitionVersion: saved.formDefinitionVersion,
              assignee: { id: user.id, email: user.email, displayName: user.displayName },
            }),
          });
        }
        return saved;
      });

      return serializeTask(savedTask);
    },
  );

  app.post(
    '/tasks/:id/cancel',
    { ...write, schema: { params: UuidParam, tags: ['Tasks'] } },
    async (request, reply) => {
      const { id } = request.params;
      const actor = request.principal!;

      const task = await repo().findOne({ where: { id } });
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      try {
        task.status = TaskStateMachine.transition(task.status, 'cancel');
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }

      // Human callers may only cancel their own claimed task (or any with manage).
      // Service principals are the workflow engine itself (e.g. timeout/cancellation
      // cleanup from createTaskAndWait) and may cancel any task they have write on.
      const canManage = actor.permissions.includes(Permissions.TASKS_MANAGE);
      if (actor.user && task.assigneeId && task.assigneeId !== actor.user.id && !canManage) {
        return reply.code(403).send({ error: 'Only the assignee or a manager can cancel this task' });
      }

      const enqueue = app.temporalEnabled && Boolean(task.workflowId);
      task.signalStatus = enqueue ? SignalStatus.PENDING : SignalStatus.NOT_APPLICABLE;

      const savedTask = await app.db.transaction(async (manager) => {
        const saved = await manager.getRepository(Task).save(task);
        if (enqueue) {
          await enqueueSignal(manager, {
            taskId: saved.id,
            workflowId: saved.workflowId,
            signalName: cancelledSignalName(saved.id),
            payload: null,
          });
        }
        return saved;
      });

      return serializeTask(savedTask);
    },
  );

  app.post(
    '/tasks/:id/retry-signal',
    {
      preHandler: [requirePermission(Permissions.TASKS_MANAGE)],
      schema: { params: UuidParam, tags: ['Tasks'] },
    },
    async (request, reply) => {
      const { id } = request.params;

      const task = await repo().findOne({ where: { id }, relations: ['taskDefinition', 'assignee'] });
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      if (task.signalStatus !== SignalStatus.FAILED && task.signalStatus !== SignalStatus.PENDING) {
        return reply.code(409).send({
          error: 'Signal retry only allowed when signalStatus is failed or pending',
        });
      }
      if (!app.temporalEnabled || !task.workflowId) {
        return reply.code(409).send({ error: 'Temporal integration is not configured' });
      }

      // Re-enqueue for the relay to deliver; reset the projection to pending.
      await app.db.transaction(async (manager) => {
        await reenqueueForTask(manager, task);
        await manager.getRepository(Task).update(
          { id: task.id },
          { signalStatus: SignalStatus.PENDING, signalFailedAt: null },
        );
      });
      task.signalStatus = SignalStatus.PENDING;
      task.signalFailedAt = null;

      return serializeTask(task);
    },
  );
};
