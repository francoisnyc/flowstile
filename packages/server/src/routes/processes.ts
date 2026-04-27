import { FastifyInstance } from 'fastify';
import { ProcessDefinition } from '../entities/process-definition.entity.js';
import { TaskDefinition } from '../entities/task-definition.entity.js';
import { ProcessDefinitionStatus, Priority } from '../common/enums.js';
import { requireAuth } from '../plugins/auth.js';

export async function processRoutes(app: FastifyInstance) {
  const pre = { preHandler: [requireAuth] };
  const pdRepo = () => app.db.getRepository(ProcessDefinition);
  const tdRepo = () => app.db.getRepository(TaskDefinition);

  // ── Process Definitions ──────────────────────────────────────────────────

  app.get('/processes', pre, async () => {
    return pdRepo().find({ order: { createdAt: 'ASC' } });
  });

  app.post('/processes', pre, async (request, reply) => {
    const { name, status } = request.body as {
      name: string;
      status?: ProcessDefinitionStatus;
    };

    const pd = await pdRepo().save({ name, status: status ?? ProcessDefinitionStatus.ACTIVE });
    return reply.code(201).send(pd);
  });

  app.get('/processes/:id', pre, async (request, reply) => {
    const { id } = request.params as { id: string };
    const pd = await pdRepo().findOne({
      where: { id },
      relations: ['taskDefinitions'],
    });
    if (!pd) return reply.code(404).send({ error: 'Process not found' });
    return pd;
  });

  app.patch('/processes/:id', pre, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { name, status } = request.body as {
      name?: string;
      status?: ProcessDefinitionStatus;
    };

    const pd = await pdRepo().findOne({ where: { id } });
    if (!pd) return reply.code(404).send({ error: 'Process not found' });

    if (name !== undefined) pd.name = name;
    if (status !== undefined) pd.status = status;
    await pdRepo().save(pd);
    return pd;
  });

  // ── Task Definitions ─────────────────────────────────────────────────────

  app.get('/processes/:id/tasks', pre, async (request, reply) => {
    const { id } = request.params as { id: string };

    const pd = await pdRepo().findOne({ where: { id } });
    if (!pd) return reply.code(404).send({ error: 'Process not found' });

    return tdRepo().find({
      where: { processDefinitionId: id },
      order: { createdAt: 'ASC' },
    });
  });

  app.post('/processes/:id/tasks', pre, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { code, formDefinitionCode, candidateGroups, candidateUsers, defaultPriority } =
      request.body as {
        code: string;
        formDefinitionCode: string;
        candidateGroups?: string[];
        candidateUsers?: string[];
        defaultPriority?: Priority;
      };

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
  });

  app.patch('/task-definitions/:id', pre, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { formDefinitionCode, candidateGroups, candidateUsers, defaultPriority } =
      request.body as {
        formDefinitionCode?: string;
        candidateGroups?: string[];
        candidateUsers?: string[];
        defaultPriority?: Priority;
      };

    const td = await tdRepo().findOne({ where: { id } });
    if (!td) return reply.code(404).send({ error: 'Task definition not found' });

    if (formDefinitionCode !== undefined) td.formDefinitionCode = formDefinitionCode;
    if (candidateGroups !== undefined) td.candidateGroups = candidateGroups;
    if (candidateUsers !== undefined) td.candidateUsers = candidateUsers;
    if (defaultPriority !== undefined) td.defaultPriority = defaultPriority;
    await tdRepo().save(td);
    return td;
  });
}
