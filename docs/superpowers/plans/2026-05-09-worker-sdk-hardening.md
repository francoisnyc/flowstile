# Worker + SDK Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Worker and SDK with schema validation, reliable signal delivery, typed errors, enriched completion envelope, and better worker error messages.

**Architecture:** Four sequential improvements (A→D), each building on the previous. A adds ajv validation to the server's task endpoints. B extracts signal delivery into a retryable function. C enriches the SDK types, adds timeout/cancellation support, and typed errors. D improves worker startup error messages.

**Tech Stack:** ajv (JSON Schema validation), vitest (testing), Temporal SDK (`@temporalio/workflow`, `@temporalio/client`)

---

### Task 1: Schema validation utility

**Files:**
- Create: `packages/server/src/validation/schema-validator.ts`
- Create: `packages/server/test/unit/schema-validator.spec.ts`

- [ ] **Step 1: Install ajv**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/server add ajv
```

- [ ] **Step 2: Write failing tests for `validateAgainstSchema`**

Create `packages/server/test/unit/schema-validator.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  validateAgainstSchema,
  validateInputData,
} from '../../src/validation/schema-validator.js';

const testSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    amount: { type: 'number' },
    email: { type: 'string', format: 'email' },
  },
  required: ['name', 'amount'],
  additionalProperties: false,
};

