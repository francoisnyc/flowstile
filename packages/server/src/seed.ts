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
import { ApiKey } from './entities/api-key.entity.js';
import { FormDefinitionStatus, TaskStatus, Priority } from './common/enums.js';
import { hashApiKey } from './common/api-keys.js';

// Stable, well-known development service credential so the demo worker can
// authenticate out of the box. NEVER provision a fixed key like this in prod —
// mint one via POST /auth/api-keys and inject it as FLOWSTILE_API_KEY.
const DEV_API_KEY = 'fsk_dev_local_worker_DO_NOT_USE_IN_PROD';

async function seed() {
  const db = new DataSource(dataSourceOptions);
  await db.initialize();

  console.log('Seeding database...');

  // Truncate all tables (cascade) so seed is idempotent
  await db.query(`
    TRUNCATE attachments, tasks, task_definitions, process_definitions, form_definitions,
             group_members, user_roles, users, groups, roles, api_keys
    CASCADE
  `);

  // Groups
  const loanOfficers = await db.getRepository(Group).save({ name: 'loan-officers' });
  const hrTeam = await db.getRepository(Group).save({ name: 'hr-team' });
  const orderReviewers = await db.getRepository(Group).save({ name: 'order-reviewers' });
  const warehouse = await db.getRepository(Group).save({ name: 'warehouse' });
  const customerService = await db.getRepository(Group).save({ name: 'customer-service' });

  // Roles
  const adminRole = await db.getRepository(Role).save({
    name: 'admin',
    permissions: ['forms:write', 'processes:write', 'tasks:read', 'tasks:write', 'tasks:manage', 'users:manage'],
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
    groups: [loanOfficers, orderReviewers],
    roles: [adminRole, taskUserRole],
  });
  const bob = await db.getRepository(User).save({
    email: 'bob@example.com',
    displayName: 'Bob (Loan Officer)',
    passwordHash: devHash,
    groups: [loanOfficers, warehouse],
    roles: [taskUserRole],
  });
  await db.getRepository(User).save({
    email: 'service@flowstile.local',
    displayName: 'Flowstile Service',
    passwordHash: devHash,
    roles: [taskUserRole],
  });
  const carol = await db.getRepository(User).save({
    email: 'carol@example.com',
    displayName: 'Carol Davis',
    passwordHash: devHash,
    groups: [customerService],
    roles: [taskUserRole],
  });

  // Development service credential for the demo worker. The worker authenticates
  // with this token (FLOWSTILE_API_KEY) instead of a human login.
  await db.getRepository(ApiKey).save({
    name: 'dev-worker',
    keyHash: hashApiKey(DEV_API_KEY),
    prefix: DEV_API_KEY.slice(0, 12),
    permissions: ['tasks:read', 'tasks:write'],
  });

  // Form: Loan Application (includes a file-upload field for supporting documents)
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
        // Attachment field: loan officers can attach supporting documents (e.g. credit reports, ID scans)
        SUPPORTING_DOCUMENTS: {
          'x-flowstile-attachment': {
            multiple: true,
            accept: ['application/pdf', 'image/jpeg', 'image/png'],
            maxSize: 10 * 1024 * 1024, // 10 MB per file
          },
        },
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
        { type: 'Control', scope: '#/properties/SUPPORTING_DOCUMENTS', label: 'Supporting Documents' },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  // Form: Order Approval
  const orderApprovalForm = await db.getRepository(FormDefinition).save({
    code: 'ORDER_APPROVAL',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        CUSTOMER_NAME: { type: 'string' },
        ORDER_ID: { type: 'string' },
        ORDER_ITEMS: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              quantity: { type: 'integer' },
              price: { type: 'number' },
            },
          },
        },
        TOTAL: { type: 'number' },
        DECISION: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
        REASON: { type: 'string' },
      },
      required: ['CUSTOMER_NAME', 'ORDER_ID', 'ORDER_ITEMS', 'TOTAL', 'DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/ORDER_ID', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/CUSTOMER_NAME', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/ORDER_ITEMS', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/TOTAL', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/REASON', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  // Form: Shipment Confirmation
  const shipmentForm = await db.getRepository(FormDefinition).save({
    code: 'SHIPMENT_CONFIRMATION',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        ORDER_ID: { type: 'string' },
        CUSTOMER_NAME: { type: 'string' },
        ORDER_ITEMS: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              quantity: { type: 'integer' },
              price: { type: 'number' },
            },
          },
        },
        SHIPPING_ADDRESS: { type: 'string' },
        TRANSACTION_ID: { type: 'string' },
        DECISION: { type: 'string', enum: ['CONFIRMED', 'REJECTED'] },
        REASON: { type: 'string' },
        TRACKING_NUMBER: { type: 'string' },
        // Warehouse staff can upload a proof of shipment (carrier receipt, photo)
        PROOF_OF_SHIPMENT: {
          'x-flowstile-attachment': {
            multiple: false,
            accept: ['image/jpeg', 'image/png', 'application/pdf'],
            maxSize: 5 * 1024 * 1024, // 5 MB
          },
        },
      },
      required: ['ORDER_ID', 'ORDER_ITEMS', 'SHIPPING_ADDRESS', 'DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/ORDER_ID', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/CUSTOMER_NAME', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/ORDER_ITEMS', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/SHIPPING_ADDRESS', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/TRANSACTION_ID', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/TRACKING_NUMBER' },
        { type: 'Control', scope: '#/properties/PROOF_OF_SHIPMENT', label: 'Proof of Shipment' },
        { type: 'Control', scope: '#/properties/REASON', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  // Form: Order Exception
  const exceptionForm = await db.getRepository(FormDefinition).save({
    code: 'ORDER_EXCEPTION',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        ORDER_ID: { type: 'string' },
        CUSTOMER_NAME: { type: 'string' },
        CUSTOMER_EMAIL: { type: 'string' },
        REASON: { type: 'string' },
        REFUNDED: { type: 'boolean' },
        RESOLUTION: { type: 'string', enum: ['CONTACTED', 'RESHIPPED', 'VOUCHER_ISSUED'] },
        NOTES: { type: 'string' },
      },
      required: ['ORDER_ID', 'CUSTOMER_NAME', 'REASON', 'RESOLUTION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/ORDER_ID', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/CUSTOMER_NAME', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/CUSTOMER_EMAIL', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/REASON', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/REFUNDED', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/RESOLUTION' },
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

  // Process: Order Fulfillment
  const orderProcess = await db.getRepository(ProcessDefinition).save({
    name: 'Order Fulfillment',
  });

  // Task Definition: Approve Order
  const approveOrder = await db.getRepository(TaskDefinition).save({
    code: 'APPROVE_ORDER',
    processDefinitionId: orderProcess.id,
    formDefinitionCode: orderApprovalForm.code,
    candidateGroups: ['order-reviewers'],
    defaultPriority: Priority.HIGH,
  });

  // Task Definition: Confirm Shipment
  const confirmShipment = await db.getRepository(TaskDefinition).save({
    code: 'CONFIRM_SHIPMENT',
    processDefinitionId: orderProcess.id,
    formDefinitionCode: shipmentForm.code,
    candidateGroups: ['warehouse'],
    defaultPriority: Priority.NORMAL,
  });

  // Task Definition: Handle Exception
  const handleException = await db.getRepository(TaskDefinition).save({
    code: 'HANDLE_EXCEPTION',
    processDefinitionId: orderProcess.id,
    formDefinitionCode: exceptionForm.code,
    candidateGroups: ['customer-service'],
    defaultPriority: Priority.URGENT,
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

  // Sample order tasks
  await db.getRepository(Task).save({
    taskDefinitionId: approveOrder.id,
    formDefinitionVersion: orderApprovalForm.version,
    workflowId: 'order-workflow-001',
    processInstanceId: 'ORD-2024-1001',
    status: TaskStatus.CREATED,
    priority: Priority.HIGH,
    inputData: {
      ORDER_ITEMS: [
        { name: 'Wireless Headphones', quantity: 1, price: 79.99 },
        { name: 'USB-C Hub', quantity: 1, price: 45.00 },
        { name: 'Phone Case', quantity: 1, price: 24.99 },
      ],
      TOTAL: 149.98,
      CUSTOMER_EMAIL: 'mike.j@example.com',
    },
    contextData: {
      ORDER_ID: 'ORD-2024-1001',
      CUSTOMER_NAME: 'Mike Johnson',
    },
    submissionData: {},
    dueDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  });

  await db.getRepository(Task).save({
    taskDefinitionId: confirmShipment.id,
    formDefinitionVersion: shipmentForm.version,
    workflowId: 'order-workflow-002',
    processInstanceId: 'ORD-2024-1002',
    status: TaskStatus.CLAIMED,
    assigneeId: bob.id,
    priority: Priority.NORMAL,
    inputData: {
      ORDER_ITEMS: [
        { name: 'Laptop Stand', quantity: 1, price: 129.00 },
        { name: 'Desk Lamp', quantity: 1, price: 59.99 },
      ],
      SHIPPING_ADDRESS: '456 Oak Avenue, Portland, OR 97201',
    },
    contextData: {
      ORDER_ID: 'ORD-2024-1002',
      CUSTOMER_NAME: 'Sarah Williams',
      TRANSACTION_ID: 'TXN-abc123ef',
    },
    submissionData: {},
    dueDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
  });

  console.log('Seed complete:');
  console.log('  5 groups: loan-officers, hr-team, order-reviewers, warehouse, customer-service');
  console.log('  2 roles: admin, task-user');
  console.log('  4 users: alice (admin), bob (loan officer + warehouse), carol (customer service), service (worker)');
  console.log(`  1 dev API key (name "dev-worker"): ${DEV_API_KEY}`);
  console.log('  4 forms: LOAN_APPLICATION, ORDER_APPROVAL, SHIPMENT_CONFIRMATION, ORDER_EXCEPTION');
  console.log('  2 processes: Loan Processing, Order Fulfillment');
  console.log('  4 task definitions: REVIEW_LOAN, APPROVE_ORDER, CONFIRM_SHIPMENT, HANDLE_EXCEPTION');
  console.log('  4 tasks: 2 loan tasks, 2 order tasks');

  await db.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
