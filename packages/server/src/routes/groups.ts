import { FastifyInstance } from 'fastify';
import { In } from 'typeorm';
import { Group } from '../entities/group.entity.js';
import { User } from '../entities/user.entity.js';
import { requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';

function serialize(group: Group) {
  return {
    id: group.id,
    name: group.name,
    members: group.members?.map((u) => ({ id: u.id, email: u.email, displayName: u.displayName })) ?? [],
  };
}

export async function groupRoutes(app: FastifyInstance) {
  const pre = { preHandler: [requirePermission(Permissions.USERS_MANAGE)] };

  app.get('/groups', pre, async () => {
    const groups = await app.db.getRepository(Group).find({ relations: ['members'] });
    return groups.map(serialize);
  });

  app.post('/groups', pre, async (request, reply) => {
    const { name, memberIds } = request.body as { name: string; memberIds?: string[] };

    const members = memberIds?.length
      ? await app.db.getRepository(User).findBy({ id: In(memberIds) })
      : [];

    const group = await app.db.getRepository(Group).save({ name, members });
    return reply.code(201).send(serialize(group));
  });

  app.patch('/groups/:id', pre, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { name, memberIds } = request.body as { name?: string; memberIds?: string[] };

    const repo = app.db.getRepository(Group);
    const group = await repo.findOne({ where: { id }, relations: ['members'] });
    if (!group) return reply.code(404).send({ error: 'Group not found' });

    if (name !== undefined) group.name = name;
    if (memberIds !== undefined) {
      group.members = memberIds.length
        ? await app.db.getRepository(User).findBy({ id: In(memberIds) })
        : [];
    }

    await repo.save(group);
    return serialize(group);
  });
}
