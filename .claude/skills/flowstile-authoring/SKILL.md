---
name: flowstile-authoring
description: Author a complete Flowstile process end to end — code-first process definition with a case plan, forms, typed workflow, and e2e validation. Use when asked to create or extend a business process (tasks, forms, phases, workflow) in this repo.
---

# Authoring a Flowstile Process

You are building a human-task process on Flowstile: a Temporal workflow that pauses
for human input via `createTaskAndWait`, tasks completed through forms in a web
inbox, with a case page showing a milestone stepper. Follow this loop in order.
Every step has a deterministic check — run it before moving on.

## 0 — Stack prerequisites

```bash
docker compose up -d postgres postgres-temporal temporal temporal-ui
pnpm install && pnpm build
pnpm --filter @flowstile/server db:seed     # idempotent? NO — drops/reseeds dev data
```

Run server, worker, and UI for interactive work (background each):

```bash
# Server NEEDS both env vars: JWT_SECRET always, TEMPORAL_ADDRESS for portal start
JWT_SECRET=dev-local-secret TEMPORAL_ADDRESS=localhost:7233 pnpm --filter @flowstile/server dev   # :3000 (Swagger at /docs)
# Worker: run from dist — `tsx watch` breaks Temporal's workflow bundler (workflowsPath
# resolves to src/workflows.js which doesn't exist). Build first, then:
pnpm --filter @flowstile/worker start  # doctor preflight runs at boot
pnpm --filter @flowstile/ui dev        # :5173
```

**Auth for API calls (dev):** `Authorization: Bearer fsk_dev_local_worker_DO_NOT_USE_IN_PROD`
(service API key: `tasks:read`, `tasks:write`, `processes:start`). For endpoints that
key lacks (`processes:write`, `forms:write`), log in as the admin and use the cookie token:

```bash
TOKEN=$(curl -s -i -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"password"}' \
  | grep -o 'flowstile_token=[^;]*' | cut -d= -f2)
# then: -H "Authorization: Bearer $TOKEN"
```

Seeded users (password `password`): `alice@example.com` (admin; loan-officers,
order-reviewers), `bob@example.com` (loan-officers, warehouse), `carol@example.com`
(customer-service), `service@flowstile.local` (service). Add new groups/users in
`packages/server/src/seed.ts`, not ad hoc.

## 1 — Design the process on paper first

Decide, before any artifact:

- **Plan**: 3–6 ordered milestone codes + display names (the happy path only —
  exception/escalation tasks stay unphased with `phase: null`; never encode
  branches in the plan).
- **Task definitions**: SCREAMING_SNAKE codes (globally unique!), each mapped to a
  milestone code or null, each with a form code and candidate groups.
- **Workflow shape**: branches, loops, compensation — this lives in imperative
  TypeScript, not in the plan. The plan never gates anything.
- **Acceptance rubric**: write the e2e scenarios first (happy path, early
  termination, any loop) — they are the definition of done.

## 2 — Register on the server

Durable demo/dev data goes in `packages/server/src/seed.ts` (follow the Order
Fulfillment block: forms → process with `milestones` → task definitions with
`milestoneCode`). For live iteration use the API:

```
POST /processes                  { name, milestones: [{code,name},...] }
POST /processes/:id/tasks        { code, formDefinitionCode, milestoneCode, candidateGroups, defaultPriority }
PATCH /processes/:id             { workflowType, taskQueue, startFormCode? }   # enables portal start
```

`milestoneCode` must be a member of the plan — the server 422s otherwise.
`PATCH /task-definitions/:id` updates a task definition (note: not nested).

## 3 — Author the forms

Forms are JSON Forms (jsonSchema + uiSchema), addressed by stable SCREAMING_SNAKE
code. Conventions (see `ORDER_APPROVAL` in the seed for a canonical example):

- Field keys SCREAMING_SNAKE. Context fields the assignee shouldn't edit get
  `options: { readonly: true }` in the uiSchema and are fed via task
  `contextData`/`inputData`.
- The decision field is an enum (`DECISION: { enum: ['APPROVED','REJECTED'] }`)
  and is in `required`. Free-text fields use `options: { multi: true }`.
- Only fields a human actually edits belong in `required` — completion validates
  `submissionData` against this schema.

Via API (agent-draftable; draft → publish is the human gate in production):

```
PUT  /forms/:code/draft     { jsonSchema, uiSchema }   # 201 create, 200 update
POST /forms/:code/publish                              # locks + bumps version
```

