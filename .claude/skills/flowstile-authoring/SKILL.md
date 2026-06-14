---
name: flowstile-authoring
description: Author a complete Flowstile process end to end — code-first process definition with a case plan, forms, typed workflow, and e2e validation. Use when asked to create or extend a business process (tasks, forms, phases, workflow) in this repo.
---

# Authoring a Flowstile Process

You are building a human-task process on Flowstile: a Temporal workflow that pauses
for human input via `createTaskAndWait`, tasks completed through forms in a web
inbox, with a case page showing a milestone stepper. Follow this loop in order.
Every step has a deterministic check — run it before moving on.

**Three disciplines that run through the whole loop:**

- **Brainstorm before you build (§1 is a gate).** Pin the design down in dialogue
  first — milestones, decisions, branches, who acts — and get a thumbs-up before
  creating any artifact. Authoring against a fuzzy design is the #1 source of rework.
- **Test-first (red → green).** Write the e2e spec as the executable rubric in §1,
  *before* the seed/forms/workflow exist. It fails — that's the point: it's the
  contract you build toward, not a victory-lap test written afterward to confirm
  what you already shipped. §2–§6 are "make the rubric pass"; §7 is "run it green."
- **Workflow code → the `temporal-developer` skill.** Temporal's determinism rules
  live in the vendored `temporal-developer` skill, not here; this skill adds only
  the Flowstile bridge (§5).

## Coming from BPMN? Translate the mental model first

If you — or the prompt you're following — think in BPMN / Camunda / Bonita / KuFlow
terms, translate *before* you author. Most BPMN **constructs are not Flowstile
features**; they dissolve into plain workflow code. The spine: a BPMN engine
*bundles* orchestration into a visual model because a diagram is its medium;
Temporal *unbundles* it into code. So Flowstile's declarative surface is reserved
for **data and visibility**, never control flow.

| BPMN / engine concept | Flowstile / Temporal | Guardrail |
|---|---|---|
| User task (human work) | `defineTask` + `createAndWait` | Human completes via the UI → signal; the SDK has **no** `complete`/`claim` — by design (see below) |
| Service task (automated) | A Temporal **activity** (`proxyActivities`) | Invisible to Flowstile today; surface it only if needed — the case-event log is *proposed*, not built |
| Script / business-rule task | Plain workflow code, or an activity | — |
| Connector in/out (data mapping) | `contextFrom` / `persist` for case-entity data; an **activity** for external systems | Declarative for *data*, imperative for *control* — never put an external call's sequencing into config |
| Connector retry / replay | Temporal **retry policy** + the Temporal UI | Don't rebuild it — Temporal's is automatic and better than a manual replay button |
| External task (pull worker) | A dedicated Temporal **task queue**, or **async activity completion** | Build a REST-claimable Flowstile task *only* if the worker/agent can't be a Temporal worker |
| Sequence flow / ordering | Sequential `await` in the workflow | Already guaranteed durably — no "subprocess" construct needed |
| Subprocess | A function; a **child workflow** only for real isolation | Don't reach for a child workflow just to order calls |
| Saga / compensation | Compensations array + try/catch (see `order-fulfillment/workflow.ts`) | **Saga can't cross a human-task commit** — compensate the automated steps, *escalate* (don't roll back) the human decision |
| Gateway / branching | Plain `if` / `switch` | — |
| Boundary timer / escalation | `timeoutMs` on `createTaskAndWait` (→ cancel + `TaskTimeoutError`) | — |
| Pool / lane (who acts) | Candidate groups/users on the task | — |
| Process variables | The **case entity** (compute in the workflow → `persist` / `patchFlowstileCaseEntity`) | Not a formula engine — calculation lives in the workflow |
| Agent / RPA actor | A Temporal **activity** (agent-backed) | Don't make an agent *complete a human task* — that forges the audit trail; automated/agent work gets its own slot (proposed case-event log) |

**Two boundaries that catch BPMN-trained authors (and agents):**

