import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { In } from 'typeorm';
import { Group } from '../entities/group.entity.js';
import { User } from '../entities/user.entity.js';
import { requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { PaginationQuery, paginate } from '../common/pagination.js';

function serialize(group: Group) {
  return {
    id: group.id,
    name: group.name,
    members: group.members?.map((u) => ({ id: u.id, email: u.email, displayName: u.displayName })) ?? [],
  };
}

const UuidParam = z.object({ id: z.string().uuid() });

const CreateGroupBody = z.object({
  name: z.string().min(1),
  memberIds: z.array(z.string().uuid()).optional(),
});

const PatchGroupBody = z.object({
  name: z.string().min(1).optional(),
  memberIds: z.array(z.string().uuid()).optional(),
});

export const groupRoutes: FastifyPluginAsyncZod = async (app) => {
  const pre = { preHandler: [requirePermission(Permissions.USERS_MANAGE)] };

  app.get('/groups', { ...pre, schema: { querystring: PaginationQuery } }, async (request) => {
    const { limit, offset } = request.query;
    const [groups, total] = await app.db.getRepository(Group).findAndCount({
      relations: ['members'],
      take: limit,
      skip: offset,
    });
    return paginate(groups.map(serialize), total, limit, offset);
  });

  app.post('/groups', { ...pre, schema: { body: CreateGroupBody } }, async (request, reply) => {
    const { name, memberIds } = request.body;

    const members = memberIds?.length
      ? await app.db.getRepository(User).findBy({ id: In(memberIds) })
      : [];

    const group = await app.db.getRepository(Group).save({ name, members });
    return reply.code(201).send(serialize(group));
  });

  app.patch(
    '/groups/:id',
    { ...pre, schema: { params: UuidParam, body: PatchGroupBody } },
    async (request, reply) => {
      const { id } = request.params;
      const { name, memberIds } = request.body;

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
    },
  );
};
