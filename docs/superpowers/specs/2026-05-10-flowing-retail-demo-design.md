# Flowing Retail Demo for Flowstile

## Overview

Adapt Camunda's Flowing Retail showcase as a Flowstile demo: a multi-step order fulfillment workflow with human task touchpoints routed to different teams, automated payment processing, and saga compensation using Temporal's native pattern.

This demo lives alongside the existing loan approval workflow and serves as the flagship showcase for Flowstile's capabilities.

## Goals

- Demonstrate multi-step workflow orchestration with sequential human tasks
- Show task routing to different candidate groups (order-reviewers, warehouse, customer-service)
- Showcase Temporal's saga/compensation pattern triggered by human decisions
- Provide a realistic end-to-end demo people can clone, run, and understand

## Workflow: `orderFulfillmentWorkflow`

### Happy Path

```
Order placed
  → [order-reviewers] Approve Order (fraud/risk review)
  → Process Payment (automated activity)
  → [warehouse] Confirm Shipment (pick & pack)
  → Return: { status: 'shipped', trackingNumber }
```

### Rejection at Approval (Clean Exit)

```
Order placed
  → [order-reviewers] Approve Order → REJECTED
  → Return: { status: 'rejected', reason }
```

No compensation needed — nothing has happened yet.

### Rejection at Warehouse (Saga Compensation)

```
Order placed
  → Approve Order → APPROVED
  → Process Payment → success (payment taken)
  → [warehouse] Confirm Shipment → REJECTED
  → Saga triggers:
      1. refundPayment() (automated, reverses payment)
      2. [customer-service] Handle Exception (human resolves with customer)
  → Throw OrderRejectedError
```

### Saga Implementation

Uses Temporal's recommended pattern:

```typescript
const compensations: Array<() => Promise<void>> = [];

try {
  // Step 1: Human approval (no compensation registered — nothing to undo)
  const approval = await createTaskAndWait<ApprovalDecision>({ ... });
  if (approval.data.DECISION === 'REJECTED') {
    return { status: 'rejected', reason: approval.data.REASON, orderId: input.orderId };
  }

  // Step 2: Payment (register compensation BEFORE calling activity)
  compensations.push(() => refundPayment(input.orderId));
  const payment = await processPayment({ ... });

  // Step 3: Warehouse confirmation (register compensation BEFORE)
  compensations.push(() => cancelShipment(input.orderId));
  const shipment = await createTaskAndWait<ShipmentDecision>({ ... });
  if (shipment.data.DECISION === 'REJECTED') {
    throw new OrderRejectedError(input.orderId, shipment.data.REASON);
  }

  return { status: 'shipped', orderId: input.orderId, trackingNumber: shipment.data.TRACKING_NUMBER };
} catch (err) {
  await CancellationScope.nonCancellable(async () => {
    // Run compensations in reverse order
    for (const compensate of compensations.reverse()) {
      try { await compensate(); } catch (e) { log.warn('Compensation failed', { error: e }); }
    }
    // Route exception to customer service (only on warehouse rejection)
    if (err instanceof OrderRejectedError) {
      await createTaskAndWait<ExceptionResolution>({ ... });
    }
  });
  throw err;
}
```

Key points:
- Compensation registered BEFORE each step (handles activity-completes-but-fails-to-return edge case)
- Compensations run inside `CancellationScope.nonCancellable` (run even if workflow cancelled)
- Compensation failures are logged but don't block other compensations
- Handle Exception task fires inside nonCancellable so it always gets created

## Workflow Input/Output Types

```typescript
interface OrderInput {
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

type OrderResult =
  | { status: 'shipped'; orderId: string; trackingNumber: string }
  | { status: 'rejected'; orderId: string; reason: string };
```

## Automated Activities

### `processPayment(input: PaymentInput): Promise<PaymentResult>`

Simulated payment. Always succeeds. Returns `{ transactionId: "TXN-<uuid>", amount, status: "charged" }`. Adds ~500ms artificial delay for realism.

### `refundPayment(orderId: string): Promise<RefundResult>`

Compensation activity. Logs the refund. Returns `{ status: "refunded" }`. Idempotent.

### `cancelShipment(orderId: string): Promise<CancelResult>`

Compensation activity. No-op in demo (shipment never dispatched if warehouse rejected). Returns `{ status: "cancelled" }`. Idempotent.

All activities use `proxyActivities` with `startToCloseTimeout: '1 minute'` and `retry: { maximumAttempts: 3 }`.

## Form Definitions

### `ORDER_APPROVAL` (v1, PUBLISHED)

**JSON Schema:**
```json
{
  "type": "object",
  "properties": {
    "CUSTOMER_NAME": { "type": "string" },
    "ORDER_ID": { "type": "string" },
    "ORDER_ITEMS": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "quantity": { "type": "integer" },
          "price": { "type": "number" }
        }
      }
    },
    "TOTAL": { "type": "number" },
    "DECISION": { "type": "string", "enum": ["APPROVED", "REJECTED"] },
    "REASON": { "type": "string" }
  },
  "required": ["CUSTOMER_NAME", "ORDER_ID", "ORDER_ITEMS", "TOTAL", "DECISION"]
}
```

**UI Schema:** Vertical layout with all fields. DECISION as radio. REASON as multiline text.

### `SHIPMENT_CONFIRMATION` (v1, PUBLISHED)

