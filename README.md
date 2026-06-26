# Flowstile

Open-source human-task inbox and form designer for [Temporal.io](https://temporal.io) workflows. Create forms, assign tasks to humans, and wire the results back into durable workflows via signals.

## What It Does

Flowstile gives Temporal applications a durable way to pause for human input. A workflow calls `createTaskAndWait`, a task appears in an inbox, a person completes a form, and the workflow resumes with typed data.

```ts
import { createTaskAndWait } from '@flowstile/sdk/workflows';

const result = await createTaskAndWait<{ DECISION: 'approved' | 'rejected' }>({
  taskDefinitionId: approveOrderTaskDefId,
  priority: 'high',
  inputData: { ORDER_ITEMS: items, TOTAL: total },
  contextData: { ORDER_ID: orderId, CUSTOMER_NAME: name },
});

if (result.data.DECISION === 'approved') {
  // continue workflow...
}
```

## Features

- **Task inbox** — claim, complete, and manage human work
- **Form designer** — JSON Schema + JSON Forms with visual editing
- **SDK** — `createTaskAndWait` with typed generics, timeout, and cancellation
- **Signal-based integration** — completion data delivered back to Temporal as signals
- **Saga support** — compensation patterns with human exception handling
- **Need-to-know visibility** — server-side task/case scoping: users see only tasks they're assigned to or a candidate for; cases inherit task visibility; oversight roles see all
- **Field-level visibility** — server-side field filtering based on user roles/groups
- **Task state machine** — explicit lifecycle (created, claimed, completed, cancelled)

## Project Structure

```
packages/
  server/   Fastify REST API, TypeORM (PostgreSQL), auth, task lifecycle
  worker/   Temporal worker with workflow definitions and activities
  sdk/      @flowstile/sdk — TypeScript client, workflow helpers, typed errors
  ui/       React inbox and form designer (Vite + Tailwind)
  react/    @flowstile/react — embeddable task-form components
sdk-python/ flowstile — Python SDK for writing Temporal workers
e2e/        Playwright end-to-end tests
docs/       Developer documentation
```

## Language SDKs

Write your Temporal workers in either language against the same (language-agnostic) server:

- **TypeScript** — [`@flowstile/sdk`](packages/sdk): `createTaskAndWait`
- **Python** — [`flowstile`](sdk-python): `create_task_and_wait` (a method on `FlowstileWorkflowBase`), with typed results and generated task descriptors via `flowstile-codegen`

## Prerequisites

- Node.js 22+
- Docker (for PostgreSQL and Temporal)
- corepack (`corepack enable`)

## Quick Start

```bash
corepack enable
git clone https://github.com/francoisnyc/flowstile.git && cd flowstile
cp .env.example .env
pnpm install
docker compose up -d
```

Wait for services to be healthy, then seed and start:

```bash
pnpm build
pnpm --filter @flowstile/server db:seed
pnpm dev
```

- UI: http://localhost:5173
- Server API: http://localhost:3000
- Health check: `GET /health`

Login with seeded users: `alice@example.com`, `bob@example.com`, or `carol@example.com` (password: `password`).

## Running the Order Fulfillment Demo

The included demo showcases a multi-step order workflow with human approvals, automated payment, warehouse confirmation, and saga compensation.

```bash
# Start the worker (in a separate terminal)
pnpm --filter @flowstile/worker dev

# Start a workflow instance
pnpm --filter @flowstile/worker tsx src/start-order-workflow.ts
```

Then follow the on-screen instructions to approve/reject orders through the inbox as different users.

### Other seeded demos

The worker also hosts **Loan Origination**, **Expense Approval**, **Vacation Leave Request**, and **Purchase Requisition Approval** — multi-stage human-task processes with case plans and milestone steppers. They're portal-startable from the UI (or `POST /processes/:id/start`); each has an end-to-end walk-through under `e2e/`.

## Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all packages in dev mode |
| `pnpm build` | Build all packages |
| `pnpm test` | Run all unit tests |
| `pnpm --filter @flowstile/server test:integration` | Integration tests (requires Docker) |
| `pnpm --filter @flowstile/server db:seed` | Seed sample data |
| `pnpm --filter @flowstile/worker dev` | Start Temporal worker |
| `docker compose up -d` | Start PostgreSQL + Temporal |
| `docker compose down` | Stop all services |

## Self-hosting

Flowstile is self-hosted and single-tenant (one deployment per organization). See
the [Self-Hosting runbook](docs/self-hosting.md) for production topology, environment
variables, database migrations, first-run admin bootstrap, and the secret checklist.

## Documentation

- [Developer Guide](docs/developer-guide.md) — architecture, concepts, and integration
- [Self-Hosting](docs/self-hosting.md) — production deployment runbook
- [Process Authoring Guide](docs/process-authoring-guide.md) — author a process end to end
- [Design Decisions](docs/design-decisions.md) — why the task model works the way it does
- [Runtime Contract](docs/runtime-contract.md) — payload model, lifecycle, and access rules
- [UI Direction](docs/ui-direction.md) — frontend stack and interaction principles

## License

Apache 2.0
