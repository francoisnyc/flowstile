# Worker + SDK Hardening

## Goal

Harden the Flowstile Worker and SDK packages with schema validation, reliable signal delivery, richer TypeScript ergonomics, and better error messages — without adding new infrastructure or changing the existing architecture.

## Scope

Four improvements in priority order:

| # | Area | What changes |
|---|------|-------------|
| A | Schema validation | Validate inputData and submissionData against the form's JSON Schema |
| B | Signal reliability | Retry signal delivery with exponential backoff |
| C | SDK ergonomics | Enriched completion envelope, typed errors, generics, timeout defaults |
| D | Worker DX | Better error messages in existing worker setup code |

## Non-goals

- No new `createWorker()` abstraction (existing setup is lean enough)
- No outbox/queue infrastructure (future upgrade — see design decisions)
- No changes to the form designer UI
- No new REST endpoints (only changes to existing ones)

---

## A. Schema Validation

### Problem

The server accepts any `inputData` on task creation and any `submissionData` on task completion. A workflow can create a task with data that doesn't match the form, and a user can submit a form missing required fields. The JSON Schema is stored but never enforced.

### Design

**Library:** [ajv](https://ajv.js.org/) — the standard JSON Schema validator for Node.js. Supports draft-07 which is what the form designer produces.

**Validation points:**

#### 1. Task creation (`POST /tasks`)

When a task is created with `inputData`, validate it against the published form's JSON Schema. The form is already looked up in this endpoint (to get `formDefinitionVersion`).

```
POST /tasks
  → look up TaskDefinition → find published FormDefinition (already done)
  → validate inputData against formDefinition.jsonSchema
  → if invalid: 422 { error: "inputData validation failed", details: ajv.errors }
  → if valid: create task (existing flow)
```

**Edge case:** `inputData` is optional. If omitted or `{}`, skip validation — the form will render with empty fields, which is a valid state. Only validate when data is provided and non-empty.

**Edge case:** The JSON Schema may have `additionalProperties: false`. If a workflow sends extra fields, that's a validation error. This is correct behavior — the schema is the contract.

#### 2. Task completion (`POST /tasks/:id/complete`)

When a task is completed with `submissionData`, validate it against the form's JSON Schema. The form version is stored on the task (`formDefinitionVersion`), so we look up that specific version.

```
POST /tasks/:id/complete
  → look up Task (already done)
  → look up FormDefinition by (task.taskDefinition.formDefinitionCode, task.formDefinitionVersion)
  → validate merged submissionData against formDefinition.jsonSchema
  → if invalid: 422 { error: "submissionData validation failed", details: ajv.errors }
  → if valid: complete task (existing flow)
```

**Merge order:** The current code merges `task.submissionData` (existing partial data) with the request body's `data`. Validation runs on the merged result — this is the final data being persisted.

**Required fields:** JSON Schema `required` array is enforced here. If the form says `amount` is required and it's missing from the merged submissionData, that's a 422.

### Implementation details

Create a shared validation utility:

```typescript
// packages/server/src/validation/schema-validator.ts

import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, coerceTypes: false });

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
```

**Where inputData validation is lenient:** `inputData` represents pre-populated fields. It's reasonable for inputData to be a partial match — it may only fill some fields. So for inputData validation, strip the `required` array from the schema before validating. Type/format checks still apply.

```typescript
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

### Error response format

```json
{
  "error": "inputData validation failed",
  "details": [
    { "path": "/amount", "message": "must be number" },
    { "path": "/email", "message": "must match format \"email\"" }
  ]
}
```

HTTP status: **422 Unprocessable Entity** (consistent with existing "no published form" error).

---

## B. Signal Reliability

### Problem

Signal delivery is fire-and-forget with a try/catch that logs a warning. If Temporal is briefly unreachable (network blip, GC pause, restart), the signal is lost and the workflow blocks forever.

### Design

Extract signal delivery into an isolated function and add retry with exponential backoff.

```typescript
// packages/server/src/signals/deliver-completion-signal.ts

interface DeliverSignalOptions {
  temporal: TemporalClient;
  workflowId: string;
  taskId: string;
  payload: TaskCompletedSignalPayload;
  logger: FastifyBaseLogger;
}

export async function deliverSignal(
  options: DeliverSignalOptions,
): Promise<boolean> {
  const { temporal, workflowId, taskId, payload, logger } = options;
  const signalName = `flowstile:task:completed:${taskId}`;

  const maxAttempts = 3;
  const baseDelayMs = 1000; // 1s, 2s, 4s

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await temporal.workflow
        .getHandle(workflowId)
        .signal(signalName, payload);
      logger.info({ taskId, workflowId, attempt }, 'Completion signal delivered');
      return true;
    } catch (err) {
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        logger.warn(
          { err, taskId, workflowId, attempt, nextRetryMs: delay },
          'Signal delivery failed, retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        logger.error(
          { err, taskId, workflowId, attempts: maxAttempts },
          'Signal delivery failed after all retries',
        );
      }
    }
  }
  return false;
}
```

**Caller behavior:** The `completeTask` endpoint calls `deliverSignal()`. The task is already marked COMPLETED in the database before the signal is sent (current behavior, preserved). If signal delivery fails after all retries, the endpoint still returns 200 — the task completion is persisted, the signal failure is logged as an error.

**Why not fail the endpoint:** The task state transition is the source of truth. Rolling it back because of a signal failure would create an inconsistent state — the user completed the form, the data is saved, but they'd see an error. Better to persist the completion and have a reconciliation path.

**Future upgrade path:** Replace the body of `deliverSignal` with a write to a `signal_outbox` table. The function signature stays the same. See `docs/design-decisions.md` for the outbox pattern rationale.

**Workflow-not-found handling:** If the workflow has already completed or been terminated, `getHandle().signal()` throws `WorkflowNotFoundError`. This should NOT be retried — detect it and log a warning instead.

```typescript
import { WorkflowNotFoundError } from '@temporalio/client';

