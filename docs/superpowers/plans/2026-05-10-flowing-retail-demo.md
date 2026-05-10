# Flowing Retail Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-step order fulfillment workflow that showcases orchestration, human tasks routed to different teams, and saga compensation — living alongside the existing loan approval demo.

**Architecture:** Single `orderFulfillmentWorkflow` using Temporal's saga pattern with `createTaskAndWait` for human tasks and `proxyActivities` for automated payment/refund steps. Seed script extended with new forms, task definitions, groups, and sample data.

**Tech Stack:** TypeScript, Temporal SDK (`@temporalio/workflow`), Flowstile SDK (`createTaskAndWait`), existing Fastify server seed script.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/worker/src/order-fulfillment/activities.ts` | Payment activities: processPayment, refundPayment, cancelShipment |
| `packages/worker/src/order-fulfillment/workflow.ts` | Workflow definition + types + saga orchestration |
| `packages/worker/src/start-order-workflow.ts` | Demo starter script |
| `packages/worker/src/workflows.ts` (modify) | Re-export orderFulfillmentWorkflow |
| `packages/worker/src/activities.ts` (modify) | Re-export order fulfillment activities |
| `packages/server/src/seed.ts` (modify) | Add forms, task defs, groups, users, sample tasks |

---

### Task 1: Order Fulfillment Activities

**Files:**
- Create: `packages/worker/src/order-fulfillment/activities.ts`
- Modify: `packages/worker/src/activities.ts`

- [ ] **Step 1: Create the activities file**

```typescript
// packages/worker/src/order-fulfillment/activities.ts

export interface PaymentInput {
  orderId: string;
  amount: number;
  customerEmail: string;
}

export interface PaymentResult {
  transactionId: string;
  amount: number;
  status: 'charged';
}

export interface RefundResult {
  status: 'refunded';
}

export interface CancelShipmentResult {
  status: 'cancelled';
}

export async function processPayment(input: PaymentInput): Promise<PaymentResult> {
  // Simulated payment — always succeeds with artificial delay
  await new Promise((resolve) => setTimeout(resolve, 500));
  const transactionId = `TXN-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`[Payment] Charged $${input.amount} for order ${input.orderId} → ${transactionId}`);
  return { transactionId, amount: input.amount, status: 'charged' };
}

export async function refundPayment(orderId: string): Promise<RefundResult> {
  // Compensation: idempotent refund
  console.log(`[Payment] Refunded order ${orderId}`);
  return { status: 'refunded' };
}

export async function cancelShipment(orderId: string): Promise<CancelShipmentResult> {
  // Compensation: no-op in demo (shipment never dispatched)
  console.log(`[Shipment] Cancelled shipment for order ${orderId}`);
  return { status: 'cancelled' };
}
```

- [ ] **Step 2: Add re-export in top-level activities**

Add to the end of `packages/worker/src/activities.ts`:

```typescript
export { processPayment, refundPayment, cancelShipment } from './order-fulfillment/activities.js';
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @flowstile/worker build`
Expected: Successful compilation with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/order-fulfillment/activities.ts packages/worker/src/activities.ts
git commit -m "feat(worker): add order fulfillment payment activities"
```

---

### Task 2: Order Fulfillment Workflow

**Files:**
- Create: `packages/worker/src/order-fulfillment/workflow.ts`
- Modify: `packages/worker/src/workflows.ts`

- [ ] **Step 1: Create the workflow file**

```typescript
// packages/worker/src/order-fulfillment/workflow.ts
import {
  proxyActivities,
  CancellationScope,
  log,
} from '@temporalio/workflow';
import { createTaskAndWait } from '@flowstile/sdk/workflows';
import type * as orderActivities from './activities.js';

const {
  processPayment,
  refundPayment,
  cancelShipment,
} = proxyActivities<typeof orderActivities>({
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 3 },
});

// --- Types ---

export interface OrderInput {
  orderId: string;
  customerName: string;
  customerEmail: string;
  shippingAddress: string;
  items: Array<{ name: string; quantity: number; price: number }>;
  total: number;
  approveOrderTaskDefId: string;
  confirmShipmentTaskDefId: string;
  handleExceptionTaskDefId: string;
}

export type OrderResult =
  | { status: 'shipped'; orderId: string; trackingNumber: string }
  | { status: 'rejected'; orderId: string; reason: string };

