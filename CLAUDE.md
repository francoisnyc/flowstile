# Flowstile

Flowstile is a human-task inbox and form layer for Temporal.io workflows. Workflows pause for human input by calling `createTaskAndWait`, a task appears in a web inbox, a person claims and completes a form, and the workflow resumes with typed data via a Temporal signal.

## Architecture

Four packages in a pnpm monorepo:

- **`packages/server`** — Fastify REST API, TypeORM + PostgreSQL, auth (JWT cookies), RBAC, task lifecycle, form versioning, signal delivery to Temporal
- **`packages/worker`** — Temporal worker hosting workflow definitions and activities (including the Order Fulfillment demo)
- **`packages/sdk`** — `@flowstile/sdk` npm package: `FlowstileClient` for API calls, `createTaskAndWait` workflow helper, typed errors
- **`packages/ui`** — React + Vite + Tailwind inbox and JSON Forms-based form designer

## Key Contracts

### API

Full OpenAPI 3.1 spec: `docs/openapi.yaml`

All list endpoints return `{ items, total, limit, offset }`. Auth is JWT via HttpOnly cookie or Bearer header. Permissions are string-based (`tasks:read`, `tasks:write`, `forms:write`, etc.) assigned through roles.

### Task State Machine

```
created → claim → claimed
created → cancel → cancelled
claimed → unclaim → created
claimed → complete → completed
claimed → cancel → cancelled
completed (terminal)
cancelled (terminal)
```

Completion requires claim first. No direct `created → completed`.

### Task Data Model

Three separate payloads per task — this is an intentional design decision (see `docs/design-decisions.md`):

- **`inputData`** — workflow-provided, validated at creation, immutable after creation
- **`contextData`** — read-only display context for the assignee, filtered by visibility rules before delivery
- **`submissionData`** — human-editable payload, validated against the locked form schema at completion

### Form Versioning

Forms are addressed by stable `code`, not UUID. Tasks lock to a specific form version at creation. In-flight tasks are never retroactively rebound to new form versions.

### Signal Integration

On task completion, the server fires `flowstile:task:completed:{taskId}` to the Temporal workflow with `{ data, completedBy, completedAt, formVersion }`. On cancellation, fires `flowstile:task:cancelled:{taskId}`. Delivery uses retry with backoff but is fire-and-forget at the HTTP layer.

### SDK Workflow Helper

```typescript
import { createTaskAndWait } from '@flowstile/sdk/workflows';

const result = await createTaskAndWait<{ DECISION: 'approved' | 'rejected' }>({
  taskDefinitionId: '...',
  inputData: { ... },
  contextData: { ... },
  timeoutMs: 86400000, // optional
});
// result.data, result.completedBy, result.completedAt, result.formVersion
```

Handles timeout (cancels task + throws `TaskTimeoutError`), workflow cancellation (cancels task in `nonCancellable` scope), and task cancellation signal (`TaskCancelledError`).

## Development

```bash
corepack enable && pnpm install
docker compose up -d        # PostgreSQL + Temporal
pnpm build
pnpm --filter @flowstile/server db:seed
pnpm dev                    # starts server + ui + worker
```

- Server: http://localhost:3000
- API docs: http://localhost:3000/docs (Swagger UI, auto-generated from route schemas)
- UI: http://localhost:5173
- Seeded users: alice/bob/carol@example.com (password: `password`)

## Testing

```bash
pnpm test                                           # all unit tests (122)
pnpm --filter @flowstile/server test:integration    # requires Docker postgres
npx playwright test                                 # e2e (requires running stack)
```

## Documentation

- `docs/developer-guide.md` — concepts and integration guide
- `docs/design-decisions.md` — why the task data model is split
- `docs/runtime-contract.md` — detailed payload, lifecycle, and access rules
- `docs/ui-direction.md` — frontend stack and visual principles
- `docs/openapi.yaml` — auto-generated OpenAPI 3.1 spec (regenerate with `pnpm --filter @flowstile/server openapi:generate`)

## For Rewriting in Another Stack

If you are reimplementing Flowstile in a different language or framework:

1. **Start with `docs/openapi.yaml`** — this is the authoritative API contract. Every endpoint, request/response shape, status code, and permission requirement is documented there.

2. **Read `docs/runtime-contract.md`** — this defines the behavioral rules (state machine transitions, validation order, versioning semantics, access control) that any implementation must follow.

3. **Use the test suite as behavioral specs:**
   - `packages/server/test/integration/` — 47 integration tests defining exact API behavior
   - `packages/sdk/test/` — 18 unit tests for client auth/retry and workflow timeout/cancellation logic
   - `e2e/order-fulfillment.spec.ts` — 9 end-to-end tests covering happy path, saga compensation, and early rejection

4. **Key implementation details:**
   - Task completion validates state machine BEFORE submission data (409 before 422)
   - Form visibility rules filter both schema and data server-side — the browser never receives hidden fields
   - Signal delivery to Temporal is retried with backoff but never fails the HTTP response
   - The `PUT /forms/:code/draft` endpoint returns 200 for update, 201 for create
   - `GET /roles` is the only list endpoint without pagination
   - `PATCH /task-definitions/:id` is the only resource not nested under its parent path
