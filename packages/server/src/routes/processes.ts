import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ProcessDefinition } from '../entities/process-definition.entity.js';
import { TaskDefinition } from '../entities/task-definition.entity.js';
import { FormDefinition } from '../entities/form-definition.entity.js';
import { Case } from '../entities/case.entity.js';
import { ProcessDefinitionStatus, Priority, FormDefinitionStatus } from '../common/enums.js';
import { requireAuth, requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { PaginationQuery, paginate } from '../common/pagination.js';
import { validateAgainstSchema } from '../validation/schema-validator.js';

const UuidParam = z.object({ id: z.string().uuid() });

// Postgres unique-violation SQLSTATE, surfaced by TypeORM's QueryFailedError.
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; driverError?: { code?: string } })?.code
    ?? (err as { driverError?: { code?: string } })?.driverError?.code;
  return code === '23505';
}

const CreateProcessBody = z.object({
  name: z.string().min(1),
  status: z.nativeEnum(ProcessDefinitionStatus).optional(),
});

const PatchProcessBody = z.object({
  name: z.string().min(1).optional(),
  status: z.nativeEnum(ProcessDefinitionStatus).optional(),
  startFormCode: z.string().min(1).nullable().optional(),
  workflowType: z.string().min(1).nullable().optional(),
  taskQueue: z.string().min(1).nullable().optional(),
});

const StartProcessBody = z.object({
  data: z.record(z.string(), z.unknown()).default({}),
  // Optional client-supplied key that makes a start request idempotent: two
  // requests with the same key against the same process resolve to the same
  // workflow / case instead of starting duplicates (e.g. on double-submit).
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const StartProcessResponse = z.object({
  processInstanceId: z.string(),
  caseId: z.string(),
});

const ErrorResponse = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});

const CreateTaskDefBody = z.object({
  code: z.string().min(1),
  formDefinitionCode: z.string().min(1),
  candidateGroups: z.array(z.string()).optional(),
  candidateUsers: z.array(z.string()).optional(),
  defaultPriority: z.nativeEnum(Priority).optional(),
});

const PatchTaskDefBody = z.object({
  formDefinitionCode: z.string().min(1).optional(),
  candidateGroups: z.array(z.string()).optional(),
  candidateUsers: z.array(z.string()).optional(),
  defaultPriority: z.nativeEnum(Priority).optional(),
});