Tasks can only be created against a **published** form (422 otherwise). Preview a
draft in the designer: `http://localhost:5173/forms/<CODE>`.

## 4 — Generate types

```bash
cd packages/worker
# The flowstile-codegen bin isn't linked across workspace packages — invoke via tsx:
pnpm exec tsx ../sdk/src/cli.ts \
  --process "<Process Name>" --task-queue flowstile \
  --api-key "$TOKEN" --out src/<slug>/process.ts
```

(Any authenticated principal can read processes/forms — the admin TOKEN works.) The generated file uses the
task-factory form of `defineProcess` — `phase` is compile-checked against the
plan. Regenerate after any form publish or task-definition change; never hand-edit.

## 5 — Write the workflow

In `packages/worker/src/<slug>/workflow.ts`:

- Import descriptors from the generated `process.ts`; human steps are
  `await descriptor.createAndWait({ processInstanceId, inputData, contextData })`.
- Always pass `processInstanceId` — it groups tasks into a case.
- Automated steps are Temporal activities (`proxyActivities`); register custom
  activities in `packages/worker/src/main.ts`.
- Export the workflow from `packages/worker/src/workflows.ts` (the sandbox entry —
  only `@temporalio/workflow`-safe imports there).
- Rework loops = plain `while`; conditional steps = plain `if`; compensation =
  try/catch + a compensations array (see `order-fulfillment/workflow.ts`).
- Long waits: pass `timeoutMs`; handle `TaskTimeoutError` / `TaskCancelledError`.

## 6 — Validate, inner loop

1. **Boot the worker** — the doctor preflights every task code, published form,
   queue, and plan/phase agreement against the server, and fails loudly with the
   exact fix. `FLOWSTILE_DOCTOR=warn` to bypass while iterating; never ship that.
2. **Drive one case via API** as a candidate-group user: claim → complete with
   valid `submissionData` (claim first — completion without claim is 409; state
   machine errors are 409, schema errors 422; a task invisible to the caller is
   404, not 403 — check candidate groups when "missing").
3. **Check the case page**: `GET /cases/:id` → `milestones[].state` and the
   stepper at `http://localhost:5173/cases/<id>`. Verify the workflow result via
   Temporal (`e2e/helpers/check-workflow.ts` or temporal-ui :8080).

## 7 — Validate, outer loop (the rubric)

Write the e2e spec in `e2e/<slug>.spec.ts` following `order-fulfillment.spec.ts`:
start the workflow with `e2e/helpers/start-workflow.ts`-style script, complete
tasks via API logins as the right seeded users, assert case status, milestone
states, and the workflow's final result. Then the full local CI gate:

```bash
pnpm build
pnpm --filter @flowstile/server openapi:generate && git diff --exit-code docs/openapi.yaml
pnpm test
pnpm --filter @flowstile/server test:integration
npx playwright test e2e/<slug>.spec.ts    # requires running stack incl. worker
```

All green = done. Red e2e → fix → rerun; if a failure traces to a wrong or
missing instruction in THIS skill, fix the skill in the same commit.

## Gotchas that cost real time

- **Never send `Content-Type: application/json` without a body** (claim/cancel
  POSTs) — Fastify rejects it with 400 before your handler runs.
- **Case reads require a user account**: `GET /cases/:id` returns "This action
  requires a user account" for service API keys — assert case/milestone state
  with a logged-in user (alice for oversight).
- **The case completes before the workflow does**: case status derives from
  tasks, so it reads `completed` the moment the last task completes, while the
  workflow finishes a beat later when the completion signal is delivered. Poll
  Temporal status in tests; never assert it in the same breath as case status.
- Task definition codes are **globally** unique, not per-process.
- The worker registers ONE task queue; multiple processes can share it, but each
  process's `workflowType`/`taskQueue` must be set for portal start.
- Visibility: a non-admin user sees a task only as assignee/candidate — drive
  e2e API calls as a group member, or you'll get 404s and think the task vanished.
- `createTaskAndWait` retries task creation 3×; a missing task def or unpublished
  form fails the workflow — that's what the doctor exists to pre-empt.
- The milestone stepper derives from task statuses at read time; an automated
  phase shows pending until a later phase's task exists (expected, not a bug).
- Case `status` derives from tasks: all-terminal = completed/cancelled — a case
  with only the first task completed already reads "completed" until the workflow
  creates the next task (brief; re-fetch after the signal round-trip in tests).
