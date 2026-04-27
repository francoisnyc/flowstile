import 'reflect-metadata';
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { dataSourceOptions } from './config/database.js';
import { User } from './entities/user.entity.js';
import { Group } from './entities/group.entity.js';
import { Role } from './entities/role.entity.js';
import { FormDefinition } from './entities/form-definition.entity.js';
import { ProcessDefinition } from './entities/process-definition.entity.js';
import { TaskDefinition } from './entities/task-definition.entity.js';
import { Task } from './entities/task.entity.js';
import { FormDefinitionStatus, TaskStatus, Priority } from './common/enums.js';

async function seed() {
  const db = new DataSource(dataSourceOptions);
  await db.initialize();

  console.log('Seeding database...');

  // Groups
  const loanOfficers = await db.getRepository(Group).save({ name: 'loan-officers' });
  const hrTeam = await db.getRepository(Group).save({ name: 'hr-team' });

  // Roles
  const adminRole = await db.getRepository(Role).save({
    name: 'admin',
    permissions: ['forms:write', 'tasks:read', 'tasks:write', 'users:manage'],
  });
  const taskUserRole = await db.getRepository(Role).save({
    name: 'task-user',
    permissions: ['tasks:read', 'tasks:write'],
  });

  // Users (password is "password" — dev only)
  const devHash = await bcrypt.hash('password', 10);
  const alice = await db.getRepository(User).save({
    email: 'alice@example.com',
    displayName: 'Alice (Admin)',
    passwordHash: devHash,
    groups: [loanOfficers],
    roles: [adminRole, taskUserRole],
  });
  const bob = await db.getRepository(User).save({
    email: 'bob@example.com',
    displayName: 'Bob (Loan Officer)',
    passwordHash: devHash,
    groups: [loanOfficers],
    roles: [taskUserRole],
  });

  // Form: Loan Application
  const loanForm = await db.getRepository(FormDefinition).save({
    code: 'LOAN_APPLICATION',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        CUSTOMER_NAME: { type: 'string' },
        AMOUNT: { type: 'number', minimum: 0 },
        DECISION: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
        NOTES: { type: 'string' },
      },
      required: ['CUSTOMER_NAME', 'AMOUNT', 'DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/CUSTOMER_NAME' },
        { type: 'Control', scope: '#/properties/AMOUNT' },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/NOTES', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  // Process: Loan Processing
  const loanProcess = await db.getRepository(ProcessDefinition).save({
    name: 'Loan Processing',
  });

  // Task Definition: Review Loan
  const reviewLoan = await db.getRepository(TaskDefinition).save({
    code: 'REVIEW_LOAN',
    processDefinitionId: loanProcess.id,
    formDefinitionCode: loanForm.code,
    candidateGroups: ['loan-officers'],
    defaultPriority: Priority.HIGH,
  });

  // Sample tasks
  await db.getRepository(Task).save({
    taskDefinitionId: reviewLoan.id,
    formDefinitionVersion: loanForm.version,
    workflowId: 'loan-workflow-001',
    processInstanceId: 'LN-2024-0847',
    status: TaskStatus.CREATED,
    priority: Priority.HIGH,
    inputData: { CUSTOMER_ID: 'cust-001' },
    contextData: {
      CUSTOMER_NAME: 'John Doe',
      APPLICATION_REFERENCE: 'LN-2024-0847',
      RISK_TIER: 'medium',
    },
    submissionData: { AMOUNT: 50000 },
    dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
  });

  await db.getRepository(Task).save({
    taskDefinitionId: reviewLoan.id,
    formDefinitionVersion: loanForm.version,
    workflowId: 'loan-workflow-002',
    processInstanceId: 'LN-2024-0848',
    status: TaskStatus.CLAIMED,
    assigneeId: bob.id,
    priority: Priority.NORMAL,
    inputData: { CUSTOMER_ID: 'cust-002' },
    contextData: {
      CUSTOMER_NAME: 'Jane Smith',
      APPLICATION_REFERENCE: 'LN-2024-0848',
      RISK_TIER: 'high',
    },
    submissionData: { AMOUNT: 75000 },
    dueDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
  });

  console.log('Seed complete:');
  console.log('  2 groups: loan-officers, hr-team');
  console.log('  2 roles: admin, task-user');
  console.log('  2 users: alice@example.com (admin), bob@example.com (loan officer)');
  console.log('  1 form: LOAN_APPLICATION v1');
  console.log('  1 process: Loan Processing');
  console.log('  1 task definition: REVIEW_LOAN');
  console.log('  2 tasks: one unassigned, one claimed by Bob');

  await db.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