export const processRoutes: FastifyPluginAsyncZod = async (app) => {
  const read = { preHandler: [requireAuth] };
  const write = { preHandler: [requirePermission(Permissions.PROCESSES_WRITE)] };
  const start = { preHandler: [requirePermission(Permissions.PROCESSES_START)] };
  const pdRepo = () => app.db.getRepository(ProcessDefinition);
  const tdRepo = () => app.db.getRepository(TaskDefinition);

  app.get('/processes', { ...read, schema: { querystring: PaginationQuery, tags: ['Processes'] } }, async (request) => {
    const { limit, offset } = request.query;
    const [items, total] = await pdRepo().findAndCount({
      order: { createdAt: 'ASC' },
      take: limit,
      skip: offset,
    });
    return paginate(items, total, limit, offset);
  });

  app.post(
    '/processes',
    { ...write, schema: { body: CreateProcessBody, tags: ['Processes'] } },
    async (request, reply) => {
      const { name, status } = request.body;
      const pd = await pdRepo().save({ name, status: status ?? ProcessDefinitionStatus.ACTIVE });
      return reply.code(201).send(pd);
    },
  );

  app.get(
    '/processes/:id',
    { ...read, schema: { params: UuidParam, tags: ['Processes'] } },
    async (request, reply) => {
      const { id } = request.params;
      const pd = await pdRepo().findOne({
        where: { id },
        relations: ['taskDefinitions'],
      });
      if (!pd) return reply.code(404).send({ error: 'Process not found' });
      return pd;
    },
  );

  app.patch(
    '/processes/:id',
    { ...write, schema: { params: UuidParam, body: PatchProcessBody, tags: ['Processes'] } },
    async (request, reply) => {
      const { id } = request.params;
      const { name, status, startFormCode, workflowType, taskQueue } = request.body;

      const pd = await pdRepo().findOne({ where: { id } });
      if (!pd) return reply.code(404).send({ error: 'Process not found' });

      if (name !== undefined) pd.name = name;
      if (status !== undefined) pd.status = status;
      if (startFormCode !== undefined) pd.startFormCode = startFormCode;
      if (workflowType !== undefined) pd.workflowType = workflowType;
      if (taskQueue !== undefined) pd.taskQueue = taskQueue;
      await pdRepo().save(pd);
      return pd;
    },
  );

  app.post(
    '/processes/:id/start',
    {
      ...start,
      schema: {
        params: UuidParam,
        body: StartProcessBody,
        response: {
          200: StartProcessResponse,
          201: StartProcessResponse,
          404: ErrorResponse,
          422: ErrorResponse,
          502: ErrorResponse,
          503: ErrorResponse,
        },
        tags: ['Processes'],
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { data, idempotencyKey } = request.body;
      const caseRepo = app.db.getRepository(Case);

      const pd = await pdRepo().findOne({ where: { id } });
      if (!pd) return reply.code(404).send({ error: 'Process not found' });

      if (!pd.workflowType || !pd.taskQueue) {
        return reply.code(422).send({
          error: 'Process is not configured for portal start — set workflowType and taskQueue',
        });
      }

      // Validate start form data if a start form is configured. When no start
      // form is configured the process accepts no caller input — reject any
      // supplied data rather than passing it through unvalidated.
      if (pd.startFormCode) {
        const form = await app.db.getRepository(FormDefinition).findOne({
          where: { code: pd.startFormCode, status: FormDefinitionStatus.PUBLISHED },
          order: { version: 'DESC' },
        });
        if (!form) {
          return reply.code(422).send({ error: `Start form '${pd.startFormCode}' has no published version` });
        }
        // Start-form data is a complete human submission — enforce required.
        const validation = validateAgainstSchema(data, form.jsonSchema as Record<string, unknown>);
        if (!validation.valid) {
          return reply.code(422).send({ error: 'Start form validation failed', details: validation.errors });
        }
      } else if (Object.keys(data).length > 0) {
        return reply.code(422).send({ error: 'Process has no start form and does not accept start data' });
      }

      if (!app.temporalEnabled || !app.temporal) {
        return reply.code(503).send({ error: 'Temporal is not configured — portal start is unavailable' });
      }

      // A deterministic id derived from the idempotency key makes the whole
      // operation replay-safe: the Case.processInstanceId unique constraint and
      // Temporal's workflow-id reuse policy both reject duplicates.
      const processInstanceId = idempotencyKey
        ? `start-${pd.id}-${idempotencyKey}`
        : randomUUID();

      // Replay: a prior request with this key already produced a case.
      if (idempotencyKey) {
        const existing = await caseRepo.findOne({ where: { processInstanceId } });
        if (existing) return reply.code(200).send({ processInstanceId, caseId: existing.id });
      }

      const principal = request.principal;
      const startedBy = principal
        ? { id: principal.id, email: principal.user?.email ?? '', displayName: principal.displayName }
        : null;

      // Persist the case *before* starting the workflow. An orphaned case (no
      // workflow) is visible and cleanable; an orphaned workflow (no case) is
      // invisible. If the start then fails we roll the case back.
      let caseRow: Case;
      try {
        caseRow = await caseRepo.save({
          processInstanceId,
          processDefinitionId: pd.id,
          startedById: principal?.id ?? null,
          entity: Object.keys(data).length > 0 ? data : null,
        });
      } catch (err) {
        // Unique-violation on processInstanceId means a concurrent idempotent
        // request won the race — return its case.
        if (isUniqueViolation(err) && idempotencyKey) {
          const existing = await caseRepo.findOne({ where: { processInstanceId } });
          if (existing) return reply.code(200).send({ processInstanceId, caseId: existing.id });
        }
        throw err;
      }

      try {
        await app.temporal.workflow.start(pd.workflowType, {
          taskQueue: pd.taskQueue,
          workflowId: processInstanceId,
          // Reserved keys (processInstanceId, startedBy) live in their own slots
          // so caller-supplied form fields can never forge or clobber them.
          args: [{ processInstanceId, startedBy, data }],
        });
      } catch (err) {
        await caseRepo.delete({ id: caseRow.id }).catch(() => {});
        app.log.error(
          { err, processId: id, workflowType: pd.workflowType },
          'Portal start: workflow failed to start',
        );
        // The request was well-formed; the failure is upstream (Temporal). Do
        // not leak raw engine error text to the caller.
        return reply.code(502).send({ error: 'Failed to start workflow' });
      }

      return reply.code(201).send({ processInstanceId, caseId: caseRow.id });
    },
  );

  app.get(
    '/processes/:id/tasks',
    { ...read, schema: { params: UuidParam, querystring: PaginationQuery, tags: ['Processes'] } },
    async (request, reply) => {
      const { id } = request.params;
      const { limit, offset } = request.query;

      const pd = await pdRepo().findOne({ where: { id } });
      if (!pd) return reply.code(404).send({ error: 'Process not found' });

      const [items, total] = await tdRepo().findAndCount({
        where: { processDefinitionId: id },
        order: { createdAt: 'ASC' },
        take: limit,
        skip: offset,
      });
      return paginate(items, total, limit, offset);
    },
  );

  app.post(
    '/processes/:id/tasks',
    { ...write, schema: { params: UuidParam, body: CreateTaskDefBody, tags: ['Processes'] } },
    async (request, reply) => {
      const { id } = request.params;
      const { code, formDefinitionCode, candidateGroups, candidateUsers, defaultPriority } =
        request.body;

      const pd = await pdRepo().findOne({ where: { id } });
      if (!pd) return reply.code(404).send({ error: 'Process not found' });

      const td = await tdRepo().save({
        code,
        processDefinitionId: id,
        formDefinitionCode,
        candidateGroups: candidateGroups ?? [],
        candidateUsers: candidateUsers ?? [],
        defaultPriority: defaultPriority ?? Priority.NORMAL,
      });

      return reply.code(201).send(td);
    },
  );

  app.patch(
    '/task-definitions/:id',
    { ...write, schema: { params: UuidParam, body: PatchTaskDefBody, tags: ['Processes'] } },
    async (request, reply) => {
      const { id } = request.params;
      const { formDefinitionCode, candidateGroups, candidateUsers, defaultPriority } =
        request.body;

      const td = await tdRepo().findOne({ where: { id } });
      if (!td) return reply.code(404).send({ error: 'Task definition not found' });

      if (formDefinitionCode !== undefined) td.formDefinitionCode = formDefinitionCode;
      if (candidateGroups !== undefined) td.candidateGroups = candidateGroups;
      if (candidateUsers !== undefined) td.candidateUsers = candidateUsers;
      if (defaultPriority !== undefined) td.defaultPriority = defaultPriority;
      await tdRepo().save(td);
      return td;
    },
  );
};
