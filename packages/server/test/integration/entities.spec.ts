import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { User } from '../../src/entities/user.entity.js';
import { Group } from '../../src/entities/group.entity.js';
import { Role } from '../../src/entities/role.entity.js';
import { FormDefinition } from '../../src/entities/form-definition.entity.js';
import { ProcessDefinition } from '../../src/entities/process-definition.entity.js';
import { TaskDefinition } from '../../src/entities/task-definition.entity.js';
import { Task } from '../../src/entities/task.entity.js';
import { FormDefinitionStatus, TaskStatus, Priority } from '../../src/common/enums.js';

describe('Entity graph smoke test', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    // Clean up in reverse dependency order using query builder
    await app.db.getRepository(Task).createQueryBuilder().delete().execute();
    await app.db.getRepository(TaskDefinition).createQueryBuilder().delete().execute();
    await app.db.getRepository(ProcessDefinition).createQueryBuilder().delete().execute();
    await app.db.getRepository(FormDefinition).createQueryBuilder().delete().execute();
    // Clear join tables before deleting users
    await app.db.query('DELETE FROM group_members WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', ['test-%']);
    await app.db.query('DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', ['test-%']);
    await app.db.getRepository(User).createQueryBuilder().delete().where('email LIKE :e', { e: 'test-%' }).execute();
    await app.db.getRepository(Group).createQueryBuilder().delete().where('name LIKE :n', { n: 'test-%' }).execute();
    await app.db.getRepository(Role).createQueryBuilder().delete().where('name LIKE :n', { n: 'test-%' }).execute();
    await app.close();
  });

  it('creates and queries the full entity graph', async () => {
    const db = app.db;

    // Create a group and role
    const group = await db.getRepository(Group).save({ name: 'test-loan-officers' });
    const role = await db.getRepository(Role).save({
      name: 'test-task-user',
      permissions: ['tasks:read', 'tasks:write'],
    });

    // Create a user with group and role
    const user = await db.getRepository(User).save({
      email: 'test-alice@example.com',
      displayName: 'Alice',
      passwordHash: '$2b$10$placeholder',
      groups: [group],
      roles: [role],
    });

    // Create a form definition
    const form = await db.getRepository(FormDefinition).save({
      code: 'TEST_LOAN_APPLICATION',
      version: 1,
      jsonSchema: {
        type: 'object',
        properties: {
          AMOUNT: { type: 'number' },
          DECISION: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
        },
        required: ['AMOUNT', 'DECISION'],
      },
      status: FormDefinitionStatus.PUBLISHED,
    });

    // Create a process definition
    const process = await db.getRepository(ProcessDefinition).save({
      name: 'Test Loan Processing',
    });

    // Create a task definition
    const taskDef = await db.getRepository(TaskDefinition).save({
      code: 'TEST_REVIEW_LOAN',
      processDefinitionId: process.id,
      formDefinitionCode: form.code,
      candidateGroups: ['test-loan-officers'],
      defaultPriority: Priority.HIGH,
    });

    // Create a task instance
    const task = await db.getRepository(Task).save({
      taskDefinitionId: taskDef.id,
      formDefinitionVersion: form.version,
      workflowId: 'test-workflow-123',
      processInstanceId: 'test-loan-456',
      status: TaskStatus.CREATED,
      priority: Priority.HIGH,
      inputData: { CUSTOMER_ID: 'cust-123' },
      contextData: { CUSTOMER_NAME: 'Alice Applicant', RISK_TIER: 'medium' },
      submissionData: { AMOUNT: 50000 },
    });

    // Query it back with relations
    const found = await db.getRepository(Task).findOne({
      where: { id: task.id },
      relations: ['taskDefinition', 'taskDefinition.processDefinition'],
    });

    expect(found).not.toBeNull();
    expect(found!.taskDefinition.code).toBe('TEST_REVIEW_LOAN');
    expect(found!.taskDefinition.processDefinition.name).toBe('Test Loan Processing');
    expect(found!.inputData).toEqual({ CUSTOMER_ID: 'cust-123' });
    expect(found!.contextData).toEqual({
      CUSTOMER_NAME: 'Alice Applicant',
      RISK_TIER: 'medium',
    });
    expect(found!.submissionData).toEqual({ AMOUNT: 50000 });
    expect(found!.status).toBe(TaskStatus.CREATED);

    // Query user with groups and roles
    const foundUser = await db.getRepository(User).findOne({
      where: { id: user.id },
      relations: ['groups', 'roles'],
    });

    expect(foundUser!.groups).toHaveLength(1);
    expect(foundUser!.groups[0].name).toBe('test-loan-officers');
    expect(foundUser!.roles[0].permissions).toContain('tasks:read');
  });
});
