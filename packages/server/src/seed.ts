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
  const underwriters = await db.getRepository(Group).save({ name: 'underwriters' });
  const managers = await db.getRepository(Group).save({ name: 'managers' });
  const finance = await db.getRepository(Group).save({ name: 'finance' });
  const peopleManagers = await db.getRepository(Group).save({ name: 'people-managers' });
  const hrReviewers = await db.getRepository(Group).save({ name: 'hr-reviewers' });

  // Roles
  const adminRole = await db.getRepository(Role).save({
    name: 'admin',
    permissions: ['forms:write', 'processes:write', 'processes:start', 'tasks:read', 'tasks:write', 'tasks:manage', 'cases:read', 'users:manage'],
  });
  const taskUserRole = await db.getRepository(Role).save({
    name: 'task-user',
    permissions: ['tasks:read', 'tasks:write', 'processes:start'],
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
  await db.getRepository(User).save({
    email: 'dave@example.com',
    displayName: 'Dave (Underwriter)',
    passwordHash: devHash,
    groups: [underwriters],
    roles: [taskUserRole],
  });
  await db.getRepository(User).save({
    email: 'erin@example.com',
    displayName: 'Erin (Manager)',
    passwordHash: devHash,
    groups: [managers],
    roles: [taskUserRole],
  });
  await db.getRepository(User).save({
    email: 'frank@example.com',
    displayName: 'Frank (Finance)',
    passwordHash: devHash,
    groups: [finance],
    roles: [taskUserRole],
  });
  await db.getRepository(User).save({
    email: 'mona@example.com',
    displayName: 'Mona (People Manager)',
    passwordHash: devHash,
    groups: [peopleManagers],
    roles: [taskUserRole],
  });
  await db.getRepository(User).save({
    email: 'helen@example.com',
    displayName: 'Helen (HR Reviewer)',
    passwordHash: devHash,
    groups: [hrReviewers],
    roles: [taskUserRole],
  });

  // Development service credential for the demo worker. The worker authenticates
  // with this token (FLOWSTILE_API_KEY) instead of a human login.
  await db.getRepository(ApiKey).save({
    name: 'dev-worker',
    keyHash: hashApiKey(DEV_API_KEY),
    prefix: DEV_API_KEY.slice(0, 12),
    permissions: ['tasks:read', 'tasks:write', 'processes:start'],
  });

  // Form: Loan Application Start (portal entry point — just the applicant's details)
  const loanStartForm = await db.getRepository(FormDefinition).save({
    code: 'LOAN_APPLICATION_START',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        CUSTOMER_NAME: { type: 'string' },
        AMOUNT: { type: 'number', minimum: 0 },
      },
      required: ['CUSTOMER_NAME', 'AMOUNT'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/CUSTOMER_NAME', label: 'Applicant Name' },
        { type: 'Control', scope: '#/properties/AMOUNT', label: 'Loan Amount' },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
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

  // Process: Loan Processing (portal-startable — users can submit a loan application from the UI)
  const loanProcess = await db.getRepository(ProcessDefinition).save({
    name: 'Loan Processing',
    startFormCode: loanStartForm.code,
    workflowType: 'loanApprovalWorkflow',
    taskQueue: 'flowstile',
  });

  // Task Definition: Review Loan
  const reviewLoan = await db.getRepository(TaskDefinition).save({
    code: 'REVIEW_LOAN',
    processDefinitionId: loanProcess.id,
    formDefinitionCode: loanForm.code,
    candidateGroups: ['loan-officers'],
    defaultPriority: Priority.HIGH,
  });

  // Process: Order Fulfillment — case plan: APPROVAL → PAYMENT → SHIPMENT
  // (PAYMENT is fully automated: no human tasks, achieved when shipment starts)
  const orderProcess = await db.getRepository(ProcessDefinition).save({
    name: 'Order Fulfillment',
    milestones: [
      { code: 'APPROVAL', name: 'Approval' },
      { code: 'PAYMENT', name: 'Payment' },
      { code: 'SHIPMENT', name: 'Shipment' },
    ],
  });

  // Task Definition: Approve Order
  const approveOrder = await db.getRepository(TaskDefinition).save({
    code: 'APPROVE_ORDER',
    processDefinitionId: orderProcess.id,
    formDefinitionCode: orderApprovalForm.code,
    milestoneCode: 'APPROVAL',
    candidateGroups: ['order-reviewers'],
    defaultPriority: Priority.HIGH,
  });

  // Task Definition: Confirm Shipment
  const confirmShipment = await db.getRepository(TaskDefinition).save({
    code: 'CONFIRM_SHIPMENT',
    processDefinitionId: orderProcess.id,
    formDefinitionCode: shipmentForm.code,
    milestoneCode: 'SHIPMENT',
    candidateGroups: ['warehouse'],
    defaultPriority: Priority.NORMAL,
  });

  // Task Definition: Handle Exception — off the happy path, deliberately unphased
  const handleException = await db.getRepository(TaskDefinition).save({
    code: 'HANDLE_EXCEPTION',
    processDefinitionId: orderProcess.id,
    formDefinitionCode: exceptionForm.code,
    milestoneCode: null,
    candidateGroups: ['customer-service'],
    defaultPriority: Priority.URGENT,
  });

  // ── Loan Origination ──────────────────────────────────────────────────────
  // Multi-stage approval demo: APPLICATION_REVIEW → CREDIT_ASSESSMENT (fully
  // automated, zero human tasks) → UNDERWRITING (rework loop + conditional
  // senior review above 50k) → FINAL_DECISION.

  const loanOriginationStartForm = await db.getRepository(FormDefinition).save({
    code: 'LOAN_ORIGINATION_START',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        CUSTOMER_NAME: { type: 'string' },
        AMOUNT: { type: 'number', minimum: 1 },
        PURPOSE: { type: 'string' },
      },
      required: ['CUSTOMER_NAME', 'AMOUNT', 'PURPOSE'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/CUSTOMER_NAME' },
        { type: 'Control', scope: '#/properties/AMOUNT' },
        { type: 'Control', scope: '#/properties/PURPOSE', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const loanApplicationReviewForm = await db.getRepository(FormDefinition).save({
    code: 'LOAN_APPLICATION_REVIEW',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        CUSTOMER_NAME: { type: 'string' },
        AMOUNT: { type: 'number' },
        PURPOSE: { type: 'string' },
        REWORK_REASON: { type: 'string' },
        DECISION: { type: 'string', enum: ['PROCEED', 'REJECT'] },
        NOTES: { type: 'string' },
      },
      required: ['CUSTOMER_NAME', 'AMOUNT', 'DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/CUSTOMER_NAME', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/AMOUNT', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/PURPOSE', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/REWORK_REASON', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/NOTES', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const loanRiskAssessmentForm = await db.getRepository(FormDefinition).save({
    code: 'LOAN_RISK_ASSESSMENT',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        CUSTOMER_NAME: { type: 'string' },
        AMOUNT: { type: 'number' },
        CREDIT_SCORE: { type: 'integer' },
        DECISION: { type: 'string', enum: ['APPROVE', 'REJECT', 'SEND_BACK'] },
        RATIONALE: { type: 'string' },
      },
      required: ['CUSTOMER_NAME', 'AMOUNT', 'CREDIT_SCORE', 'DECISION', 'RATIONALE'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/CUSTOMER_NAME', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/AMOUNT', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/CREDIT_SCORE', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/RATIONALE', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const loanSeniorReviewForm = await db.getRepository(FormDefinition).save({
    code: 'LOAN_SENIOR_REVIEW',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        AMOUNT: { type: 'number' },
        CREDIT_SCORE: { type: 'integer' },
        RISK_RATIONALE: { type: 'string' },
        DECISION: { type: 'string', enum: ['ENDORSE', 'REJECT'] },
        COMMENT: { type: 'string' },
      },
      required: ['AMOUNT', 'CREDIT_SCORE', 'DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/AMOUNT', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/CREDIT_SCORE', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/RISK_RATIONALE', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/COMMENT', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const loanFinalDecisionForm = await db.getRepository(FormDefinition).save({
    code: 'LOAN_FINAL_DECISION',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        CUSTOMER_NAME: { type: 'string' },
        AMOUNT: { type: 'number' },
        CREDIT_SCORE: { type: 'integer' },
        DECISION: { type: 'string', enum: ['APPROVED', 'DECLINED'] },
        APR: { type: 'number' },
        TERMS: { type: 'string' },
      },
      required: ['CUSTOMER_NAME', 'AMOUNT', 'DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/CUSTOMER_NAME', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/AMOUNT', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/CREDIT_SCORE', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/APR' },
        { type: 'Control', scope: '#/properties/TERMS', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const loanOriginationProcess = await db.getRepository(ProcessDefinition).save({
    name: 'Loan Origination',
    startFormCode: loanOriginationStartForm.code,
    workflowType: 'loanOriginationWorkflow',
    taskQueue: 'flowstile',
    milestones: [
      { code: 'APPLICATION_REVIEW', name: 'Application Review' },
      { code: 'CREDIT_ASSESSMENT', name: 'Credit Assessment' },
      { code: 'UNDERWRITING', name: 'Underwriting' },
      { code: 'FINAL_DECISION', name: 'Final Decision' },
    ],
  });

  await db.getRepository(TaskDefinition).save({
    code: 'LOAN_REVIEW_APPLICATION',
    processDefinitionId: loanOriginationProcess.id,
    formDefinitionCode: loanApplicationReviewForm.code,
    milestoneCode: 'APPLICATION_REVIEW',
    candidateGroups: ['loan-officers'],
    defaultPriority: Priority.HIGH,
  });

  await db.getRepository(TaskDefinition).save({
    code: 'LOAN_ASSESS_RISK',
    processDefinitionId: loanOriginationProcess.id,
    formDefinitionCode: loanRiskAssessmentForm.code,
    milestoneCode: 'UNDERWRITING',
    candidateGroups: ['underwriters'],
    defaultPriority: Priority.NORMAL,
  });

  await db.getRepository(TaskDefinition).save({
    code: 'LOAN_SENIOR_REVIEW',
    processDefinitionId: loanOriginationProcess.id,
    formDefinitionCode: loanSeniorReviewForm.code,
    milestoneCode: 'UNDERWRITING',
    candidateGroups: ['underwriters'],
    defaultPriority: Priority.HIGH,
  });

  await db.getRepository(TaskDefinition).save({
    code: 'LOAN_FINAL_DECISION',
    processDefinitionId: loanOriginationProcess.id,
    formDefinitionCode: loanFinalDecisionForm.code,
    milestoneCode: 'FINAL_DECISION',
    candidateGroups: ['loan-officers'],
    defaultPriority: Priority.NORMAL,
  });

  // ── Expense Approval ──────────────────────────────────────────────────────
  // Portal-startable reimbursement flow: MANAGER_REVIEW → FINANCE_REVIEW
  // (only when AMOUNT > 1000) → REIMBURSEMENT (fully automated, zero human
  // tasks — a Temporal activity records the reimbursement reference).

  const expenseStartForm = await db.getRepository(FormDefinition).save({
    code: 'EXPENSE_APPROVAL_START',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        EMPLOYEE_NAME: { type: 'string' },
        AMOUNT: { type: 'number', minimum: 0 },
        CATEGORY: { type: 'string', enum: ['TRAVEL', 'MEALS', 'EQUIPMENT', 'OTHER'] },
        DESCRIPTION: { type: 'string' },
      },
      required: ['EMPLOYEE_NAME', 'AMOUNT', 'CATEGORY', 'DESCRIPTION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/EMPLOYEE_NAME', label: 'Employee Name' },
        { type: 'Control', scope: '#/properties/AMOUNT', label: 'Amount' },
        { type: 'Control', scope: '#/properties/CATEGORY', label: 'Category' },
        { type: 'Control', scope: '#/properties/DESCRIPTION', label: 'Description', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const expenseManagerReviewForm = await db.getRepository(FormDefinition).save({
    code: 'EXPENSE_MANAGER_REVIEW',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        EMPLOYEE_NAME: { type: 'string' },
        AMOUNT: { type: 'number' },
        CATEGORY: { type: 'string', enum: ['TRAVEL', 'MEALS', 'EQUIPMENT', 'OTHER'] },
        DESCRIPTION: { type: 'string' },
        DECISION: { type: 'string', enum: ['APPROVE', 'REJECT'] },
        NOTES: { type: 'string' },
      },
      required: ['EMPLOYEE_NAME', 'AMOUNT', 'CATEGORY', 'DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/EMPLOYEE_NAME', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/AMOUNT', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/CATEGORY', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DESCRIPTION', options: { readonly: true, multi: true } },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/NOTES', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const expenseFinanceReviewForm = await db.getRepository(FormDefinition).save({
    code: 'EXPENSE_FINANCE_REVIEW',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        EMPLOYEE_NAME: { type: 'string' },
        AMOUNT: { type: 'number' },
        CATEGORY: { type: 'string', enum: ['TRAVEL', 'MEALS', 'EQUIPMENT', 'OTHER'] },
        MANAGER_DECISION: { type: 'string' },
        DECISION: { type: 'string', enum: ['APPROVE', 'REJECT'] },
        NOTES: { type: 'string' },
      },
      required: ['EMPLOYEE_NAME', 'AMOUNT', 'CATEGORY', 'DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/EMPLOYEE_NAME', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/AMOUNT', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/CATEGORY', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/MANAGER_DECISION', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/NOTES', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const expenseApprovalProcess = await db.getRepository(ProcessDefinition).save({
    name: 'Expense Approval',
    startFormCode: expenseStartForm.code,
    workflowType: 'expenseApprovalWorkflow',
    taskQueue: 'flowstile',
    milestones: [
      { code: 'MANAGER_REVIEW', name: 'Manager Review' },
      { code: 'FINANCE_REVIEW', name: 'Finance Review' },
      { code: 'REIMBURSEMENT', name: 'Reimbursement' },
    ],
  });

  await db.getRepository(TaskDefinition).save({
    code: 'EXPENSE_MANAGER_REVIEW',
    processDefinitionId: expenseApprovalProcess.id,
    formDefinitionCode: expenseManagerReviewForm.code,
    milestoneCode: 'MANAGER_REVIEW',
    candidateGroups: ['managers'],
    defaultPriority: Priority.HIGH,
  });

  await db.getRepository(TaskDefinition).save({
    code: 'EXPENSE_FINANCE_REVIEW',
    processDefinitionId: expenseApprovalProcess.id,
    formDefinitionCode: expenseFinanceReviewForm.code,
    milestoneCode: 'FINANCE_REVIEW',
    candidateGroups: ['finance'],
    defaultPriority: Priority.NORMAL,
  });

  // ── Vacation Leave Request ────────────────────────────────────────────────
  // Portal-startable leave flow: MANAGER_REVIEW → HR_REVIEW (only when DAYS > 10)
  // → LEDGER_UPDATE (trailing automated phase — a Temporal activity records a
  // deterministic leave reference; no human task, so the stepper reads it as
  // `skipped` once the case closes).

  const vacationStartForm = await db.getRepository(FormDefinition).save({
    code: 'VACATION_LEAVE_START',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        EMPLOYEE_NAME: { type: 'string' },
        START_DATE: { type: 'string' },
        END_DATE: { type: 'string' },
        DAYS: { type: 'number', minimum: 1 },
        REASON: { type: 'string' },
      },
      required: ['EMPLOYEE_NAME', 'START_DATE', 'END_DATE', 'DAYS', 'REASON'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/EMPLOYEE_NAME', label: 'Employee Name' },
        { type: 'Control', scope: '#/properties/START_DATE', label: 'Start Date' },
        { type: 'Control', scope: '#/properties/END_DATE', label: 'End Date' },
        { type: 'Control', scope: '#/properties/DAYS', label: 'Number of Days' },
        { type: 'Control', scope: '#/properties/REASON', label: 'Reason', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const vacationManagerReviewForm = await db.getRepository(FormDefinition).save({
    code: 'VACATION_MANAGER_REVIEW',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        EMPLOYEE_NAME: { type: 'string' },
        START_DATE: { type: 'string' },
        END_DATE: { type: 'string' },
        DAYS: { type: 'number' },
        REASON: { type: 'string' },
        DECISION: { type: 'string', enum: ['APPROVE', 'REJECT'] },
        NOTES: { type: 'string' },
      },
      required: ['EMPLOYEE_NAME', 'DAYS', 'DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/EMPLOYEE_NAME', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/START_DATE', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/END_DATE', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DAYS', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/REASON', options: { readonly: true, multi: true } },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/NOTES', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const vacationHrReviewForm = await db.getRepository(FormDefinition).save({
    code: 'VACATION_HR_REVIEW',
    version: 1,
    jsonSchema: {
      type: 'object',
      properties: {
        EMPLOYEE_NAME: { type: 'string' },
        DAYS: { type: 'number' },
        REASON: { type: 'string' },
        MANAGER_DECISION: { type: 'string' },
        DECISION: { type: 'string', enum: ['APPROVE', 'REJECT'] },
        NOTES: { type: 'string' },
      },
      required: ['EMPLOYEE_NAME', 'DAYS', 'DECISION'],
    },
    uiSchema: {
      type: 'VerticalLayout',
      elements: [
        { type: 'Control', scope: '#/properties/EMPLOYEE_NAME', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DAYS', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/REASON', options: { readonly: true, multi: true } },
        { type: 'Control', scope: '#/properties/MANAGER_DECISION', options: { readonly: true } },
        { type: 'Control', scope: '#/properties/DECISION' },
        { type: 'Control', scope: '#/properties/NOTES', options: { multi: true } },
      ],
    },
    status: FormDefinitionStatus.PUBLISHED,
  });

  const vacationProcess = await db.getRepository(ProcessDefinition).save({
    name: 'Vacation Leave Request',
    startFormCode: vacationStartForm.code,
    workflowType: 'vacationLeaveWorkflow',
    taskQueue: 'flowstile',
    milestones: [
      { code: 'MANAGER_REVIEW', name: 'Manager Review' },
      { code: 'HR_REVIEW', name: 'HR Review' },
      { code: 'LEDGER_UPDATE', name: 'Ledger Update' },
    ],
  });

  await db.getRepository(TaskDefinition).save({
    code: 'VACATION_MANAGER_REVIEW',
    processDefinitionId: vacationProcess.id,
    formDefinitionCode: vacationManagerReviewForm.code,
    milestoneCode: 'MANAGER_REVIEW',
    candidateGroups: ['people-managers'],
    defaultPriority: Priority.HIGH,
  });

  await db.getRepository(TaskDefinition).save({
    code: 'VACATION_HR_REVIEW',
    processDefinitionId: vacationProcess.id,
    formDefinitionCode: vacationHrReviewForm.code,
    milestoneCode: 'HR_REVIEW',
    candidateGroups: ['hr-reviewers'],
    defaultPriority: Priority.NORMAL,
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
  console.log('  10 groups: loan-officers, hr-team, order-reviewers, warehouse, customer-service, underwriters, managers, finance, people-managers, hr-reviewers');
  console.log('  2 roles: admin, task-user');
  console.log('  9 users: alice (admin), bob (loan officer + warehouse), carol (customer service), dave (underwriter), erin (manager), frank (finance), mona (people manager), helen (hr reviewer), service (worker)');
  console.log(`  1 dev API key (name "dev-worker"): ${DEV_API_KEY}`);
  console.log('  16 forms: ..., VACATION_LEAVE_START, VACATION_MANAGER_REVIEW, VACATION_HR_REVIEW');
  console.log('  5 processes: Loan Processing, Order Fulfillment, Loan Origination, Expense Approval, Vacation Leave Request');
  console.log('  12 task definitions: ..., VACATION_MANAGER_REVIEW, VACATION_HR_REVIEW');
  console.log('  4 tasks: 2 loan tasks, 2 order tasks');

  await db.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