// Inside the catch block:
if (err instanceof WorkflowNotFoundError) {
  logger.warn(
    { taskId, workflowId },
    'Target workflow not found — may have already completed or been terminated',
  );
  return false; // Don't retry
}
```

---

## C. SDK Ergonomics

### C1. Enriched completion envelope

**Problem:** The signal payload is `{ data: Record<string, unknown> }` — just the raw submission data. Workflows often need to know who completed the task, when, and which form version was used.

**Change the signal payload** sent by the server:

```typescript
// Current
interface TaskCompletedSignalPayload {
  data: Record<string, unknown>;
}

// New
interface TaskCompletedSignalPayload {
  data: Record<string, unknown>;
  completedBy: { id: string; email: string; displayName: string };
  completedAt: string; // ISO 8601
  formVersionId: string;
  formVersion: number;
}
```

**Server side:** The `completeTask` endpoint already has the task (with `completedAt`, `formDefinitionVersion`) and the authenticated user (`request.user`). Add these to the payload:

```typescript
const payload: TaskCompletedSignalPayload = {
  data: task.submissionData,
  completedBy: {
    id: request.user.id,
    email: request.user.email,
    displayName: request.user.displayName,
  },
  completedAt: task.completedAt!.toISOString(),
  formVersionId: formDefinition.id,
  formVersion: task.formDefinitionVersion,
};
```

**SDK side:** Update `TaskResult` to include the new fields:

```typescript
// Current
interface TaskResult {
  taskId: string;
  data: Record<string, unknown>;
}

// New
interface TaskResult {
  taskId: string;
  data: Record<string, unknown>;
  completedBy: { id: string; email: string; displayName: string };
  completedAt: string;
  formVersionId: string;
  formVersion: number;
}
```

Update `createTaskAndWait` to pass through the enriched payload:

```typescript
return {
  taskId: task.id,
  data: payload!.data,
  completedBy: payload!.completedBy,
  completedAt: payload!.completedAt,
  formVersionId: payload!.formVersionId,
  formVersion: payload!.formVersion,
};
```

### C2. Typed errors

**Problem:** `createTaskAndWait` can fail in several ways, but all failures surface as generic `Error` or Temporal framework errors. Workflows can't distinguish "task was cancelled" from "timed out" from "HTTP error creating task".

**New error classes in the SDK:**

```typescript
// packages/sdk/src/errors.ts

