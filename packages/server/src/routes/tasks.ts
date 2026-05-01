import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { Task } from '../entities/task.entity.js';
import { TaskDefinition } from '../entities/task-definition.entity.js';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { TaskStatus, FormDefinitionStatus, Priority } from '../common/enums.js';
import { TaskStateMachine, InvalidTransitionError } from '../common/task-state-machine.js';
import { filterFormSchemas, filterSubmissionData } from '../common/visibility.js';
import { requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { PaginationQuery, paginate } from '../common/pagination.js';

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

export const taskRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: [requirePermission(Permissions.TASKS_READ)] };
  const write = { preHandler: [requirePermission(Permissions.TASKS_WRITE)] };
  const repo = () => app.db.getRepository(Task);

  const userHasPermission = (user: { roles: { permissions: string[] }[] }, perm: string) =>
    user.roles.some((r) => r.permissions.includes(perm));

  app.get('/tasks', { ...read, schema: { querystring: TasksQuery } }, async (request) => {
    const { status, assigneeId, group, limit, offset } = request.query;

    const qb = repo()
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.taskDefinition', 'td')
      .leftJoinAndSelect('t.assignee', 'a')
      .orderBy('t.createdAt', 'DESC')
      .limit(limit)
      .offset(offset);

    if (status) qb.andWhere('t.status = :status', { status });
    if (assigneeId) qb.andWhere('t.assigneeId = :assigneeId', { assigneeId });
    if (group) {
      // Filter to tasks whose candidateGroups contains the given group name
      qb.andWhere(':group = ANY(td.candidateGroups)', { group });
    }

    const [items, total] = await qb.getManyAndCount();
    return paginate(items.map(serializeTask), total, limit, offset);
  });

  app.post('/tasks', { ...write, schema: { body: CreateTaskBody } }, async (request, reply) => {
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
    { ...read, schema: { params: UuidParam } },
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
      };
    },
  );

  app.post(
    '/tasks/:id/claim',
    { ...write, schema: { params: UuidParam } },
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
    { ...write, schema: { params: UuidParam } },
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
    { ...write, schema: { params: UuidParam, body: CompleteTaskBody } },
    async (request, reply) => {
      const { id } = request.params;
      const { data } = request.body;

      const task = await repo().findOne({ where: { id } });
      if (!task) return reply.code(404).send({ error: 'Task not found' });

      try {
        task.status = TaskStateMachine.transition(task.status, 'complete');
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }

      if (data) task.submissionData = { ...task.submissionData, ...data };
      task.completedAt = new Date();
      const savedTask = await repo().save(task);

      if (app.temporal && task.workflowId) {
        const payload = { data: task.submissionData };
        const signalName = `flowstile:task:completed:${task.id}`;
        try {
          await app.temporal
            .workflow.getHandle(task.workflowId)
            .signal(signalName, payload);
        } catch (err) {
          app.log.warn({ err, taskId: task.id }, 'Failed to send Temporal signal for completed task');
        }
      }

      return serializeTask(savedTask);
    },
  );

  app.post(
    '/tasks/:id/cancel',
    { ...write, schema: { params: UuidParam } },
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
      return serializeTask(task);
    },
  );
};