interface ApprovalDecision extends Record<string, unknown> {
  DECISION: 'APPROVED' | 'REJECTED';
  REASON: string;
}

interface ShipmentDecision extends Record<string, unknown> {
  DECISION: 'CONFIRMED' | 'REJECTED';
  REASON: string;
  TRACKING_NUMBER: string;
}

interface ExceptionResolution extends Record<string, unknown> {
  RESOLUTION: string;
  NOTES: string;
}

// --- Workflow ---

export async function orderFulfillmentWorkflow(input: OrderInput): Promise<OrderResult> {
  const compensations: Array<() => Promise<void>> = [];

  try {
    // Step 1: Human approval (order-reviewers)
    log.info('Waiting for order approval', { orderId: input.orderId });
    const approval = await createTaskAndWait<ApprovalDecision>({
      taskDefinitionId: input.approveOrderTaskDefId,
      processInstanceId: input.orderId,
      priority: 'high',
      inputData: {
        ORDER_ITEMS: input.items,
        TOTAL: input.total,
        CUSTOMER_EMAIL: input.customerEmail,
      },
      contextData: {
        ORDER_ID: input.orderId,
        CUSTOMER_NAME: input.customerName,
      },
    });

    if (approval.data.DECISION === 'REJECTED') {
      log.info('Order rejected at approval', { orderId: input.orderId, reason: approval.data.REASON });
      return { status: 'rejected', orderId: input.orderId, reason: approval.data.REASON };
    }

    // Step 2: Process payment (automated)
    log.info('Processing payment', { orderId: input.orderId, amount: input.total });
    compensations.push(() => refundPayment(input.orderId));
    const payment = await processPayment({
      orderId: input.orderId,
      amount: input.total,
      customerEmail: input.customerEmail,
    });

    // Step 3: Warehouse confirmation (warehouse group)
    log.info('Waiting for shipment confirmation', { orderId: input.orderId });
    compensations.push(() => cancelShipment(input.orderId));
    const shipment = await createTaskAndWait<ShipmentDecision>({
      taskDefinitionId: input.confirmShipmentTaskDefId,
      processInstanceId: input.orderId,
      priority: 'normal',
      inputData: {
        ORDER_ITEMS: input.items,
        SHIPPING_ADDRESS: input.shippingAddress,
      },
      contextData: {
        ORDER_ID: input.orderId,
        CUSTOMER_NAME: input.customerName,
        TRANSACTION_ID: payment.transactionId,
      },
    });

    if (shipment.data.DECISION === 'REJECTED') {
      log.info('Order rejected at warehouse — running saga compensation', {
        orderId: input.orderId,
        reason: shipment.data.REASON,
      });

      // Business rejection: compensate and route to customer service
      await CancellationScope.nonCancellable(async () => {
        for (const compensate of compensations.reverse()) {
          try {
            await compensate();
          } catch (e) {
            log.warn('Compensation failed', { error: e });
          }
        }

        // Handle exception (customer-service group)
        await createTaskAndWait<ExceptionResolution>({
          taskDefinitionId: input.handleExceptionTaskDefId,
          processInstanceId: input.orderId,
          priority: 'urgent',
          inputData: {
            REASON: shipment.data.REASON,
            REFUNDED: true,
          },
          contextData: {
            ORDER_ID: input.orderId,
            CUSTOMER_NAME: input.customerName,
            CUSTOMER_EMAIL: input.customerEmail,
          },
        });
      });

      return { status: 'rejected', orderId: input.orderId, reason: shipment.data.REASON };
    }

    log.info('Order fulfilled', { orderId: input.orderId, trackingNumber: shipment.data.TRACKING_NUMBER });
    return { status: 'shipped', orderId: input.orderId, trackingNumber: shipment.data.TRACKING_NUMBER };
  } catch (err) {
    // Unexpected errors: compensate and re-throw
    log.error('Unexpected error in order fulfillment — running compensation', { error: err });
    await CancellationScope.nonCancellable(async () => {
      for (const compensate of compensations.reverse()) {
        try {
          await compensate();
        } catch (e) {
          log.warn('Compensation failed', { error: e });
        }
      }
    });
    throw err;
  }
}
```

- [ ] **Step 2: Add re-export in top-level workflows.ts**

Add at the end of `packages/worker/src/workflows.ts`:

```typescript
export { orderFulfillmentWorkflow } from './order-fulfillment/workflow.js';
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @flowstile/worker build`
Expected: Successful compilation with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/order-fulfillment/workflow.ts packages/worker/src/workflows.ts
git commit -m "feat(worker): add orderFulfillmentWorkflow with saga compensation"
```