describe('validateAgainstSchema', () => {
  it('returns valid for correct data', () => {
    const result = validateAgainstSchema(
      { name: 'Alice', amount: 100 },
      testSchema,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('returns errors for wrong types', () => {
    const result = validateAgainstSchema(
      { name: 123, amount: 'not-a-number' },
      testSchema,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThanOrEqual(2);
  });

  it('returns error for missing required fields', () => {
    const result = validateAgainstSchema({ name: 'Alice' }, testSchema);
    expect(result.valid).toBe(false);
    expect(result.errors!.some((e) => e.message?.includes('required'))).toBe(
      true,
    );
  });

  it('returns error for additional properties', () => {
    const result = validateAgainstSchema(
      { name: 'Alice', amount: 100, extra: 'field' },
      testSchema,
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors!.some((e) => e.message?.includes('additional')),
    ).toBe(true);
  });

  it('returns valid for empty data against schema with no required', () => {
    const optionalSchema = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    const result = validateAgainstSchema({}, optionalSchema);
    expect(result.valid).toBe(true);
  });
});

describe('validateInputData', () => {
  it('does not enforce required fields', () => {
    // inputData is partial — only type checks, no required enforcement
    const result = validateInputData({ amount: 100 }, testSchema);
    expect(result.valid).toBe(true);
  });

  it('still enforces type checks', () => {
    const result = validateInputData(
      { amount: 'not-a-number' },
      testSchema,
    );
    expect(result.valid).toBe(false);
  });

  it('still enforces additionalProperties', () => {
    const result = validateInputData({ extra: 'field' }, testSchema);
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/server test -- --run test/unit/schema-validator.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `schema-validator.ts`**

Create `packages/server/src/validation/schema-validator.ts`:

```typescript
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, coerceTypes: false });
addFormats(ajv);

export interface ValidationResult {
  valid: boolean;
  errors?: Array<{ path: string; message: string }>;
}

export function validateAgainstSchema(
  data: Record<string, unknown>,
  jsonSchema: Record<string, unknown>,
): ValidationResult {
  const validate = ajv.compile(jsonSchema);
  const valid = validate(data);
  if (valid) return { valid: true };
  return {
    valid: false,
    errors: (validate.errors ?? []).map((e) => ({
      path: e.instancePath || '/',
      message: e.message ?? 'unknown error',
    })),
  };
}

export function validateInputData(
  data: Record<string, unknown>,
  jsonSchema: Record<string, unknown>,
): ValidationResult {
  // inputData is partial — don't enforce required
  const lenientSchema = { ...jsonSchema };
  delete lenientSchema.required;
  return validateAgainstSchema(data, lenientSchema);
}
```

Note: Also install `ajv-formats` for format validation (e.g. `email`):

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/server add ajv-formats
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/server test -- --run test/unit/schema-validator.spec.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/validation/schema-validator.ts packages/server/test/unit/schema-validator.spec.ts packages/server/package.json pnpm-lock.yaml
git commit -m "feat(server): add JSON Schema validation utility with ajv"
```

---

### Task 2: Wire schema validation into task endpoints

**Files:**
- Modify: `packages/server/src/routes/tasks.ts`

**Context:** The `POST /tasks` endpoint (line 100-143) already looks up the published `FormDefinition` to get `form.version`. We add inputData validation after the form lookup. The `POST /tasks/:id/complete` endpoint (line 245-282) needs to look up the `FormDefinition` by version — currently it does NOT load the `taskDefinition` relation, so we need to add it.

- [ ] **Step 1: Add inputData validation to `POST /tasks`**

In `packages/server/src/routes/tasks.ts`, add the import at the top (after the existing imports, around line 10):

```typescript
import { validateAgainstSchema, validateInputData } from '../validation/schema-validator.js';
```

Then in the `POST /tasks` handler, after the form lookup (after line 126), before the `repo().save()` call (line 128), add validation:

```typescript
    // Validate inputData against the form's JSON Schema (lenient — no required enforcement)
    if (inputData && Object.keys(inputData).length > 0) {
      const validation = validateInputData(inputData, form.jsonSchema as Record<string, unknown>);
      if (!validation.valid) {
        return reply.code(422).send({
          error: 'inputData validation failed',
          details: validation.errors,
        });
      }
    }
```

- [ ] **Step 2: Add submissionData validation to `POST /tasks/:id/complete`**

In the complete endpoint (line 245-282), after the state machine transition (after line 262) and data merge (line 264), add form lookup and validation. The task currently doesn't load `taskDefinition`, so change the findOne call:

Replace line 252:
```typescript
      const task = await repo().findOne({ where: { id } });
```
with:
```typescript
      const task = await repo().findOne({
        where: { id },
        relations: ['taskDefinition'],
      });
```

Then after the data merge line (after `if (data) task.submissionData = { ...task.submissionData, ...data };`), add:

```typescript
      // Validate merged submissionData against the form's JSON Schema
      const form = await app.db.getRepository(FormDefinition).findOne({
        where: {
          code: task.taskDefinition.formDefinitionCode,
          version: task.formDefinitionVersion,
        },
      });
      if (form) {
        const validation = validateAgainstSchema(
          task.submissionData,
          form.jsonSchema as Record<string, unknown>,
        );
        if (!validation.valid) {
          return reply.code(422).send({
            error: 'submissionData validation failed',
            details: validation.errors,
          });
        }
      }
```

Note: If the form is not found (shouldn't happen — data integrity), we skip validation rather than blocking. The task was created with a valid version, so this is a defensive guard.

- [ ] **Step 3: Run existing tests to verify nothing broke**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/server test
```

Expected: All existing tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/tasks.ts
git commit -m "feat(server): validate inputData and submissionData against form JSON Schema"
```

---

### Task 3: Signal delivery with retry

**Files:**
- Create: `packages/server/src/signals/deliver-signal.ts`
- Create: `packages/server/test/unit/deliver-signal.spec.ts`

- [ ] **Step 1: Write failing tests for `deliverSignal`**

Create `packages/server/test/unit/deliver-signal.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliverSignal } from '../../src/signals/deliver-signal.js';

function createMockTemporal(signalFn: () => Promise<void>) {
  return {
    workflow: {
      getHandle: () => ({
        signal: signalFn,
      }),
    },
  };
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('deliverSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('delivers signal on first attempt', async () => {
    const signalFn = vi.fn().mockResolvedValue(undefined);
    const logger = createMockLogger();

    const result = await deliverSignal({
      temporal: createMockTemporal(signalFn) as any,
      workflowId: 'wf-1',
      signalName: 'flowstile:task:completed:task-1',
      payload: { data: { foo: 'bar' } },
      logger: logger as any,
    });

    expect(result).toBe(true);
    expect(signalFn).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalled();
  });

  it('retries on transient failure and succeeds', async () => {
    const signalFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(undefined);
    const logger = createMockLogger();

    const promise = deliverSignal({
      temporal: createMockTemporal(signalFn) as any,
      workflowId: 'wf-1',
      signalName: 'flowstile:task:completed:task-1',
      payload: { data: {} },
      logger: logger as any,
    });

    // Advance past retry delay
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result).toBe(true);
    expect(signalFn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('returns false after all retries exhausted', async () => {
    const signalFn = vi.fn().mockRejectedValue(new Error('down'));
    const logger = createMockLogger();

    const promise = deliverSignal({
      temporal: createMockTemporal(signalFn) as any,
      workflowId: 'wf-1',
      signalName: 'flowstile:task:completed:task-1',
      payload: { data: {} },
      logger: logger as any,
    });

    // Advance past all retry delays (1s + 2s)
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toBe(false);
    expect(signalFn).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalled();
  });

  it('does not retry WorkflowNotFoundError', async () => {
    class WorkflowNotFoundError extends Error {
      constructor() {
        super('workflow not found');
        this.name = 'WorkflowNotFoundError';
      }
    }
    const signalFn = vi
      .fn()
      .mockRejectedValue(new WorkflowNotFoundError());
    const logger = createMockLogger();

    const result = await deliverSignal({
      temporal: createMockTemporal(signalFn) as any,
      workflowId: 'wf-1',
      signalName: 'flowstile:task:completed:task-1',
      payload: { data: {} },
      logger: logger as any,
    });

    expect(result).toBe(false);
    expect(signalFn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('works with undefined payload (cancellation signals)', async () => {
    const signalFn = vi.fn().mockResolvedValue(undefined);
    const logger = createMockLogger();

    const result = await deliverSignal({
      temporal: createMockTemporal(signalFn) as any,
      workflowId: 'wf-1',
      signalName: 'flowstile:task:cancelled:task-1',
      payload: undefined,
      logger: logger as any,
    });

    expect(result).toBe(true);
    expect(signalFn).toHaveBeenCalledWith('flowstile:task:cancelled:task-1', undefined);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/server test -- --run test/unit/deliver-signal.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `deliver-signal.ts`**

Create `packages/server/src/signals/deliver-signal.ts`:

```typescript
import type { FastifyBaseLogger } from 'fastify';

interface DeliverSignalOptions {
  temporal: {
    workflow: {
      getHandle: (workflowId: string) => {
        signal: (signalName: string, payload?: unknown) => Promise<void>;
      };
    };
  };
  workflowId: string;
  signalName: string;
  payload?: unknown;
  logger: FastifyBaseLogger;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

export async function deliverSignal(
  options: DeliverSignalOptions,
): Promise<boolean> {
  const { temporal, workflowId, signalName, payload, logger } = options;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const handle = temporal.workflow.getHandle(workflowId);
      await handle.signal(signalName, payload);
      logger.info({ signalName, workflowId, attempt }, 'Signal delivered');
      return true;
    } catch (err) {
      // Don't retry if the workflow no longer exists
      if (err instanceof Error && err.name === 'WorkflowNotFoundError') {
        logger.warn(
          { signalName, workflowId },
          'Target workflow not found — may have already completed or been terminated',
        );
        return false;
      }

      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(
          { err, signalName, workflowId, attempt, nextRetryMs: delay },
          'Signal delivery failed, retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        logger.error(
          { err, signalName, workflowId, attempts: MAX_ATTEMPTS },
          'Signal delivery failed after all retries',
        );
      }
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/server test -- --run test/unit/deliver-signal.spec.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/signals/deliver-signal.ts packages/server/test/unit/deliver-signal.spec.ts
git commit -m "feat(server): add signal delivery with retry and backoff"
```

---

### Task 4: Wire `deliverSignal` into task complete and cancel endpoints

**Files:**
- Modify: `packages/server/src/routes/tasks.ts`

**Context:** Replace the inline try/catch signal code in `POST /tasks/:id/complete` (lines 268-278) with a call to `deliverSignal`. Add a cancellation signal to `POST /tasks/:id/cancel`.

- [ ] **Step 1: Replace inline signal code in `complete` endpoint**

In `packages/server/src/routes/tasks.ts`, add the import at the top:

```typescript
import { deliverSignal } from '../signals/deliver-signal.js';
```

Then replace the signal delivery block in the complete endpoint. Find this code (lines 268-278):

```typescript
      if (app.temporal && task.workflowId) {
        const payload = { data: task.submissionData };
        const signalName = `flowstile:task:completed:${task.id}`;
        try {
          await app.temporal
            .workflow.getHandle(task.workflowId)
            .signal(signalName, payload);
        } catch (err) {
          app.log.warn({ err, taskId: task.id }, 'Failed to send Temporal signal for completed task');
        }
      }
```

Replace it with:

```typescript
      if (app.temporal && task.workflowId) {
        const user = request.currentUser!;
        await deliverSignal({
          temporal: app.temporal,
          workflowId: task.workflowId,
          signalName: `flowstile:task:completed:${task.id}`,
          payload: {
            data: task.submissionData,
            completedBy: {
              id: user.id,
              email: user.email,
              displayName: user.displayName,
            },
            completedAt: savedTask.completedAt!.toISOString(),
            formVersion: task.formDefinitionVersion,
          },
          logger: request.log,
        });
      }
```

- [ ] **Step 2: Add cancellation signal to `cancel` endpoint**

In the `POST /tasks/:id/cancel` endpoint (lines 284-310), after `await repo().save(task);` (line 307), add:

```typescript
      if (app.temporal && task.workflowId) {
        await deliverSignal({
          temporal: app.temporal,
          workflowId: task.workflowId,
          signalName: `flowstile:task:cancelled:${task.id}`,
          payload: undefined,
          logger: request.log,
        });
      }
```

Note: The cancel endpoint needs to load `workflowId`. Check that the existing `findOne` (line 291) returns it — it does, `workflowId` is a regular column, not a relation.

- [ ] **Step 3: Run all tests**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/server test
```

Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/tasks.ts
git commit -m "feat(server): use deliverSignal with retry for completion and cancellation"
```

---

### Task 5: SDK error classes

**Files:**
- Create: `packages/sdk/src/errors.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Create error classes**

Create `packages/sdk/src/errors.ts`:

```typescript
export class TaskTimeoutError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly timeoutMs: number,
  ) {
    super(`Task ${taskId} was not completed within ${timeoutMs}ms`);
    this.name = 'TaskTimeoutError';
  }
}

export class TaskCancelledError extends Error {
  constructor(public readonly taskId: string) {
    super(`Task ${taskId} was cancelled`);
    this.name = 'TaskCancelledError';
  }
}

export class FlowstileApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly path: string,
    message: string,
  ) {
    super(`Flowstile API error ${statusCode} on ${path}: ${message}`);
    this.name = 'FlowstileApiError';
  }
}
```

- [ ] **Step 2: Update `FlowstileClient` to throw `FlowstileApiError`**

In `packages/sdk/src/client.ts`, add import at top:

```typescript
import { FlowstileApiError } from './errors.js';
```

Then replace lines 56-59:

```typescript
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Flowstile API error ${response.status} on ${path}: ${body}`);
    }
```

with:

```typescript
    if (!response.ok) {
      const body = await response.text();
      throw new FlowstileApiError(response.status, path, body);
    }
```

Also update the auth error in `ensureAuth()` (lines 26-29):

```typescript
    if (!response.ok) {
      const body = await response.text();
      throw new FlowstileApiError(response.status, '/auth/login', body);
    }
```

- [ ] **Step 3: Export errors from `index.ts`**

In `packages/sdk/src/index.ts`, add:

```typescript
export { TaskTimeoutError, TaskCancelledError, FlowstileApiError } from './errors.js';
```

- [ ] **Step 4: Build to verify types compile**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/sdk build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/sdk/src/errors.ts packages/sdk/src/client.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): add typed error classes (TaskTimeoutError, TaskCancelledError, FlowstileApiError)"
```

---

### Task 6: Enrich SDK types — completion envelope, cancellation signal, generics

**Files:**
- Modify: `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/index.ts`

- [ ] **Step 1: Update `TaskCompletedSignalPayload`**

In `packages/sdk/src/types.ts`, replace lines 55-58:

```typescript
// Signal payload sent by the server when a task is completed
export interface TaskCompletedSignalPayload {
  data: Record<string, unknown>;
}
```

with:

```typescript
// Signal payload sent by the server when a task is completed
export interface TaskCompletedSignalPayload {
  data: Record<string, unknown>;
  completedBy: { id: string; email: string; displayName: string };
  completedAt: string; // ISO 8601
  formVersion: number;
}
```

- [ ] **Step 2: Add generic to `TaskResult`**

Replace lines 45-48:

```typescript
export interface TaskResult {
  taskId: string;
  data: Record<string, unknown>;
}
```

with:

```typescript
export interface TaskResult<
  TOutput extends Record<string, unknown> = Record<string, unknown>,
> {
  taskId: string;
  data: TOutput;
  completedBy: { id: string; email: string; displayName: string };
  completedAt: string;
  formVersion: number;
}
```

- [ ] **Step 3: Add `timeoutMs` to `CreateTaskAndWaitInput`**

Replace lines 35-43:

```typescript
export interface CreateTaskAndWaitInput {
  taskDefinitionId: string;
  processInstanceId?: string;
  priority?: Priority;
  dueDate?: string;
  followUpDate?: string;
  inputData?: Record<string, unknown>;
  contextData?: Record<string, unknown>;
}
```

with:

```typescript
export interface CreateTaskAndWaitInput {
  taskDefinitionId: string;
  processInstanceId?: string;
  priority?: Priority;
  dueDate?: string;
  followUpDate?: string;
  inputData?: Record<string, unknown>;
  contextData?: Record<string, unknown>;
  /** Timeout in milliseconds. If the task is not completed within this time,
   *  a TaskTimeoutError is thrown and the task is cancelled (best-effort). */
  timeoutMs?: number;
}
```

- [ ] **Step 4: Add `taskCancelledSignalName`**

After the existing `taskCompletedSignalName` function (line 63), add:

```typescript

// Signal name convention: flowstile:task:cancelled:<taskId>
export function taskCancelledSignalName(taskId: string): string {
  return `flowstile:task:cancelled:${taskId}`;
}
```

- [ ] **Step 5: Update exports in `index.ts`**

In `packages/sdk/src/index.ts`, add `taskCancelledSignalName` to the value export line. Replace:

```typescript
export { taskCompletedSignalName } from './types.js';
```

with:

```typescript
export { taskCompletedSignalName, taskCancelledSignalName } from './types.js';
```

- [ ] **Step 6: Build to verify types compile**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/sdk build
```

Expected: Build succeeds.

- [ ] **Step 7: Commit**

```bash
git add packages/sdk/src/types.ts packages/sdk/src/index.ts
git commit -m "feat(sdk): enrich TaskResult with completion metadata, generics, and cancellation signal name"
```

---

### Task 7: Update `createTaskAndWait` — timeout, cancellation, enriched return

**Files:**
- Modify: `packages/sdk/src/workflows.ts`

**Context:** This is the core workflow function. It needs: (1) a generic type parameter, (2) cancellation signal handler, (3) timeout support via `condition()`, (4) enriched return value matching the new `TaskResult` shape.

- [ ] **Step 1: Rewrite `createTaskAndWait`**

Replace the entire contents of `packages/sdk/src/workflows.ts` with:

```typescript
import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
} from '@temporalio/workflow';
import type * as activities from './activities.js';
import type {
  CreateTaskAndWaitInput,
  TaskResult,
  TaskCompletedSignalPayload,
} from './types.js';
import { taskCompletedSignalName, taskCancelledSignalName } from './types.js';
import { TaskTimeoutError, TaskCancelledError } from './errors.js';

const {
  createFlowstileTask,
  cancelFlowstileTask,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

/**
 * Workflow function: creates a Flowstile task and durably waits for a human to
 * complete it. The workflow resumes when the Flowstile server sends the
 * `flowstile:task:completed:<taskId>` signal upon task completion.
 *
 * Usage inside a Temporal workflow:
 *
 *   import { createTaskAndWait } from '@flowstile/sdk/workflows';
 *
 *   interface MyOutput { DECISION: 'approved' | 'rejected'; NOTES: string }
 *   const result = await createTaskAndWait<MyOutput>({
 *     taskDefinitionId: 'my-task-def-uuid',
 *     inputData: { customerId },
 *     priority: 'high',
 *     timeoutMs: 24 * 60 * 60 * 1000, // 24 hours
 *   });
 *   // result.data.DECISION is typed
 *   // result.completedBy.email, result.completedAt available
 */
export async function createTaskAndWait<
  TOutput extends Record<string, unknown> = Record<string, unknown>,
>(
  input: CreateTaskAndWaitInput,
): Promise<TaskResult<TOutput>> {
  const { workflowId } = workflowInfo();

  const task = await createFlowstileTask({
    ...input,
    workflowId,
  });

  const completedSignal = defineSignal<[TaskCompletedSignalPayload]>(
    taskCompletedSignalName(task.id),
  );
  const cancelledSignal = defineSignal(
    taskCancelledSignalName(task.id),
  );

  let completionPayload: TaskCompletedSignalPayload | undefined;
  let cancelled = false;

  setHandler(completedSignal, (p) => {
    completionPayload = p;
  });
  setHandler(cancelledSignal, () => {
    cancelled = true;
  });

  const resolved = await condition(
    () => completionPayload !== undefined || cancelled,
    input.timeoutMs,
  );

  if (!resolved) {
    // Timed out — try to cancel the task so it doesn't sit in the inbox
    try {
      await cancelFlowstileTask(task.id);
    } catch {
      // Best effort — task may already be claimed/completed
    }
    throw new TaskTimeoutError(task.id, input.timeoutMs!);
  }

  if (cancelled) {
    throw new TaskCancelledError(task.id);
  }

  return {
    taskId: task.id,
    data: completionPayload!.data as TOutput,
    completedBy: completionPayload!.completedBy,
    completedAt: completionPayload!.completedAt,
    formVersion: completionPayload!.formVersion,
  };
}
```

- [ ] **Step 2: Build to verify it compiles**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/sdk build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/sdk/src/workflows.ts
git commit -m "feat(sdk): add timeout, cancellation, and enriched return to createTaskAndWait"
```

---

### Task 8: Update `loanApprovalWorkflow` to use new types

**Files:**
- Modify: `packages/worker/src/workflows.ts`

**Context:** The loan workflow currently casts `result.data.DECISION as string`. With generics, it can be typed properly. Also needs to handle the enriched `TaskResult`.

- [ ] **Step 1: Update the workflow**

Replace the entire contents of `packages/worker/src/workflows.ts` with:

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
  completedBy: string;
  completedAt: string;
}

interface LoanDecision {
  DECISION: string;
  NOTES: string;
}

export async function loanApprovalWorkflow(
  input: LoanApprovalInput,
): Promise<LoanApprovalResult> {
  const result = await createTaskAndWait<LoanDecision>({
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
    decision: result.data.DECISION,
    notes: result.data.NOTES ?? null,
    customerName: input.customerName,
    amount: input.amount,
    completedBy: result.completedBy.email,
    completedAt: result.completedAt,
  };
}
```

- [ ] **Step 2: Build to verify it compiles**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/worker build
```

Expected: Build succeeds. (May need `pnpm --filter @flowstile/sdk build` first if not already built.)

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/workflows.ts
git commit -m "feat(worker): update loanApprovalWorkflow to use typed generics and enriched result"
```

---

### Task 9: Worker startup error messages

**Files:**
- Modify: `packages/worker/src/main.ts`

**Context:** Currently the worker has a single `run().catch()` at the bottom. Add targeted error handling around each connection step with actionable messages.

- [ ] **Step 1: Rewrite `main.ts` with startup checks**

Replace the entire contents of `packages/worker/src/main.ts` with:

```typescript
import 'dotenv/config';
import { Worker, NativeConnection } from '@temporalio/worker';
import * as allActivities from './activities.js';

const FLOWSTILE_SERVER_URL =
  process.env.FLOWSTILE_SERVER_URL ?? 'http://localhost:3000';
const FLOWSTILE_EMAIL =
  process.env.FLOWSTILE_EMAIL ?? 'service@flowstile.local';
const FLOWSTILE_PASSWORD = process.env.FLOWSTILE_PASSWORD ?? 'password';
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = process.env.TASK_QUEUE ?? 'flowstile';

async function run() {
  // --- Step 1: Verify Flowstile server is reachable ---
  try {
    const resp = await fetch(`${FLOWSTILE_SERVER_URL}/health`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    console.error(
      `\nFailed to reach Flowstile server at ${FLOWSTILE_SERVER_URL}` +
        `\nIs the server running? Try: pnpm --filter @flowstile/server dev` +
        `\nError: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  }

  // --- Step 2: Configure Flowstile activities ---
  const { configureFlowstileActivities, ...activities } = allActivities;
  configureFlowstileActivities({
    baseUrl: FLOWSTILE_SERVER_URL,
    auth: { email: FLOWSTILE_EMAIL, password: FLOWSTILE_PASSWORD },
  });

  // --- Step 3: Connect to Temporal ---
  let connection: NativeConnection;
  try {
    connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
  } catch (err) {
    console.error(
      `\nFailed to connect to Temporal at ${TEMPORAL_ADDRESS}` +
        `\nIs the Temporal server running? Try: temporal server start-dev` +
        `\nError: ${err instanceof Error ? err.message : err}\n`,
    );
    process.exit(1);
  }

  // --- Step 4: Create and run worker ---
  const worker = await Worker.create({
    connection,
    taskQueue: TASK_QUEUE,
    workflowsPath: new URL('./workflows.ts', import.meta.url).pathname,
    activities,
  });

  console.log(
    `\nFlowstile worker started` +
      `\n  Temporal:  ${TEMPORAL_ADDRESS}` +
      `\n  Server:    ${FLOWSTILE_SERVER_URL}` +
      `\n  Auth:      ${FLOWSTILE_EMAIL}` +
      `\n  Queue:     ${TASK_QUEUE}` +
      `\n  Workflows: ./workflows.ts\n`,
  );

  await worker.run();
}

run().catch((err) => {
  console.error('Worker failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it builds**

```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/worker build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/main.ts
git commit -m "feat(worker): add startup health checks and actionable error messages"
```

---

### Task 10: End-to-end verification

**Files:** (no new files — manual verification)

- [ ] **Step 1: Run all unit tests across the monorepo**

```bash
cd /Users/francois/dev/flowstile && pnpm -r test
```

Expected: All tests pass.

- [ ] **Step 2: Build all packages**

```bash
cd /Users/francois/dev/flowstile && pnpm -r build
```

Expected: All packages build successfully.

- [ ] **Step 3: Start the server and manually test validation**

Start the server:
```bash
cd /Users/francois/dev/flowstile && pnpm --filter @flowstile/server dev
```

Test inputData validation with curl — create a task with invalid data:
```bash
# First, get a valid task definition ID and login token from the seed data
# Then POST with wrong-typed inputData
curl -X POST http://localhost:3000/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "taskDefinitionId": "<uuid>",
    "workflowId": "test-wf",
    "inputData": { "AMOUNT": "not-a-number" }
  }'
```

Expected: 422 response with `inputData validation failed` and error details.

- [ ] **Step 4: Verify worker startup error messages**

Start the worker with Temporal stopped:
```bash
cd /Users/francois/dev/flowstile && TEMPORAL_ADDRESS=localhost:9999 pnpm --filter @flowstile/worker dev
```

Expected: Clear error message about Temporal connection failure, not a raw stack trace.

Start the worker with server stopped:
```bash
cd /Users/francois/dev/flowstile && FLOWSTILE_SERVER_URL=http://localhost:9999 pnpm --filter @flowstile/worker dev
```

Expected: Clear error message about Flowstile server unreachable.

- [ ] **Step 5: Commit any fixes found during verification**

If any issues are found, fix them and commit with an appropriate message.
