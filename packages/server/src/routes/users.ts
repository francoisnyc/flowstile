import { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { In } from 'typeorm';
import { User } from '../entities/user.entity.js';
import { Group } from '../entities/group.entity.js';
import { Role } from '../entities/role.entity.js';
import { UserStatus } from '../common/enums.js';
import { requirePermission } from '../plugins/auth.js';
import { Permissions } from '../common/permissions.js';

function serialize(user: User) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    groups: user.groups?.map((g) => ({ id: g.id, name: g.name })) ?? [],
    roles: user.roles?.map((r) => ({ id: r.id, name: r.name })) ?? [],
    createdAt: user.createdAt,
  };
}

export async function userRoutes(app: FastifyInstance) {
  const pre = { preHandler: [requirePermission(Permissions.USERS_MANAGE)] };

  app.get('/users', pre, async () => {
    const users = await app.db.getRepository(User).find({
      relations: ['groups', 'roles'],
      order: { createdAt: 'ASC' },
    });
    return users.map(serialize);
  });

  app.post('/users', pre, async (request, reply) => {
    const { email, displayName, password, groupIds, roleIds } = request.body as {
      email: string;
      displayName: string;
      password: string;
      groupIds?: string[];
      roleIds?: string[];
    };

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

  app.patch('/users/:id', pre, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { displayName, status, groupIds, roleIds } = request.body as {
      displayName?: string;
      status?: UserStatus;
      groupIds?: string[];
      roleIds?: string[];
    };

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
  });
}