---

### Task 3: Seed Data — Groups, Users, Forms, Task Definitions, Sample Tasks

**Files:**
- Modify: `packages/server/src/seed.ts`

- [ ] **Step 1: Add new groups after existing groups**

After the line `const hrTeam = await db.getRepository(Group).save({ name: 'hr-team' });`, add:

```typescript
  const orderReviewers = await db.getRepository(Group).save({ name: 'order-reviewers' });
  const warehouse = await db.getRepository(Group).save({ name: 'warehouse' });
  const customerService = await db.getRepository(Group).save({ name: 'customer-service' });
```

- [ ] **Step 2: Update alice and bob group assignments, add carol**

Change Alice's `groups` array from `[loanOfficers]` to `[loanOfficers, orderReviewers]`.

Change Bob's `groups` array from `[loanOfficers]` to `[loanOfficers, warehouse]`.

Add carol after the service user:

```typescript
  const carol = await db.getRepository(User).save({
    email: 'carol@example.com',
    displayName: 'Carol Davis',
    passwordHash: devHash,
    groups: [customerService],
    roles: [taskUserRole],
  });
```

- [ ] **Step 3: Add Order Fulfillment forms**

After the loan form section, add:

```typescript
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
```

- [ ] **Step 4: Add process definition and task definitions**

After the loan process/task definition section, add:

```typescript
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
```

- [ ] **Step 5: Add sample order tasks**

After the existing loan sample tasks, add:

```typescript
  // Sample order tasks (pre-seeded for immediate demo)
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
```

- [ ] **Step 6: Update the console.log summary at the end**

Replace the existing summary with:

```typescript
  console.log('Seed complete:');
  console.log('  5 groups: loan-officers, hr-team, order-reviewers, warehouse, customer-service');
  console.log('  2 roles: admin, task-user');
  console.log('  4 users: alice (admin), bob (loan officer + warehouse), carol (customer service), service (worker)');
  console.log('  4 forms: LOAN_APPLICATION, ORDER_APPROVAL, SHIPMENT_CONFIRMATION, ORDER_EXCEPTION');
  console.log('  2 processes: Loan Processing, Order Fulfillment');
  console.log('  4 task definitions: REVIEW_LOAN, APPROVE_ORDER, CONFIRM_SHIPMENT, HANDLE_EXCEPTION');
  console.log('  4 tasks: 2 loan tasks, 2 order tasks');
```

- [ ] **Step 7: Verify build**

Run: `pnpm --filter @flowstile/server build`
Expected: Successful compilation with no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/seed.ts
git commit -m "feat(server): add Order Fulfillment seed data (forms, tasks, groups, carol)"
```

---

### Task 4: Demo Starter Script

**Files:**
- Create: `packages/worker/src/start-order-workflow.ts`

- [ ] **Step 1: Create the start script**

```typescript
// packages/worker/src/start-order-workflow.ts
import 'dotenv/config';
import { Connection, Client } from '@temporalio/client';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = process.env.TASK_QUEUE ?? 'flowstile';
const FLOWSTILE_SERVER_URL = process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000';