- **The SDK can't complete a task.** Completion is a human action through the UI;
  the workflow only *creates* and *cancels*. If you're tempted to complete a task
  from code, the work isn't a human task — model it as an **activity**. A human
  task captures a human decision with an audited `completedBy`; completing it from
  code corrupts that.
- **Calculation lives in the workflow, not in forms or config.** There is no
  calculated-field / expression mechanism by design. Derive values in TypeScript
  and `persist` them; `contextFrom`/`persist` are *plumbing only* (copy/rename),
  never transforms. See `docs/design-decisions.md` → "Declarative for Data,
  Imperative for Control".

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

## 1 — Brainstorm the design, then write the failing e2e (gate)

**Brainstorm first, with the requester.** Before any artifact, talk the process
through and converge on:

- **Plan**: 3–6 ordered milestone codes + display names (the happy path only —
  exception/escalation tasks stay unphased with `phase: null`; never encode
  branches in the plan).
- **Task definitions**: SCREAMING_SNAKE codes (globally unique!), each mapped to a
  milestone code or null, each with a form code and candidate groups.
- **Workflow shape**: branches, loops, compensation — this lives in imperative
  TypeScript, not in the plan. The plan never gates anything.

Surface the open questions out loud (who approves what, what ends the case, what's
automated vs human) and get a thumbs-up. *Then* gate to build.

**Write the e2e spec now (red).** Translate the agreed scenarios — happy path,
early termination, any loop — into `e2e/<slug>.spec.ts` (shape in §7) *before* the
seed/forms/workflow exist. It will fail to even find the process: that's your red
bar, and the definition of done. Everything below turns it green; do not write the
spec last to rubber-stamp what you built.

## 2 — Register on the server

