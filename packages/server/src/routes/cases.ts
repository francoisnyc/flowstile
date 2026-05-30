import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { In } from 'typeorm';
import { Case } from '../entities/case.entity.js';
import { Task } from '../entities/task.entity.js';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { Attachment } from '../entities/attachment.entity.js';
import { ProcessDefinition } from '../entities/process-definition.entity.js';
import { AttachmentStatus } from '../common/enums.js';
import { requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { PaginationQuery, paginate } from '../common/pagination.js';
import { filterFormSchemas } from '../common/visibility.js';
import { toReference } from '../common/attachments.js';
import { deriveCaseStatus, type CaseStatus } from '../common/cases.js';

const UuidParam = z.object({ id: z.string().uuid() });
const PidParam = z.object({ processInstanceId: z.string().min(1) });

const CasesQuery = PaginationQuery.extend({
  status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']).optional(),
});

const PatchCaseVariablesBody = z.object({
  variables: z.record(z.string(), z.unknown()),
});

function serializeCaseTask(task: Task) {
  return {
    id: task.id,
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
    variables: c.variables,
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
  processName: string | null,
  userRoleNames: string[],
  userGroupNames: string[],
) {
  const tasks = await app.db
    .getRepository(Task)
    .find({
      where: { processInstanceId: c.processInstanceId },
      relations: ['taskDefinition', 'assignee'],
      order: { createdAt: 'ASC' },
    });

  const status = deriveCaseStatus(tasks);

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

  return {
    id: c.id,
    processInstanceId: c.processInstanceId,
    processDefinitionName: processName,
    title: c.title,
    variables: c.variables,
    status,
    startedById: c.startedById,
    createdAt: c.createdAt,
    tasks: tasks.map(serializeCaseTask),
    attachments: visibleAttachments,
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
    if (!task.taskDefinition) continue;
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
    .map(toReference);
}

export const caseRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: [requirePermission(Permissions.TASKS_READ)] };
  const write = { preHandler: [requirePermission(Permissions.TASKS_WRITE)] };

  const caseRepo = () => app.db.getRepository(Case);

  async function resolveProcessName(processDefinitionId: string | null): Promise<string | null> {
    if (!processDefinitionId) return null;
    const pd = await app.db
      .getRepository(ProcessDefinition)
      .findOne({ where: { id: processDefinitionId }, select: ['id', 'name'] });
    return pd?.name ?? null;
  }

  // GET /cases
  app.get('/cases', { ...read, schema: { querystring: CasesQuery, tags: ['Cases'] } }, async (request) => {
    const { status: statusFilter, limit, offset } = request.query;

    const [allCases, total] = await caseRepo().findAndCount({
      order: { createdAt: 'DESC' },
    });

    // Batch-load tasks for all cases in one query
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

    let items = allCases.map((c) => {
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
      const user = request.currentUser!;

      const c = await caseRepo().findOne({ where: { processInstanceId } });
      if (!c) return reply.code(404).send({ error: 'Case not found' });

      const userRoleNames = user.roles.map((r) => r.name);
      const userGroupNames = user.groups.map((g) => g.name);
      const processName = await resolveProcessName(c.processDefinitionId);

      return loadCaseDetail(app, c, processName, userRoleNames, userGroupNames);
    },
  );

  // GET /cases/:id
  app.get(
    '/cases/:id',
    { ...read, schema: { params: UuidParam, tags: ['Cases'] } },
    async (request, reply) => {
      const { id } = request.params;
      const user = request.currentUser!;

      const c = await caseRepo().findOne({ where: { id } });
      if (!c) return reply.code(404).send({ error: 'Case not found' });

      const userRoleNames = user.roles.map((r) => r.name);
      const userGroupNames = user.groups.map((g) => g.name);
      const processName = await resolveProcessName(c.processDefinitionId);

      return loadCaseDetail(app, c, processName, userRoleNames, userGroupNames);
    },
  );

  // PATCH /cases/by-process-instance/:processInstanceId/variables
  app.patch(
    '/cases/by-process-instance/:processInstanceId/variables',
    { ...write, schema: { params: PidParam, body: PatchCaseVariablesBody, tags: ['Cases'] } },
    async (request, reply) => {
      const { processInstanceId } = request.params;

      const c = await caseRepo().findOne({ where: { processInstanceId } });
      if (!c) return reply.code(404).send({ error: 'Case not found' });

      c.variables = { ...(c.variables ?? {}), ...request.body.variables };
      const saved = await caseRepo().save(c);

      return {
        id: saved.id,
        processInstanceId: saved.processInstanceId,
        variables: saved.variables,
      };
    },
  );
};
