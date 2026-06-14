# Flowstile

Flowstile is a human-task inbox and form layer for Temporal.io workflows. Workflows pause for human input by calling `createTaskAndWait`, a task appears in a web inbox, a person claims and completes a form, and the workflow resumes with typed data via a Temporal signal.

## Architecture

Five packages in a pnpm monorepo:

- **`packages/server`** — Fastify REST API, TypeORM + PostgreSQL, auth (JWT cookies), RBAC, task lifecycle, form versioning, signal delivery to Temporal
- **`packages/worker`** — Temporal worker hosting workflow definitions and activities (including the Order Fulfillment demo)
- **`packages/sdk`** — `@flowstile/sdk` npm package: `FlowstileClient` for API calls, `createTaskAndWait` workflow helper, typed errors
- **`packages/ui`** — React + Vite + Tailwind inbox and JSON Forms-based form designer
- **`packages/react`** — `@flowstile/react` npm package: embeddable React SDK for embedding Flowstile task forms into third-party apps (`FlowstileTask`, `FlowstileForm`, `useFlowstileTask`)

## Key Contracts

### API

Full OpenAPI 3.1 spec: `docs/openapi.yaml`

All list endpoints return `{ items, total, limit, offset }`. Auth is JWT via HttpOnly cookie or Bearer header. Permissions are string-based (`tasks:read`, `tasks:write`, `tasks:manage`, `cases:read`, `forms:write`, `processes:write`, `processes:start`, `users:manage`) assigned through roles.

### Visibility (Need-to-Know)

Two independent server-side layers:

- **Instance scope** — a non-oversight user sees a task only if they are its assignee, a candidate user (by email), or a candidate-group member (by name). Tasks carry per-instance `candidateUsers`/`candidateGroups`, snapshotted from the task definition at creation and overridable on `POST /tasks`. An uncandidated, unassigned task is visible only to oversight. List/search are SQL-scoped; single-task reads + claim/unclaim/complete/cancel return **`404`** (not `403`) for tasks the caller can't see, so existence is never leaked. Cases inherit: visible if you started it, can see one of its tasks, or hold case oversight. Oversight = service credential, `tasks:manage` (all tasks), or `cases:read` (all cases). Core logic in `packages/server/src/common/task-scope.ts`.
- **Field scope** — the form's `visibilityRules` filter individual fields (schema + data) server-side before delivery.

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
  candidateUsers: ['reviewer@example.com'],  // optional per-instance need-to-know override
  candidateGroups: ['loan-officers'],        // optional
  timeoutMs: 86400000,                       // optional
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
pnpm test                                           # all unit tests across all packages
pnpm --filter @flowstile/server test:integration    # requires Docker postgres
npx playwright test                                 # e2e (requires running stack)
```

## Git Workflow

This is a solo project. The default is **commit and push straight to `master`** — no PR ceremony. CI (`.github/workflows/ci.yml`) runs on every push to `master` as well as on PRs, so direct pushes are still gated by the full test suite.

Before pushing, **reproduce the CI pipeline locally** — it catches essentially everything `ci.yml` would, with no network or PR needed:

```bash
pnpm build
pnpm --filter @flowstile/server openapi:generate && git diff --exit-code docs/openapi.yaml  # spec must be in sync
pnpm test                                            # unit
pnpm --filter @flowstile/server test:integration     # integration (requires postgres)
```

Open a branch + PR only when you specifically want one of:
- **CI watched/autofixed in-session** — the PR webhook stream is the only way the agent can observe GitHub Actions results from its environment (no `gh`, no network, no Actions MCP tool). Use this when stepping away and you want a red build caught and fixed.
- **Staging a risky or large change** — somewhere to let CI run and review the full diff in GitHub's UI before merging deliberately.

For everything else, push to `master`.

## Documentation

- `docs/developer-guide.md` — concepts and integration guide
- `docs/process-authoring-guide.md` — step-by-step authoring journey (code-first process definition, task→form mapping, case plan/phases, versioning, mining); doubles as the process-visibility & DX roadmap
- `docs/design-decisions.md` — why the task data model is split; declarative-data/imperative-control; why BPMN constructs map to Temporal code (not Flowstile features); the proposed case-event log for automated/agent work
- `docs/kuflow-comparison.md` — method-by-method Flowstile vs KuFlow SDK comparison; what diverges (authoring surface, asymmetric SDK) vs converges (case entity) and why
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
   - `e2e/visibility-scope.spec.ts` — need-to-know task/case visibility (group/user/orphan scoping, 404-not-403, case inheritance)

4. **Key implementation details:**
   - Task completion validates state machine BEFORE submission data (409 before 422)
   - Need-to-know visibility: non-oversight users see a task only as assignee/candidate-user/candidate-group; list/search SQL-scoped; single-task reads + claim/unclaim/complete/cancel return 404 (not 403) for hidden tasks; cases inherit visibility from their tasks + `startedById`
   - Form visibility rules filter both schema and data server-side — the browser never receives hidden fields
   - Signal delivery to Temporal is retried with backoff but never fails the HTTP response
   - The `PUT /forms/:code/draft` endpoint returns 200 for update, 201 for create
   - `GET /roles` is the only list endpoint without pagination
   - `PATCH /task-definitions/:id` is the only resource not nested under its parent path
