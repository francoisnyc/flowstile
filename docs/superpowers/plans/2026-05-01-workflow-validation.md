# Workflow Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the end-to-end Flowstile signal loop: Temporal workflow creates a human task via SDK → user completes it in the inbox UI → workflow resumes with form data.

**Architecture:** Extend existing JWT auth to accept Bearer tokens (for service-to-service calls). Add auth support to the SDK client so the worker can authenticate with the Flowstile server. Add a sample loan approval workflow and a script to start it.

**Tech Stack:** TypeScript, Fastify, Temporal, @flowstile/sdk, @flowstile/worker

## File Structure

```
packages/
├── server/
│   └── src/
│       ├── plugins/auth.ts          — MODIFY: add Bearer token extraction
│       └── seed.ts                  — MODIFY: add service account user
├── sdk/
│   └── src/
│       ├── types.ts                 — MODIFY: add auth to FlowstileClientOptions
│       ├── client.ts                — MODIFY: add login + JWT caching
│       └── activities.ts            — MODIFY: pass auth to configureFlowstileActivities
└── worker/
    ├── package.json                 — MODIFY: add @temporalio/client dependency
    └── src/
        ├── workflows.ts             — MODIFY: add loanApprovalWorkflow
        ├── main.ts                  — MODIFY: pass auth config
        └── start-loan-workflow.ts   — CREATE: script to start a workflow
```

---

## Task 1: Server — Bearer Token Auth

**Files:**
- Modify: `packages/server/src/plugins/auth.ts:28-31`

- [ ] **Step 1: Update JWT registration to extract tokens from both cookie and Authorization header**

Replace the `fastifyJwt` registration in `packages/server/src/plugins/auth.ts`:

```typescript
  await app.register(fastifyJwt, {
    secret: jwtSecret,
    cookie: { cookieName: 'flowstile_token', signed: false },
    extractToken: (request: FastifyRequest) => {
      // Cookie first (browser), then Authorization header (SDK/service)
      const cookie = request.cookies?.flowstile_token;
      if (cookie) return cookie;
      const auth = request.headers.authorization;
      if (auth?.startsWith('Bearer ')) return auth.slice(7);
      return undefined;
    },
  });
```

- [ ] **Step 2: Verify existing auth still works**

Run: `pnpm --filter @flowstile/server test:integration`
Expected: All 47 tests PASS (cookie-based auth unchanged).

- [ ] **Step 3: Verify Bearer token auth works via curl**

```bash
# Login to get a JWT
TOKEN=$(curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"password"}' \
  -c - | grep flowstile_token | awk '{print $NF}')

# Use the JWT as a Bearer token (no cookie)
curl -s http://localhost:3000/auth/me \
  -H "Authorization: Bearer $TOKEN"
```

Expected: Returns alice's user object.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/plugins/auth.ts
git commit -m "feat(auth): accept JWT via Authorization Bearer header"
```

---

## Task 2: Seed — Service Account

**Files:**
- Modify: `packages/server/src/seed.ts:51-57`

- [ ] **Step 1: Add service account user after the bob user in seed.ts**

Add this after the `bob` user creation (after line 57):

```typescript
  const serviceUser = await db.getRepository(User).save({
    email: 'service@flowstile.local',
    displayName: 'Flowstile Service',
    passwordHash: devHash,
    roles: [taskUserRole],
  });
```

- [ ] **Step 2: Update the seed summary log**

Replace the existing summary block:

```typescript
  console.log('Seed complete:');
  console.log('  2 groups: loan-officers, hr-team');
  console.log('  2 roles: admin, task-user');
  console.log('  3 users: alice (admin), bob (loan officer), service (worker)');
  console.log('  1 form: LOAN_APPLICATION v1');
  console.log('  1 process: Loan Processing');
  console.log('  1 task definition: REVIEW_LOAN');
  console.log('  2 tasks: one unassigned, one claimed by Bob');
```

- [ ] **Step 3: Re-seed and verify**

Run: `cd packages/server && npx tsx src/seed.ts`
Expected: Prints updated summary with 3 users.

Verify:
```bash
curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"service@flowstile.local","password":"password"}'
```
Expected: Returns 200 with user object.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/seed.ts
git commit -m "feat(seed): add service account for worker auth"
```

---

## Task 3: SDK — Auth Support

**Files:**
- Modify: `packages/sdk/src/types.ts:50-52`
- Modify: `packages/sdk/src/client.ts`
- Modify: `packages/sdk/src/activities.ts`