async function main() {
  // Authenticate with Flowstile server
  const loginRes = await fetch(`${FLOWSTILE_SERVER_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.FLOWSTILE_EMAIL ?? 'service@flowstile.local',
      password: process.env.FLOWSTILE_PASSWORD ?? 'password',
    }),
  });
  if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status}`);

  const setCookie = loginRes.headers.get('set-cookie') ?? '';
  const tokenMatch = setCookie.match(/flowstile_token=([^;]+)/);
  if (!tokenMatch) throw new Error('No token in login response');
  const token = tokenMatch[1];

  // Find the Order Fulfillment process and its task definitions
  const processRes = await fetch(`${FLOWSTILE_SERVER_URL}/processes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!processRes.ok) throw new Error(`Failed to fetch processes: ${processRes.status}`);
  const processes = (await processRes.json()) as { items: { id: string; name: string }[] };
  const orderProcess = processes.items.find((p) => p.name === 'Order Fulfillment');
  if (!orderProcess) throw new Error('Order Fulfillment process not found — run db:seed first');

  const taskDefsRes = await fetch(`${FLOWSTILE_SERVER_URL}/processes/${orderProcess.id}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!taskDefsRes.ok) throw new Error(`Failed to fetch task definitions: ${taskDefsRes.status}`);
  const taskDefs = (await taskDefsRes.json()) as { items: { id: string; code: string }[] };

  const approveOrder = taskDefs.items.find((td) => td.code === 'APPROVE_ORDER');
  const confirmShipment = taskDefs.items.find((td) => td.code === 'CONFIRM_SHIPMENT');
  const handleException = taskDefs.items.find((td) => td.code === 'HANDLE_EXCEPTION');

  if (!approveOrder || !confirmShipment || !handleException) {
    throw new Error('Missing task definitions — run db:seed first');
  }

  console.log('Found task definitions:');
  console.log(`  APPROVE_ORDER:     ${approveOrder.id}`);
  console.log(`  CONFIRM_SHIPMENT:  ${confirmShipment.id}`);
  console.log(`  HANDLE_EXCEPTION:  ${handleException.id}`);

  // Start the workflow
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection });

  const orderId = `ORD-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;

  const handle = await client.workflow.start('orderFulfillmentWorkflow', {
    taskQueue: TASK_QUEUE,
    workflowId: `order-fulfillment-${orderId}`,
    args: [{
      orderId,
      customerName: 'Alex Thompson',
      customerEmail: 'alex.t@example.com',
      shippingAddress: '742 Evergreen Terrace, Springfield, IL 62704',
      items: [
        { name: 'Mechanical Keyboard', quantity: 1, price: 149.99 },
        { name: 'Monitor Arm', quantity: 1, price: 89.99 },
        { name: 'Webcam', quantity: 1, price: 69.99 },
      ],
      total: 309.97,
      approveOrderTaskDefId: approveOrder.id,
      confirmShipmentTaskDefId: confirmShipment.id,
      handleExceptionTaskDefId: handleException.id,
    }],
  });

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ORDER FULFILLMENT WORKFLOW STARTED`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Workflow ID:  ${handle.workflowId}`);
  console.log(`  Order ID:     ${orderId}`);
  console.log(`  Customer:     Alex Thompson`);
  console.log(`  Total:        $309.97`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`  DEMO STEPS:`);
  console.log(`  1. Login as alice@example.com / password`);
  console.log(`     → Approve the order (or reject to exit early)`);
  console.log(`  2. Login as bob@example.com / password`);
  console.log(`     → Confirm shipment with tracking number`);
  console.log(`     → OR reject to trigger saga compensation`);
  console.log(`  3. (If rejected) Login as carol@example.com / password`);
  console.log(`     → Handle the customer exception`);
  console.log(`${'═'.repeat(60)}\n`);
  console.log('Waiting for workflow to complete...\n');

  const result = await handle.result();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  WORKFLOW COMPLETED`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Result:`, JSON.stringify(result, null, 2));
  console.log(`${'═'.repeat(60)}\n`);

  await connection.close();
}

main().catch((err) => {
  console.error('Failed to start workflow:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @flowstile/worker build`
Expected: Successful compilation with no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/start-order-workflow.ts
git commit -m "feat(worker): add start-order-workflow demo script"
```

---

### Task 5: End-to-End Verification

**Files:** None (verification only)

- [ ] **Step 1: Rebuild all packages**

Run: `pnpm build`
Expected: All packages compile successfully.

- [ ] **Step 2: Run server tests**

Run: `pnpm --filter @flowstile/server test`
Expected: All 28 existing tests pass (no regressions from seed changes — tests don't use seed).

- [ ] **Step 3: Run the seed script (requires running database)**

Run: `pnpm --filter @flowstile/server db:seed`
Expected: Output shows "5 groups", "4 users", "4 forms", "2 processes", "4 task definitions", "4 tasks".

If the database is not available (Docker not running), skip this step and note it as a manual verification.

- [ ] **Step 4: Commit (if any fixes were needed)**

Only if previous steps required changes. Otherwise, skip.
