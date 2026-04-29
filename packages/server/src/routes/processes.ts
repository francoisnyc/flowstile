import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ProcessDefinition } from '../entities/process-definition.entity.js';
import { TaskDefinition } from '../entities/task-definition.entity.js';
import { ProcessDefinitionStatus, Priority } from '../common/enums.js';
import { requireAuth, requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { PaginationQuery, paginate } from '../common/pagination.js';

const UuidParam = z.object({ id: z.string().uuid() });

const CreateProcessBody = z.object({
  name: z.string().min(1),
  status: z.nativeEnum(ProcessDefinitionStatus).optional(),
});

const PatchProcessBody = z.object({
  name: z.string().min(1).optional(),
  status: z.nativeEnum(ProcessDefinitionStatus).optional(),
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
  const pdRepo = () => app.db.getRepository(ProcessDefinition);
  const tdRepo = () => app.db.getRepository(TaskDefinition);

  app.get('/processes', { ...read, schema: { querystring: PaginationQuery } }, async (request) => {
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
    { ...write, schema: { body: CreateProcessBody } },
    async (request, reply) => {
      const { name, status } = request.body;
      const pd = await pdRepo().save({ name, status: status ?? ProcessDefinitionStatus.ACTIVE });
      return reply.code(201).send(pd);
    },
  );

  app.get(
    '/processes/:id',
    { ...read, schema: { params: UuidParam } },
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
    { ...write, schema: { params: UuidParam, body: PatchProcessBody } },
    async (request, reply) => {
      const { id } = request.params;
      const { name, status } = request.body;

      const pd = await pdRepo().findOne({ where: { id } });
      if (!pd) return reply.code(404).send({ error: 'Process not found' });

      if (name !== undefined) pd.name = name;
      if (status !== undefined) pd.status = status;
      await pdRepo().save(pd);
      return pd;
    },
  );

  app.get(
    '/processes/:id/tasks',
    { ...read, schema: { params: UuidParam, querystring: PaginationQuery } },
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
    { ...write, schema: { params: UuidParam, body: CreateTaskDefBody } },
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
    { ...write, schema: { params: UuidParam, body: PatchTaskDefBody } },
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