**JSON Schema:**
```json
{
  "type": "object",
  "properties": {
    "ORDER_ID": { "type": "string" },
    "CUSTOMER_NAME": { "type": "string" },
    "ORDER_ITEMS": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string" },
          "quantity": { "type": "integer" },
          "price": { "type": "number" }
        }
      }
    },
    "SHIPPING_ADDRESS": { "type": "string" },
    "TRANSACTION_ID": { "type": "string" },
    "DECISION": { "type": "string", "enum": ["CONFIRMED", "REJECTED"] },
    "REASON": { "type": "string" },
    "TRACKING_NUMBER": { "type": "string" }
  },
  "required": ["ORDER_ID", "ORDER_ITEMS", "SHIPPING_ADDRESS", "DECISION"]
}
```

**UI Schema:** Vertical layout. DECISION as radio. TRACKING_NUMBER visible only when CONFIRMED. REASON visible only when REJECTED.

### `ORDER_EXCEPTION` (v1, PUBLISHED)

**JSON Schema:**
```json
{
  "type": "object",
  "properties": {
    "ORDER_ID": { "type": "string" },
    "CUSTOMER_NAME": { "type": "string" },
    "CUSTOMER_EMAIL": { "type": "string" },
    "REASON": { "type": "string" },
    "REFUNDED": { "type": "boolean" },
    "RESOLUTION": { "type": "string", "enum": ["CONTACTED", "RESHIPPED", "VOUCHER_ISSUED"] },
    "NOTES": { "type": "string" }
  },
  "required": ["ORDER_ID", "CUSTOMER_NAME", "REASON", "RESOLUTION"]
}
```

**UI Schema:** Vertical layout. RESOLUTION as radio. NOTES as multiline text.

## Task Definitions

| Code | Process | Form Code | Candidate Groups | Default Priority |
|------|---------|-----------|-----------------|-----------------|
| `APPROVE_ORDER` | Order Fulfillment | `ORDER_APPROVAL` | `order-reviewers` | HIGH |
| `CONFIRM_SHIPMENT` | Order Fulfillment | `SHIPMENT_CONFIRMATION` | `warehouse` | NORMAL |
| `HANDLE_EXCEPTION` | Order Fulfillment | `ORDER_EXCEPTION` | `customer-service` | URGENT |

## Process Definition

- **Name:** Order Fulfillment
- **Version:** 1
- **Status:** ACTIVE
- **Task Definitions:** APPROVE_ORDER, CONFIRM_SHIPMENT, HANDLE_EXCEPTION

## Seed Data

### New Groups

- `order-reviewers`
- `warehouse`
- `customer-service`

### New User

- **carol@example.com** — Display name: "Carol Davis", groups: `customer-service`, roles: `task-user`, password: "password"

### Existing User Updates

- alice@example.com — add to `order-reviewers` group
- bob@example.com — add to `warehouse` group

### Sample Tasks (pre-seeded for immediate demo)

1. **Unclaimed order approval** — Order #ORD-2024-1001, customer "Mike Johnson", 3 items (Wireless Headphones $79.99, USB-C Hub $45.00, Phone Case $24.99), total $149.98, status: CREATED, due: 2 days from seed
2. **Claimed shipment confirmation** — Order #ORD-2024-1002, customer "Sarah Williams", 2 items (Laptop Stand $129.00, Desk Lamp $59.99), total $188.99, assigned to bob, status: CLAIMED, due: 1 day from seed

## File Structure

### New Files

```
packages/worker/src/
  order-fulfillment/
    workflow.ts          — orderFulfillmentWorkflow, types, OrderRejectedError
    activities.ts        — processPayment, refundPayment, cancelShipment
  start-order-workflow.ts — demo starter script
```

### Modified Files

```
packages/worker/src/
  workflows.ts          — add: export { orderFulfillmentWorkflow } from './order-fulfillment/workflow.js'
  activities.ts         — add: export * from './order-fulfillment/activities.js'

packages/server/src/
  seed.ts              — add Order Fulfillment process, forms, task defs, groups, carol, sample tasks
```

### Unchanged

- `@flowstile/sdk` — no changes, `createTaskAndWait` already supports all needed features
- `@flowstile/server` routes/entities — no changes needed
- Existing loan approval demo — untouched

## Demo Script (`start-order-workflow.ts`)

1. Authenticates as service@flowstile.local
2. Fetches "Order Fulfillment" process and its task definition IDs
3. Starts `orderFulfillmentWorkflow` with sample order:
   - Customer: "Alex Thompson"
   - 3 items: Mechanical Keyboard ($149.99), Monitor Arm ($89.99), Webcam ($69.99)
   - Total: $309.97
   - Shipping: "742 Evergreen Terrace, Springfield, IL 62704"
4. Prints instructions:
   - Login as alice@example.com to approve order
   - Login as bob@example.com to confirm shipment (or reject to trigger saga)
   - If rejected: login as carol@example.com to handle exception
5. Waits for workflow result and logs outcome

## Temporal Sandbox Compatibility

The workflow file imports only:
- `@temporalio/workflow` APIs (proxyActivities, defineSignal, setHandler, condition, CancellationScope, log)
- `@flowstile/sdk/workflows` (createTaskAndWait — already workflow-safe)
- `./activities.js` as **type-only import** (for proxyActivities typing)
- Local error class (plain class, no I/O)

Activities are registered via re-export through top-level `activities.ts` and passed to the worker at startup.