- [ ] **Step 1: Add auth option to FlowstileClientOptions**

In `packages/sdk/src/types.ts`, replace the `FlowstileClientOptions` interface:

```typescript
export interface FlowstileClientOptions {
  baseUrl: string;
  auth?: { email: string; password: string };
}
```

- [ ] **Step 2: Add login and JWT caching to FlowstileClient**

Replace the entire contents of `packages/sdk/src/client.ts`:

```typescript
import type {
  FlowstileClientOptions,
  CreateTaskInput,
  Task,
} from './types.js';

export class FlowstileClient {
  private baseUrl: string;
  private auth?: { email: string; password: string };
  private jwt: string | null = null;

  constructor(options: FlowstileClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.auth = options.auth;
  }

  private async ensureAuth(): Promise<void> {
    if (this.jwt || !this.auth) return;

    const response = await fetch(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.auth),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Flowstile auth failed (${response.status}): ${body}`);
    }

    // Extract JWT from Set-Cookie header
    const setCookie = response.headers.get('set-cookie') ?? '';
    const match = setCookie.match(/flowstile_token=([^;]+)/);
    if (!match) {
      throw new Error('Flowstile auth: no token in Set-Cookie header');
    }
    this.jwt = match[1];
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    await this.ensureAuth();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...init?.headers as Record<string, string>,
    };
    if (this.jwt) {
      headers['Authorization'] = `Bearer ${this.jwt}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Flowstile API error ${response.status} on ${path}: ${body}`);
    }

    return response.json() as Promise<T>;
  }

  createTask(input: CreateTaskInput): Promise<Task> {
    return this.request<Task>('/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getTask(taskId: string): Promise<Task> {
    return this.request<Task>(`/tasks/${taskId}`);
  }

  cancelTask(taskId: string): Promise<Task> {
    return this.request<Task>(`/tasks/${taskId}/cancel`, { method: 'POST' });
  }
}
```

- [ ] **Step 3: Update configureFlowstileActivities to accept auth**

Replace the entire contents of `packages/sdk/src/activities.ts`:

```typescript
import { FlowstileClient } from './client.js';
import type { CreateTaskInput, Task, FlowstileClientOptions } from './types.js';

let _client: FlowstileClient | null = null;

/**
 * Call this once when starting your Temporal worker, before registering activities.
 *
 * Example:
 *   import { configureFlowstileActivities } from '@flowstile/sdk/activities';
 *   configureFlowstileActivities({
 *     baseUrl: 'http://localhost:3000',
 *     auth: { email: 'service@flowstile.local', password: 'password' },
 *   });
 */
export function configureFlowstileActivities(options: FlowstileClientOptions): void {
  _client = new FlowstileClient(options);
}

function client(): FlowstileClient {
  if (!_client) {
    throw new Error(
      'Flowstile activities are not configured. Call configureFlowstileActivities(options) before starting your worker.',
    );
  }
  return _client;
}

export async function createFlowstileTask(input: CreateTaskInput): Promise<Task> {
  return client().createTask(input);
}

export async function getFlowstileTask(taskId: string): Promise<Task> {
  return client().getTask(taskId);
}

export async function cancelFlowstileTask(taskId: string): Promise<Task> {
  return client().cancelTask(taskId);
}
```

- [ ] **Step 4: Update the index.ts export to include the new auth type**

In `packages/sdk/src/index.ts`, the `FlowstileClientOptions` type is already exported. No change needed.

- [ ] **Step 5: Build the SDK to verify it compiles**

Run: `pnpm --filter @flowstile/sdk build`
Expected: Compiles without errors.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk/src/types.ts packages/sdk/src/client.ts packages/sdk/src/activities.ts
git commit -m "feat(sdk): add auth support to FlowstileClient and activities"
```

---

## Task 4: Worker — Update Auth Config

**Files:**
- Modify: `packages/worker/src/main.ts`
- Modify: `packages/worker/package.json`

- [ ] **Step 1: Add @temporalio/client dependency to worker**

Run: `cd packages/worker && pnpm add @temporalio/client`

- [ ] **Step 2: Update worker main.ts to pass auth config**

Replace the entire contents of `packages/worker/src/main.ts`:

```typescript
import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as allActivities from './activities.js';

const FLOWSTILE_SERVER_URL = process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000';
const FLOWSTILE_EMAIL = process.env.FLOWSTILE_EMAIL ?? 'service@flowstile.local';
const FLOWSTILE_PASSWORD = process.env.FLOWSTILE_PASSWORD ?? 'password';
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = process.env.TASK_QUEUE ?? 'flowstile';

async function run() {
  const { configureFlowstileActivities, ...activities } = allActivities;
  configureFlowstileActivities({
    baseUrl: FLOWSTILE_SERVER_URL,
    auth: { email: FLOWSTILE_EMAIL, password: FLOWSTILE_PASSWORD },
  });

  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });

  const worker = await Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    workflowsPath: new URL('./workflows.js', import.meta.url).href,
    activities,
  });

  console.log(
    `Flowstile worker started — task queue: ${TASK_QUEUE}, Temporal: ${TEMPORAL_ADDRESS}`,
  );
  await worker.run();
}

run().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/main.ts packages/worker/package.json pnpm-lock.yaml
git commit -m "feat(worker): pass auth credentials to SDK activities"
```

---

## Task 5: Worker — Sample Loan Approval Workflow

**Files:**
- Modify: `packages/worker/src/workflows.ts`

- [ ] **Step 1: Add loanApprovalWorkflow to worker workflows**

Replace the entire contents of `packages/worker/src/workflows.ts`:

```typescript
// Re-export Flowstile SDK workflow functions. This file is the entry point
// Temporal bundles for the workflow sandbox — only @temporalio/workflow-safe
// imports are allowed here.
export { createTaskAndWait } from '@flowstile/sdk/workflows';

import { createTaskAndWait } from '@flowstile/sdk/workflows';

export interface LoanApprovalInput {
  taskDefinitionId: string;
  customerName: string;
  amount: number;
  processInstanceId: string;
}

export interface LoanApprovalResult {
  decision: string;
  notes: string | null;
  customerName: string;
  amount: number;
}

export async function loanApprovalWorkflow(
  input: LoanApprovalInput,
): Promise<LoanApprovalResult> {
  const result = await createTaskAndWait({
    taskDefinitionId: input.taskDefinitionId,
    processInstanceId: input.processInstanceId,
    priority: 'high',
    contextData: {
      CUSTOMER_NAME: input.customerName,
      APPLICATION_REFERENCE: input.processInstanceId,
    },
    inputData: {
      AMOUNT: input.amount,
    },
  });

  return {
    decision: result.data.DECISION as string,
    notes: (result.data.NOTES as string) ?? null,
    customerName: input.customerName,
    amount: input.amount,
  };
}
```

- [ ] **Step 2: Rebuild the SDK (worker depends on it)**

Run: `pnpm --filter @flowstile/sdk build`
Expected: Compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/workflows.ts
git commit -m "feat(worker): add loanApprovalWorkflow using createTaskAndWait"
```

---

## Task 6: Worker — Start Workflow Script

**Files:**
- Create: `packages/worker/src/start-loan-workflow.ts`

- [ ] **Step 1: Create the start script**

Create `packages/worker/src/start-loan-workflow.ts`:

```typescript
import 'dotenv/config';
import { Connection, Client } from '@temporalio/client';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = process.env.TASK_QUEUE ?? 'flowstile';
const FLOWSTILE_SERVER_URL = process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000';

async function main() {
  // Look up the REVIEW_LOAN task definition ID from the Flowstile server
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

  // Find the REVIEW_LOAN task definition
  const tasksRes = await fetch(`${FLOWSTILE_SERVER_URL}/tasks?status=created&limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  // We don't actually need to query tasks — we need the task definition ID.
  // The seed data creates a REVIEW_LOAN task definition. Query the process definitions
  // to find it, or just hardcode lookup via the tasks endpoint.

  // For simplicity, look up task definitions via a created task's taskDefinition
  const processRes = await fetch(`${FLOWSTILE_SERVER_URL}/processes`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!processRes.ok) throw new Error(`Failed to fetch processes: ${processRes.status}`);
  const processes = (await processRes.json()) as { items: { id: string; name: string }[] };
  const loanProcess = processes.items.find((p) => p.name === 'Loan Processing');
  if (!loanProcess) throw new Error('Loan Processing process not found — run db:seed first');

  const taskDefsRes = await fetch(`${FLOWSTILE_SERVER_URL}/processes/${loanProcess.id}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!taskDefsRes.ok) throw new Error(`Failed to fetch task definitions: ${taskDefsRes.status}`);
  const taskDefs = (await taskDefsRes.json()) as { items: { id: string; code: string }[] };
  const reviewLoan = taskDefs.items.find((td) => td.code === 'REVIEW_LOAN');
  if (!reviewLoan) throw new Error('REVIEW_LOAN task definition not found — run db:seed first');

  console.log(`Found REVIEW_LOAN task definition: ${reviewLoan.id}`);

  // Start the workflow
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection });

  const processInstanceId = `LN-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;

  const handle = await client.workflow.start('loanApprovalWorkflow', {
    taskQueue: TASK_QUEUE,
    workflowId: `loan-approval-${processInstanceId}`,
    args: [{
      taskDefinitionId: reviewLoan.id,
      customerName: 'John Doe',
      amount: 50000,
      processInstanceId,
    }],
  });

  console.log(`\nWorkflow started!`);
  console.log(`  Workflow ID: ${handle.workflowId}`);
  console.log(`  Process Instance: ${processInstanceId}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Open http://localhost:5173 and login as alice@example.com / password`);
  console.log(`  2. Find the task for ${processInstanceId} in the inbox`);
  console.log(`  3. Claim it, fill in the form, click Complete`);
  console.log(`  4. Watch the worker terminal — it will log the workflow result`);
  console.log(`\nWaiting for workflow to complete...`);

  const result = await handle.result();
  console.log(`\nWorkflow completed!`);
  console.log(`  Result:`, JSON.stringify(result, null, 2));

  await connection.close();
}