Durable demo/dev data goes in `packages/server/src/seed.ts` (follow the Loan
Origination block starting at line ~339: forms → process with `milestones` →
task definitions with `milestoneCode`). For live iteration use the API:

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
  `submissionData` against this schema. **Do not put read-only context fields in
  `required`**: the assignee never edits them, so they're absent from
  `submissionData` and completion 422s. `required` = the editable decision fields
  only (the doctor does not catch this — it's a completion-time error).

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

### Workflow code → lean on the vendored `temporal-developer` skill

`workflow.ts` runs in Temporal's deterministic sandbox. Before anything non-trivial
(timers, signals beyond `createTaskAndWait`, child workflows, continue-as-new, or
**changing a workflow while instances are live**), load the vendored
**`temporal-developer`** skill (`.claude/skills/temporal-developer/`, TypeScript
subset) and read the relevant `references/typescript/*.md`. It owns the determinism
rules; this skill adds only the Flowstile-specific bridge:

- **`createTaskAndWait` is a durable, deterministic await** — it suspends on a
  Temporal signal. Never use `setTimeout`/`Date.now()`/`Math.random()` in workflow
  code to wait or decide; use `timeoutMs` for deadlines and derive values from
  inputs/activity results (see `references/typescript/determinism.md`).
- **`persist` / `contextFrom` / `patchFlowstileCaseEntity` are activities** — the
  SDK runs case-entity I/O inside Temporal activities, so that's the
  non-deterministic boundary, already safe. Your workflow body stays pure.
- **Flowstile workflows are long-lived** — a human task can sit for days, so a
  deploy almost always replays against in-flight instances. Treat any edit to an
  existing workflow's shape as a versioned change: read `references/core/versioning.md`
  + `references/typescript/versioning.md` first. (Same reason Flowstile locks a form
  version per task at creation — see CLAUDE.md "Form Versioning".)
- **The worker bundles `workflows.ts`** — only `@temporalio/workflow`-safe imports
  there; the `tsx watch` bundler gotcha in §0 is the symptom of breaking this.

**Portal-start and read-back contracts** (these live in the examples; here so you don't have to reverse-engineer them):

- **Start a case:** `POST /processes/:id/start` with `{ data: { ...start-form fields }, idempotencyKey? }` → `201 { processInstanceId, caseId }`. Requires `workflowType` + `taskQueue` set on the process (422 otherwise; 503 if `TEMPORAL_ADDRESS` isn't configured on the server). **The Temporal `workflowId` *is* the `processInstanceId`** — pass it straight to `check-workflow.ts`/`getHandle(id)`; the `/start` response gives you no separate workflow id.
- **Workflow input shape:** a portal-started workflow receives `{ processInstanceId: string, data: { ...start-form fields }, startedBy?: { id, email, displayName } | null }`. Start-form fields are nested under `data`, never at the top level. The start form's `required` constrains the *submitted form*, not your workflow input type — type fields you read as you actually use them.
- **Read case variables back:** `GET /cases/by-process-instance/:pid/entity` → `{ entity, entityVersion }` (as a logged-in user, not the service key). This is how an e2e asserts that `persist` / `patchFlowstileCaseEntity` writes landed. **Timing trap:** the entity exists *immediately* (seeded with start-form data), but `persist`/`patch` writes only land after the task-completion signal round-trips — so poll until the *expected key* is present (and/or the workflow is `COMPLETED`), never just until the entity exists, or you'll assert on stale data.
- **Human task lifecycle (the SDK omits these by design — a workflow never completes a human task):** locate a case's open task with `GET /cases/by-process-instance/:pid` → `tasks[]` (a **trimmed** shape: `taskDefinition.code` nested, status, id — *not* the full `/tasks` list schema, and no `workflowId`). Filter by `taskDefinition.code` + `status` of `created`/`claimed` (`/tasks` is **not** filterable by `processInstanceId`), then `POST /tasks/:id/claim` (no body) and `POST /tasks/:id/complete` with `{ data: { ...submission fields } }` — the completion body key is **`data`**, not `submissionData`. An e2e drives the human side this way.
- **Fresh-start 404 race:** right after `POST /start`, `GET /cases/by-process-instance/:pid` **404s for a beat** until the workflow runs far enough to create its first task. Poll: treat 404 as "not ready yet" and retry, don't fail.

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
   Temporal: `pnpm exec tsx --tsconfig <repo>/tsconfig.base.json e2e/helpers/check-workflow.ts '<wfId>'`
   **run with `cwd: packages/worker`** (the `@temporalio/client` dep is the
   worker's, not hoisted — running from repo root fails with "tsx not found").
   Or use temporal-ui on :8080. `check-workflow.ts` returns only `{ status }`; to
   assert the workflow's **typed result**, drop a 10-line sibling that prints
   `JSON.stringify({ status, result })` — `const h = client.workflow.getHandle(id);
   const d = await h.describe(); const result = d.status.name === 'COMPLETED' ? await h.result() : null;`.

## 7 — Run the rubric to green (it was written in §1)

You already wrote `e2e/<slug>.spec.ts` in §1 as your red contract. Now run it and
drive it green. Shape (follow `order-fulfillment.spec.ts`): start the case via the
portal-start contract (§5), complete tasks via API logins as the right seeded users
(claim → complete, §5), assert case status, milestone states, the persisted case
entity, and the workflow's typed result. Then the full local CI gate:

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
- The milestone stepper derives from task statuses at read time, so a phase with
  **no human task** depends on its position. A **mid-plan** automated phase (a
  human task comes after it, as in loan-origination's CREDIT_ASSESSMENT) renders
  `achieved` once the next phase opens. A **trailing** automated phase (nothing
  after it, e.g. a final REIMBURSEMENT/PAYOUT) renders `skipped` once the case
  closes — the derivation can't tell "ran automatically" from "skipped via early
  exit" without a task. Two takeaways: assert `skipped` (not `achieved`) for a
  trailing automated milestone, and **put automated work mid-plan if you want it
  to read `achieved`.** (Surfacing trailing automated work as `achieved` is the
  lead use case for the proposed case-event log — see `docs/design-decisions.md`.)
- Case `status` derives from tasks: all-terminal = completed/cancelled — a case
  with only the first task completed already reads "completed" until the workflow
  creates the next task (brief; re-fetch after the signal round-trip in tests).
