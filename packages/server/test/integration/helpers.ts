import bcrypt from 'bcrypt';
import type { FastifyInstance } from 'fastify';
import { In } from 'typeorm';
import { User } from '../../src/entities/user.entity.js';
import { Group } from '../../src/entities/group.entity.js';
import { Role } from '../../src/entities/role.entity.js';
import { FormDefinition } from '../../src/entities/form-definition.entity.js';
import { ProcessDefinition } from '../../src/entities/process-definition.entity.js';
import { TaskDefinition } from '../../src/entities/task-definition.entity.js';
import { Task } from '../../src/entities/task.entity.js';
import { FormDefinitionStatus, Priority } from '../../src/common/enums.js';

export const TEST_PASSWORD = 'test-password-123';

let _hash: string | null = null;
export async function testPasswordHash() {
  _hash ??= await bcrypt.hash(TEST_PASSWORD, 10);
  return _hash;
}

// Creates a test user and returns the entity
export async function createTestUser(
  app: FastifyInstance,
  overrides?: { email?: string; displayName?: string; permissions?: string[] },
) {
  const passwordHash = await testPasswordHash();
  const email = overrides?.email ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  let roles: Role[] = [];
  if (overrides?.permissions?.length) {
    const role = await app.db.getRepository(Role).save({
      name: `test-role-${Date.now()}`,
      permissions: overrides.permissions,
    });
    roles = [role];
  }

  return app.db.getRepository(User).save({
    email,
    displayName: overrides?.displayName ?? 'Test User',
    passwordHash,
    roles,
    groups: [],
  });
}

// Logs in as the given user and returns the Set-Cookie header value
export async function loginAs(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  const cookie = res.headers['set-cookie'];
  return Array.isArray(cookie) ? cookie[0] : (cookie ?? '');
}

// Injects a request with an auth cookie
export function authed(
  app: FastifyInstance,
  cookie: string,
  options: Parameters<FastifyInstance['inject']>[0],
) {
  return app.inject({
    ...options,
    headers: { cookie, ...('headers' in options ? options.headers : {}) },
  } as Parameters<FastifyInstance['inject']>[0]);
}

// Creates a minimal published form + process + task definition for task tests
export async function createTestTaskSetup(app: FastifyInstance) {
  const db = app.db;
  const tag = Date.now();

  const form = await db.getRepository(FormDefinition).save({
    code: `TEST_FORM_${tag}`,
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        DECISION: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
        NOTES: { type: 'string' },
      },
      required: ['DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/NOTES' },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const process = await db.getRepository(ProcessDefinition).save({
    name: `Test Process ${tag}`,
  });

  const taskDef = await db.getRepository(TaskDefinition).save({
    code: `TEST_TASK_DEF_${tag}`,
    processDefinitionId: process.id,
    formDefinitionCode: form.code,
    candidateGroups: [],
    candidateUsers: [],
    defaultPriority: Priority.NORMAL,
  });

  return { form, process, taskDef };
}

// Deletes all rows created by test helpers (keyed on test- email prefix or tag)
export async function cleanupTestData(app: FastifyInstance) {
  const db = app.db;
  await db.getRepository(Task).createQueryBuilder().delete().execute();
  await db.getRepository(TaskDefinition).createQueryBuilder()
    .delete().where('code LIKE :p', { p: 'TEST_%' }).execute();
  await db.getRepository(ProcessDefinition).createQueryBuilder()
    .delete().where('name LIKE :p', { p: 'Test Process%' }).execute();
  await db.getRepository(FormDefinition).createQueryBuilder()
    .delete().where('code LIKE :p', { p: 'TEST_%' }).execute();
  const testUsers = await db.getRepository(User).find({ where: { email: In([]) } });
  if (testUsers.length) {
    const ids = testUsers.map((u) => u.id);
    await db.query('DELETE FROM user_roles WHERE user_id = ANY($1)', [ids]);
    await db.query('DELETE FROM group_members WHERE user_id = ANY($1)', [ids]);
  }
  await db.getRepository(User).createQueryBuilder()
    .delete().where('email LIKE :p', { p: 'test-%' }).execute();
  await db.getRepository(Role).createQueryBuilder()
    .delete().where('name LIKE :p', { p: 'test-role-%' }).execute();
}
