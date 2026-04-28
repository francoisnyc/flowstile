import { FastifyInstance } from 'fastify';
import { Task } from '../entities/task.entity.js';
import { TaskDefinition } from '../entities/task-definition.entity.js';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { TaskStatus, FormDefinitionStatus, Priority } from '../common/enums.js';
import { TaskStateMachine, InvalidTransitionError } from '../common/task-state-machine.js';
import { filterFormSchemas, filterSubmissionData } from '../common/visibility.js';
import { requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';

export async function taskRoutes(app: FastifyInstance) {
  const read = { preHandler: [requirePermission(Permissions.TASKS_READ)] };
  const write = { preHandler: [requirePermission(Permissions.TASKS_WRITE)] };
  const repo = () => app.db.getRepository(Task);

  const userHasPermission = (user: { roles: { permissions: string[] }[] }, perm: string) =>
    user.roles.some((r) => r.permissions.includes(perm));

  // GET /tasks — filterable by status, assigneeId, group membership
  app.get('/tasks', read, async (request) => {
    const { status, assigneeId, group } = request.query as {
      status?: TaskStatus;
      assigneeId?: string;
      group?: string;
    };

    const qb = repo()
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.taskDefinition', 'td')
      .leftJoinAndSelect('t.assignee', 'a')
      .orderBy('t.createdAt', 'DESC');

    if (status) qb.andWhere('t.status = :status', { status });
    if (assigneeId) qb.andWhere('t.assignee_id = :assigneeId', { assigneeId });
    if (group) {
      // Filter to tasks whose candidateGroups contains the given group name
      qb.andWhere(':group = ANY(td.candidate_groups)', { group });
    }

    return qb.getMany();
  });

  // POST /tasks — create a new task instance (called by SDK)
  app.post('/tasks', write, async (request, reply) => {
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
    } = request.body as {
      taskDefinitionId: string;
      workflowId: string;
      processInstanceId?: string;
      priority?: Priority;
      dueDate?: string;
      followUpDate?: string;
      inputData?: Record<string, unknown>;
      contextData?: Record<string, unknown>;
      submissionData?: Record<string, unknown>;
    };

    const td = await app.db.getRepository(TaskDefinition).findOne({
      where: { id: taskDefinitionId },
    });
    if (!td) return reply.code(404).send({ error: 'Task definition not found' });

    // Lock to the latest published form version
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
      dueDate: dueDate ? new Date(dueDate) : null,
      followUpDate: followUpDate ? new Date(followUpDate) : null,
      inputData: inputData ?? {},
      contextData: contextData ?? {},
      submissionData: submissionData ?? {},
    });

    return reply.code(201).send(task);
  });

  // GET /tasks/:id — task detail + form schema (filtered by current user's roles/groups)
  app.get('/tasks/:id', read, async (request, reply) => {
    const { id } = request.params as { id: string };
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
      ...task,
      form: {
        code: form.code,
        version: form.version,
        jsonSchema,
        uiSchema,
        formMessages: form.formMessages,
      },
      submissionData: filteredData,
    };
  });

  // POST /tasks/:id/claim
  app.post('/tasks/:id/claim', write, async (request, reply) => {
    const { id } = request.params as { id: string };
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
    return task;
  });

  // POST /tasks/:id/unclaim
  app.post('/tasks/:id/unclaim', write, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.currentUser!;

    const task = await repo().findOne({ where: { id } });
    if (!task) return reply.code(404).send({ error: 'Task not found' });

    if (task.assigneeId !== user.id && !userHasPermission(user, Permissions.TASKS_MANAGE)) {
      return reply.code(403).send({ error: 'Only the assignee or a manager can unclaim this task' });
    }

    try {
      task.status = TaskStateMachine.transition(task.status, 'unclaim');
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }

    task.assigneeId = null;
    await repo().save(task);
    return task;
  });

  // POST /tasks/:id/complete
  app.post('/tasks/:id/complete', write, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { data } = request.body as { data?: Record<string, unknown> };

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
    await repo().save(task);

    // Signal the waiting workflow if Temporal is configured
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

    return task;
  });

  // POST /tasks/:id/cancel
  app.post('/tasks/:id/cancel', write, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.currentUser!;

    const task = await repo().findOne({ where: { id } });
    if (!task) return reply.code(404).send({ error: 'Task not found' });

    if (task.assigneeId !== user.id && !userHasPermission(user, Permissions.TASKS_MANAGE)) {
      return reply.code(403).send({ error: 'Only the assignee or a manager can cancel this task' });
    }

    try {
      task.status = TaskStateMachine.transition(task.status, 'cancel');
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }

    await repo().save(task);
    return task;
  });
}
