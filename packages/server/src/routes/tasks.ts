import { z } from 'zod';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Task } from '../entities/task.entity.js';
import { TaskDefinition } from '../entities/task-definition.entity.js';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { TaskStatus, FormDefinitionStatus, Priority } from '../common/enums.js';
import { TaskStateMachine, InvalidTransitionError } from '../common/task-state-machine.js';
import { filterFormSchemas, filterSubmissionData, getWritableFields } from '../common/visibility.js';
import { requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { PaginationQuery, paginate } from '../common/pagination.js';
import { validateAgainstSchema, validateInputData } from '../validation/schema-validator.js';
import { deliverSignal } from '../signals/deliver-signal.js';

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
  filters: { status?: TaskStatus; assigneeId?: string; group?: string },
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

  return qb;
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
    const { status, assigneeId, group, limit, offset } = request.query;

    const qb = baseTaskQuery(repo(), { status, assigneeId, group }).limit(limit).offset(offset);

    const [items, total] = await qb.getManyAndCount();
    return paginate(items.map(serializeTask), total, limit, offset);
  });

  app.post('/tasks/search', { ...read, schema: { body: SearchTasksBody, tags: ['Tasks'] } }, async (request) => {
    const {
      status, assigneeId, group,
      inputVariables, contextVariables, submissionVariables,
      limit, offset,
    } = request.body;

    const qb = baseTaskQuery(repo(), { status, assigneeId, group }).limit(limit).offset(offset);

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

    return reply.code(201).send(serializeTask(task));
  });

  app.get(
    '/tasks/:id',
    { ...read, schema: { params: UuidParam, tags: ['Tasks'] } },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.currentUser!;

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

      // TODO: canClaim should also check candidateGroups/candidateUsers membership.
      // Currently the claim endpoint itself doesn't enforce this either — system-wide gap.
      const actions = {
        canClaim: hasWrite && TaskStateMachine.canTransition(task.status, 'claim'),
        canUnclaim: TaskStateMachine.canTransition(task.status, 'unclaim') && (isAssignee || hasManage),
        canComplete: hasWrite && TaskStateMachine.canTransition(task.status, 'complete') && isAssignee,
        canCancel: hasWrite && TaskStateMachine.canTransition(task.status, 'cancel') && (task.status === 'created' || isAssignee || hasManage),
      };

      return {
        ...serializeTask(task),
        form: {
          code: form.code,
          version: form.version,
          jsonSchema,
          uiSchema,
          formMessages: form.formMessages,
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
      const user = request.currentUser!;

      const task = await repo().findOne({ where: { id } });
      if (!task) return reply.code(404).send({ error: 'Task not found' });

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
      const user = request.currentUser!;

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
        const user = request.currentUser!;
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
      }

      task.submissionData = mergedSubmission;
      task.completedAt = new Date();
      const savedTask = await repo().save(task);

      if (app.temporal && task.workflowId) {
        const user = request.currentUser!;
        const delivered = await deliverSignal({
          temporal: app.temporal,
          workflowId: task.workflowId,
          signalName: `flowstile:task:completed:${task.id}`,
          payload: {
            data: task.submissionData,
            completedBy: {
              id: user.id,
              email: user.email,
              displayName: user.displayName,
            },
            completedAt: savedTask.completedAt!.toISOString(),
            formVersion: task.formDefinitionVersion,
          },
          logger: request.log,
        });
        if (!delivered) {
          request.log.error(
            { taskId: task.id, workflowId: task.workflowId },
            'Completion signal was not delivered — workflow may be out of sync',
          );
        }
      }

      return serializeTask(savedTask);
    },
  );

  app.post(
    '/tasks/:id/cancel',
    { ...write, schema: { params: UuidParam, tags: ['Tasks'] } },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.currentUser!;

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

      if (task.assigneeId && task.assigneeId !== user.id && !userHasPermission(user, Permissions.TASKS_MANAGE)) {
        return reply.code(403).send({ error: 'Only the assignee or a manager can cancel this task' });
      }

      await repo().save(task);

      if (app.temporal && task.workflowId) {
        const delivered = await deliverSignal({
          temporal: app.temporal,
          workflowId: task.workflowId,
          signalName: `flowstile:task:cancelled:${task.id}`,
          payload: undefined,
          logger: request.log,
        });
        if (!delivered) {
          request.log.error(
            { taskId: task.id, workflowId: task.workflowId },
            'Cancellation signal was not delivered — workflow may be out of sync',
          );
        }
      }

      return serializeTask(task);
    },
  );
};