export class TaskTimeoutError extends Error {
  constructor(public readonly taskId: string, public readonly timeoutMs: number) {
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

**FlowstileClient** throws `FlowstileApiError` instead of raw `Error`:

```typescript
// In client.ts request() method
if (!resp.ok) {
  const text = await resp.text();
  throw new FlowstileApiError(resp.status, path, text);
}
```

### C3. Timeout support

**Problem:** `createTaskAndWait` blocks indefinitely by default. If a task is never completed (assigned user goes on vacation, workflow logic error), the workflow hangs forever.

**Add optional timeout to `createTaskAndWait`:**

```typescript
interface CreateTaskAndWaitInput {
  // ... existing fields ...
  timeoutMs?: number; // default: no timeout (blocks indefinitely)
}
```

Implementation uses Temporal's `condition()` timeout parameter:

```typescript
const completed = await condition(
  () => payload !== undefined,
  input.timeoutMs, // undefined = wait forever (current behavior)
);

if (!completed) {
  // Attempt to cancel the task so it doesn't sit in the inbox
  try {
    await cancelFlowstileTask(task.id);
  } catch {
    // Best effort — task may already be claimed/completed
  }
  throw new TaskTimeoutError(task.id, input.timeoutMs!);
}
```

### C4. Cancellation signal

**Problem:** If a task is cancelled (via `POST /tasks/:id/cancel`), the workflow doesn't know — it waits forever.

**Add a cancellation signal** alongside the completion signal:

Signal name: `flowstile:task:cancelled:<taskId>`

**Server side** (`cancelTask` endpoint): Send cancellation signal to the workflow, reusing `deliverSignal` with a different signal name. Generalize the function to `deliverSignal`:

```typescript
// In cancelTask endpoint, after state transition
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

Rename `deliverSignal` → `deliverSignal` (generalized). The file stays at `src/signals/deliver-signal.ts`.

**SDK side** (`createTaskAndWait`): Listen for both signals:

```typescript
const completedSignal = defineSignal<[TaskCompletedSignalPayload]>(
  taskCompletedSignalName(task.id),
);
const cancelledSignal = defineSignal<[]>(
  taskCancelledSignalName(task.id),
);

let completionPayload: TaskCompletedSignalPayload | undefined;
let cancelled = false;

setHandler(completedSignal, (p) => { completionPayload = p; });
setHandler(cancelledSignal, () => { cancelled = true; });

const resolved = await condition(
  () => completionPayload !== undefined || cancelled,
  input.timeoutMs,
);

if (!resolved) {
  try { await cancelFlowstileTask(task.id); } catch {}
  throw new TaskTimeoutError(task.id, input.timeoutMs!);
}

if (cancelled) {
  throw new TaskCancelledError(task.id);
}

return {
  taskId: task.id,
  data: completionPayload!.data,
  completedBy: completionPayload!.completedBy,
  completedAt: completionPayload!.completedAt,
  formVersionId: completionPayload!.formVersionId,
  formVersion: completionPayload!.formVersion,
};
```

**New type exports:**

```typescript
// packages/sdk/src/types.ts
export function taskCancelledSignalName(taskId: string): string {
  return `flowstile:task:cancelled:${taskId}`;
}
```

### C5. Type-safe generics

**Problem:** `createTaskAndWait` returns `Record<string, unknown>` for both input and output data. Workflows have to cast everything.

**Add generics:**

```typescript
export async function createTaskAndWait<
  TOutput extends Record<string, unknown> = Record<string, unknown>,
>(
  input: CreateTaskAndWaitInput,
): Promise<TaskResult<TOutput>>
```

```typescript
interface TaskResult<TOutput extends Record<string, unknown> = Record<string, unknown>> {
  taskId: string;
  data: TOutput;
  completedBy: { id: string; email: string; displayName: string };
  completedAt: string;
  formVersionId: string;
  formVersion: number;
}
```

**Usage in workflows:**

```typescript
interface LoanDecision {
  DECISION: 'approved' | 'rejected';
  NOTES: string;
}

const result = await createTaskAndWait<LoanDecision>({
  taskDefinitionId: reviewTaskDef.id,
  inputData: { applicantName, loanAmount },
});

// result.data.DECISION is typed as 'approved' | 'rejected'
```

This is purely a TypeScript convenience — no runtime behavior change.

---

## D. Worker DX

### Problem

When connection fails (Temporal down, Flowstile server unreachable, bad credentials), the error messages are raw framework errors — stack traces from `@temporalio/worker` or `fetch` failures with no context.

### Design

Add targeted try/catch blocks in `packages/worker/src/main.ts` with actionable error messages:

```typescript
// Temporal connection
try {
  connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
} catch (err) {
  console.error(
    `\nFailed to connect to Temporal at ${TEMPORAL_ADDRESS}\n` +
    `Is the Temporal server running? Try: temporal server start-dev\n` +
    `Error: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(1);
}

// Flowstile server reachability check
try {
  const resp = await fetch(`${FLOWSTILE_SERVER_URL}/api/health`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
} catch (err) {
  console.error(
    `\nFailed to reach Flowstile server at ${FLOWSTILE_SERVER_URL}\n` +
    `Is the server running? Try: pnpm --filter @flowstile/server dev\n` +
    `Error: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(1);
}

// Auth check (try logging in)
try {
  configureFlowstileActivities({
    baseUrl: FLOWSTILE_SERVER_URL,
    auth: { email: FLOWSTILE_EMAIL, password: FLOWSTILE_PASSWORD },
  });
  // Force an auth attempt
  await new FlowstileClient({
    baseUrl: FLOWSTILE_SERVER_URL,
    auth: { email: FLOWSTILE_EMAIL, password: FLOWSTILE_PASSWORD },
  }).createTask; // just verify client construction
} catch (err) {
  console.error(
    `\nFailed to authenticate with Flowstile server\n` +
    `Check FLOWSTILE_EMAIL (${FLOWSTILE_EMAIL}) and FLOWSTILE_PASSWORD\n` +
    `Error: ${err instanceof Error ? err.message : err}\n`,
  );
  process.exit(1);
}
```

**Startup banner** — improve the existing console.log:

```
Flowstile worker started
  Temporal:  localhost:7233 ✓
  Server:    http://localhost:3000 ✓
  Auth:      service@flowstile.local ✓
  Queue:     flowstile
  Workflows: ./workflows.ts
```

---

## Files changed

| Package | File | Change |
|---------|------|--------|
| server | `src/validation/schema-validator.ts` | **New** — ajv validation utility |
| server | `src/signals/deliver-signal.ts` | **New** — signal delivery with retry |
| server | `src/routes/tasks.ts` | Modify — add validation calls, use `deliverSignal`, enrich signal payload, send cancellation signal |
| server | `package.json` | Add `ajv` dependency |
| sdk | `src/types.ts` | Modify — enrich `TaskCompletedSignalPayload`, `TaskResult`, add `taskCancelledSignalName`, add generics |
| sdk | `src/errors.ts` | **New** — `TaskTimeoutError`, `TaskCancelledError`, `FlowstileApiError` |
| sdk | `src/workflows.ts` | Modify — timeout support, cancellation signal, enriched return, generics |
| sdk | `src/client.ts` | Modify — throw `FlowstileApiError` |
| sdk | `src/index.ts` | Modify — export new errors and types |
| worker | `src/main.ts` | Modify — better error messages and startup banner |

## Testing strategy

- **Schema validation:** Unit test `validateAgainstSchema` and `validateInputData` with valid/invalid data against known schemas. Integration test the `/tasks` and `/tasks/:id/complete` endpoints with invalid data → 422.
- **Signal delivery:** Unit test `deliverSignal` with mocked Temporal client — verify retry count, backoff delays, WorkflowNotFoundError handling.
- **SDK errors:** Unit test error classes. Test `createTaskAndWait` timeout and cancellation paths in a Temporal test environment.
- **Worker DX:** Manual verification — start worker with Temporal down, server down, bad credentials; confirm error messages are clear.

## Design decisions

- **inputData validation is lenient** (no required-field enforcement) because inputData represents pre-populated fields, not a complete submission.
- **submissionData validation is strict** because it's the final form submission.
- **Signal failure doesn't fail the endpoint** because the task completion is the source of truth. Rolling back creates worse inconsistency.
- **Outbox pattern deferred** — simple retry covers transient failures. Outbox adds operational complexity (polling job, monitoring) that isn't justified yet. The `deliverSignal` function is designed as an isolated unit to make the swap easy later.
- **Generics are TypeScript-only** — no runtime validation of the generic type. The JSON Schema validation at the server boundary is the real enforcement.