main().catch((err) => {
  console.error('Failed to start workflow:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/worker/src/start-loan-workflow.ts
git commit -m "feat(worker): add script to start loan approval workflow"
```

---

## Task 7: Server — Enable Temporal Connection in Dev

**Files:**
- Modify: `packages/server/.env`

- [ ] **Step 1: Add TEMPORAL_ADDRESS to the server .env**

Add this line to `packages/server/.env`:

```
TEMPORAL_ADDRESS=localhost:7233
```

This enables the Temporal plugin so the server sends completion signals when tasks are completed.

- [ ] **Step 2: Restart the server**

The tsx watch should pick up the .env change on restart. Kill and restart the server:

Run: `pnpm --filter @flowstile/server dev`

Expected: Server starts and connects to Temporal (if Temporal is running) or logs a warning (if not).

- [ ] **Step 3: No commit needed** (.env is gitignored)

---

## Task 8: End-to-End Verification

- [ ] **Step 1: Start Temporal dev server**

Run (Terminal 1): `temporal server start-dev`
Expected: Temporal starts on localhost:7233 with UI on localhost:8233.

- [ ] **Step 2: Re-seed the database**

Run: `cd packages/server && npx tsx src/seed.ts`
Expected: Seed completes with 3 users.

- [ ] **Step 3: Restart the Flowstile server**

Run (Terminal 2): `pnpm --filter @flowstile/server dev`
Expected: Server starts and connects to Temporal (no "Could not connect" warning).

- [ ] **Step 4: Verify the UI is running**

Open http://localhost:5173 in a browser. Login as alice@example.com / password.
Expected: Inbox loads with existing seed tasks.

- [ ] **Step 5: Build the SDK and start the worker**

Run: `pnpm --filter @flowstile/sdk build`
Run (Terminal 3): `pnpm --filter @flowstile/worker dev`
Expected: Worker starts and logs "Flowstile worker started".

- [ ] **Step 6: Start a loan approval workflow**

Run (Terminal 4): `npx tsx packages/worker/src/start-loan-workflow.ts`
Expected: Prints workflow ID and "Waiting for workflow to complete..."

- [ ] **Step 7: Complete the task in the UI**

1. Refresh the inbox in the browser
2. Find the new task (with the process instance ID from the script output)
3. Click the task to open the detail panel
4. Click "Claim"
5. Fill in DECISION (select APPROVED), optionally add NOTES
6. Click "Complete"

Expected: Terminal 4 prints:
```
Workflow completed!
  Result: {
    "decision": "APPROVED",
    "notes": "...",
    "customerName": "John Doe",
    "amount": 50000
  }
```

- [ ] **Step 8: Verify in Temporal UI**

Open http://localhost:8233 in a browser.
Expected: The workflow shows as "Completed" with the result data visible in the workflow history.

---

## Done

At the end of this plan you have:

- **Bearer token auth** — server accepts JWT via both cookie (browser) and Authorization header (SDK)
- **Service account** — `service@flowstile.local` user for worker authentication
- **SDK auth** — FlowstileClient logs in and caches JWT for service-to-service calls
- **Sample workflow** — `loanApprovalWorkflow` that creates a task and waits for human completion
- **Start script** — `start-loan-workflow.ts` to trigger the workflow and watch for results
- **Validated signal loop** — workflow → task creation → inbox → form completion → signal → workflow resumes
