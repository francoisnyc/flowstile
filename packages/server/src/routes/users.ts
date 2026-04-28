import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import bcrypt from 'bcrypt';
import { In } from 'typeorm';
import { User } from '../entities/user.entity.js';
import { Group } from '../entities/group.entity.js';
import { Role } from '../entities/role.entity.js';
import { UserStatus } from '../common/enums.js';
import { requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';
import { PaginationQuery, paginate } from '../common/pagination.js';

function serialize(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    groups: user.groups?.map((g) => ({ id: g.id, name: g.name })) ?? [],
    roles: user.roles?.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions })) ?? [],
    createdAt: user.createdAt,
  };
}

const UuidParam = z.object({ id: z.string().uuid() });

const CreateUserBody = z.object({
  email: z.string().email(),
  displayName: z.string().min(1),
  password: z.string().min(8),
  groupIds: z.array(z.string().uuid()).optional(),
  roleIds: z.array(z.string().uuid()).optional(),
});

const PatchUserBody = z.object({
  displayName: z.string().min(1).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  groupIds: z.array(z.string().uuid()).optional(),
  roleIds: z.array(z.string().uuid()).optional(),
});

export const userRoutes: FastifyPluginAsyncZod = async (app) => {
  const pre = { preHandler: [requirePermission(Permissions.USERS_MANAGE)] };

  app.get('/users', { ...pre, schema: { querystring: PaginationQuery } }, async (request) => {
    const { limit, offset } = request.query;
    const [users, total] = await app.db.getRepository(User).findAndCount({
      relations: ['groups', 'roles'],
      order: { createdAt: 'ASC' },
      take: limit,
      skip: offset,
    });
    return paginate(users.map(serialize), total, limit, offset);
  });

  app.post('/users', { ...pre, schema: { body: CreateUserBody } }, async (request, reply) => {
    const { email, displayName, password, groupIds, roleIds } = request.body;

    const passwordHash = await bcrypt.hash(password, 10);

    const groups = groupIds?.length
      ? await app.db.getRepository(Group).findBy({ id: In(groupIds) })
      : [];
    const roles = roleIds?.length
      ? await app.db.getRepository(Role).findBy({ id: In(roleIds) })
      : [];

    const user = await app.db.getRepository(User).save({
      email,
      displayName,
      passwordHash,
      groups,
      roles,
    });

    return reply.code(201).send(serialize(user));
  });

  app.patch(
    '/users/:id',
    { ...pre, schema: { params: UuidParam, body: PatchUserBody } },
    async (request, reply) => {
      const { id } = request.params;
      const { displayName, status, groupIds, roleIds } = request.body;

      const repo = app.db.getRepository(User);
      const user = await repo.findOne({ where: { id }, relations: ['groups', 'roles'] });
      if (!user) return reply.code(404).send({ error: 'User not found' });

      if (displayName !== undefined) user.displayName = displayName;
      if (status !== undefined) user.status = status;
      if (groupIds !== undefined) {
        user.groups = groupIds.length
          ? await app.db.getRepository(Group).findBy({ id: In(groupIds) })
          : [];
      }
      if (roleIds !== undefined) {
        user.roles = roleIds.length
          ? await app.db.getRepository(Role).findBy({ id: In(roleIds) })
          : [];
      }

      await repo.save(user);
      return serialize(user);
    },
  );

  app.get('/roles', pre, async () => {
    return app.db.getRepository(Role).find({
      order: { name: 'ASC' },
      select: ['id', 'name', 'permissions'],
    });
  });
};
