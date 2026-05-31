---
title: Runtime Contract
description: Defines the runtime contract between Temporal workflows, the Flowstile server, worker, and web inbox.
---

# Flowstile Runtime Contract

This note defines the runtime contract between Temporal workflows, the Flowstile server, the Flowstile worker, and the web inbox. It exists to make the first implementation phases precise enough that the SDK, API, and UI do not drift into accidental behavior.

The goal is not to over-model every future edge case. The goal is to make v1 behavior explicit where ambiguity would otherwise leak into the architecture.

## Purpose

Flowstile manages human work around Temporal workflows. At runtime, that means the system must answer six questions clearly:

- what a workflow must provide when creating a task
- what Flowstile persists on the task instance
- what the assignee can see and edit
- who may act on a task
- what happens when a task is completed
- how versioning affects in-flight work

This document defines the answers for v1.

## Runtime Ownership Boundaries

The runtime responsibilities are split across four layers.

### Workflow

The workflow decides:

- when human work is needed
- which task definition to invoke
- what `inputData` is required for task creation
- what candidate `contextData` should be provided for the task
- how completion data is reconciled back into the system of record

The workflow remains the orchestrator and may continue to own the canonical business record outside Flowstile.

### Flowstile Server

The server owns:

- authentication and authorization
- task-definition lookup
- form-version resolution
- task persistence
- validation of runtime task contracts
- task lifecycle transitions
- visibility filtering before data reaches the browser

The server is the system of record for task state and task-local payloads.

### Flowstile Worker

The worker owns:

- activity-side communication with the server from workflow code
- reliable routing of task completion back into Temporal
- retry and delivery concerns between task completion and workflow resumption

The worker should be treated as the Temporal-facing delivery layer, not as the source of truth for task state.

### SDK

The SDK owns:

- an ergonomic API for workflow authors
- shaping create-task requests
- shaping completion results returned back into workflow code

The SDK should not invent semantics that differ from the server contract. It is a typed wrapper over the runtime contract, not a second product surface with its own behavior.

## Runtime Task Payload Model

Flowstile v1 treats runtime task data as three related but distinct payloads.

### Input Data

`inputData` is the workflow-provided payload validated at task creation time.

Its purpose is to make task creation explicit and reproducible. It answers: what did the workflow provide when it asked Flowstile to create this task?

`inputData` should be:

- validated when the task is created
- persisted for auditability and reproducibility
- immutable after task creation in normal operation

Examples:

- identifiers such as `CUSTOMER_ID`
- workflow-derived task parameters
- initial business facts required for the task to exist at all

### Context Data

`contextData` is the display-oriented payload made available to the assignee.

Its purpose is to help a human understand the work without making that data part of the editable submission surface by default.

The workflow or surrounding application owns context assembly. Flowstile owns context delivery. That means the workflow provides the candidate context payload to persist with the task, and Flowstile produces the effective context view delivered to a specific user after applying authorization and visibility rules.

`contextData` may include:

- read-only business snapshots
- display labels
- computed summaries
- supporting reference data
- external record references

`contextData` should be:

- persisted with the task
- treated as read-only from the assignee's perspective
- filtered by authorization rules before delivery to the browser
- allowed to evolve more additively than submission data

The raw stored `contextData` should not be assumed browser-safe. The UI should receive only the effective context projection for the current user.

### Submission Data

`submissionData` is the editable payload governed by the form contract and returned on completion.

Its purpose is to capture the structured human result of the task.

`submissionData` should be:

- validated against the locked form version at completion time
- persisted during the task lifecycle, including partial progress
- the only payload directly edited by the human assignee in v1

Examples:

- approval decisions
- entered notes
- structured review outcomes
- corrected field values

## Contracts

Flowstile v1 uses three related contract ideas.

### Input Contract

The input contract defines what must be present for task creation to succeed.

It should answer:

- which fields are required from the workflow
- which fields are optional
- which values are allowed
- what shape nested structures must have

If a create-task request does not satisfy the input contract, the task should be rejected before persistence.

### Context Contract

The context contract defines the expected structure of supporting display data.

This contract is intentionally looser than the submission contract. It exists to keep the workflow-to-task boundary understandable without forcing every additive display field to become a breaking change.

In v1, the context contract should be conceptually explicit even if the implementation begins with lighter validation than the submission contract.

The context contract answers what may be stored with the task. Authorization and visibility rules answer what subset of that context may be delivered to a particular user.

### Submission Contract

The submission contract defines what counts as a valid task completion payload.

It should enforce:

- required fields
- field types
- structural shape
- validation constraints
- field-level rules that determine whether the task may be completed

This is the strictest contract in the system because it governs what resumes the workflow.

## Relationship Between Contracts and Forms

Flowstile v1 should follow this rule:

The contract defines what data is valid. The form definition defines how users navigate and edit that data.

That means:

- the form definition governs editing behavior, layout, widgets, and flow
- the submission contract governs the validity of the human-submitted payload
- the workflow governs which input and context payloads are supplied at runtime
- the server governs which subset of context and submission fields are visible to a given user

For v1:

- `TaskDefinition` defines task identity, process association, assignment rules, and default operational behavior
- `FormDefinition` defines the editable submission surface and the effective versioned submission contract
- the workflow-defined input contract is validated at task creation time as part of the runtime task contract

The system may later separate contract schemas more explicitly if that becomes necessary, but v1 should avoid introducing extra top-level modeling concepts before they pay for themselves.

## Create-Task Contract

The most important runtime boundary in v1 is task creation.

### Required Semantics

A create-task request must provide enough information for Flowstile to:

- resolve the task definition
- resolve the published form version
- validate the input payload
- persist the task instance
- determine assignment eligibility
- render the task later without re-deriving its meaning from workflow history

### Proposed Request Shape

The exact JSON can still evolve, but the semantic fields for v1 should be:

- `taskDefinition`: stable task definition code
- `workflowId`: Temporal workflow identifier
- `processInstanceId`: correlation identifier for related work
- `inputData`: workflow-provided task-creation payload
- `contextData`: optional display/supporting context
- `submissionData`: optional initial editable payload
- `assignTo`: optional runtime override for candidate users/groups if v1 allows it
- `priority`: optional override of the task definition default
- `dueDate`: optional due date
- `followUpDate`: optional follow-up date

### Validation Rules

At task creation time, the server should:

1. resolve the `TaskDefinition`
2. resolve the latest published `FormDefinition` version referenced by that definition
3. validate `inputData` against the task's input expectations
4. validate any initial `submissionData` against the editable submission contract if prefill is allowed
5. persist the task with the resolved form version locked

In v1, the locked form version is the effective submission-contract version for the task instance.

### Immutability

After creation, these values should normally be immutable:

- `taskDefinitionId`
- `formDefinitionVersion`
- `workflowId`
- `processInstanceId`
- `inputData`

The main mutable payload during runtime is `submissionData`.

## Editing Model

Flowstile v1 should keep the editing model simple:

- `inputData` is not directly edited by the assignee
- `contextData` is read-only from the assignee's perspective
- `submissionData` is the editable payload

The UI may display values from `contextData` and `submissionData` together, but only `submissionData` should be treated as the form's writable surface.

If `submissionData` needs initial values derived from workflow input, that derivation should be explicit at task creation rather than magical at render time.

When the UI renders a task, it should receive:

- filtered effective context for the current user
- filtered editable submission fields for the current user
- the locked form definition version used to interpret those payloads

## Access Model

Flowstile v1 should separate capability authorization from task eligibility.

### Capability Authorization

Capability authorization answers: what actions may this user perform at all?

The implemented permission set:

- `tasks:read` — use the inbox (list/open tasks within need-to-know scope)
- `tasks:write` — claim, unclaim, complete, cancel
- `tasks:manage` — oversight: see and act on every task, bypassing instance scope
- `cases:read` — oversight: see every case, bypassing case scope
- `forms:write` — author and publish forms
- `processes:write` — define processes and task definitions
- `processes:start` — start a process instance from the portal
- `users:manage` — administer users, roles, and groups

These permissions come from roles. A service credential (API key) is treated as full oversight for tasks and cases.

### Task Eligibility (Need-to-Know)

Task eligibility answers: which specific task instances may this user see and act on?

`candidateUsers` and `candidateGroups` are **per-instance** columns on the task. They are snapshotted from the task definition at creation time (and may be overridden on `POST /tasks`); in-flight tasks are never retroactively rebound when the definition's candidate lists change.

A non-oversight user is task-eligible when one of the following is true:

- the task is assigned to that user
- the user's email is listed in the task's `candidateUsers`
- the user belongs to a group listed in the task's `candidateGroups`

This is a strict need-to-know boundary. A task with **no** candidates and **no** assignee is visible only to oversight — it does not fall open to every `tasks:read` holder.

Eligibility is task-instance scope. Capability (permissions) is product scope. Both must pass for task operations.

**Oversight** bypasses instance scoping entirely:

- a **service credential** (the workflow engine), or
- a human holding `tasks:manage` (all tasks), or — for cases — `cases:read` (all cases).

The same principle applies to context delivery. A user authorized to read a task still receives a narrower effective field view based on the form's role/group visibility policy.

## Task Access Rules

These rules are enforced server-side, not in the browser.

### List and Search

`GET /tasks` and `POST /tasks/search` are **SQL-scoped**: the query is narrowed to rows the caller is eligible for (assignee, candidate user, or candidate group), so ineligible tasks are never returned. Oversight principals skip the narrowing. This also closes the search-oracle: a caller cannot probe for hidden tasks by filtering on their fields.

### Open

`GET /tasks/:id` requires `tasks:read` **and** eligibility. When the task exists but the caller is not eligible, the server returns **`404 Not Found`** — not `403` — so that task existence is not leaked.

### Claim

To claim a task, the user must:

- have `tasks:write`
- be eligible — and the same `404` rule applies: an ineligible caller gets `404`, not `403`
- and the task must be in `created` state

When `candidateGroups` and `candidateUsers` are both empty, the task is uncandidated and only oversight can see (and therefore claim) it.

### Unclaim

To unclaim a task, the user must be eligible to see it (else `404`), have `tasks:write`, and either be the current assignee or hold `tasks:manage`.

### Complete

To complete a task, the user must be eligible to see it (else `404`), have `tasks:write`, be the current assignee, and the submission must pass validation.

### Cancel

To cancel a task, the user must be eligible to see it (else `404`), have `tasks:write`, and either be the assignee, hold `tasks:manage`, or (for a `created` task) act through the trusted workflow/server path.

The `404`-over-`403` rule is deliberate: every single-task operation hides existence from non-eligible callers. Oversight (`tasks:manage` / service) sidesteps all of the above.

## Case Access Rules

A **case** inherits its visibility from its tasks. A case is visible to a caller who:

- **started** it (`startedById` matches), or
- can see **at least one** of its tasks (by the task eligibility rules above), or
- holds case oversight — `cases:read` or `tasks:manage`, or is a service credential.

This applies to `GET /cases` (list is filtered per case), `GET /cases/:id`, `GET /cases/by-process-instance/:processInstanceId`, and every `/entity` read and write endpoint. As with tasks, a case the caller may not see returns **`404`**, not `403`.

## Unclaim and Reclaim Semantics

Unclaiming a task should preserve useful work.

In v1:

- `submissionData` remains stored when a task is unclaimed
- raw `contextData` remains stored
- `inputData` remains stored
- the next eligible claimant sees the same task contract and the current partial submission state

This avoids lost effort and keeps reassignment auditable.

## Completion Contract

Task completion is the second major runtime boundary after task creation.

### Completion Means

Completing a task should:

1. validate `submissionData` against the locked form/submission contract
2. persist the final submission payload
3. transition task status to `completed`
4. record completion metadata
5. trigger reliable delivery back into Temporal

The validation order is fixed: the state-machine transition is checked first (a non-completable task returns `409` before any payload is examined), then non-writable fields are stripped, then `submissionData` is validated against the locked `jsonSchema` (`422` on failure).

### Outcome Buttons

A form may declare an optional `outcomes` array with an `outcomeKey` (default `DECISION`). These render as explicit completion buttons (e.g. Approve / Reject) instead of a single Complete button, but they do not change the completion contract:

- Clicking an outcome completes the task through the same endpoint with `data[outcomeKey] = value`. No new lifecycle states, endpoints, or signal payloads.
- `outcomeKey` is a real string-enum property in `jsonSchema`, so the schema validation above already rejects unknown outcome values (`422`).
- As defense in depth, when a form declares outcomes the server additionally verifies the submitted value is one of the declared outcomes and that the chosen outcome's `requireFields` are present (`422` otherwise). This runs after schema validation, so it never overrides a `409` state error.

### Completion Envelope

The workflow should not receive only an unstructured blob. It should receive a completion envelope with enough metadata to remain stable over time.

The v1 completion envelope should include:

- `taskId`
- `taskDefinition`
- `formDefinitionCode`
- `formDefinitionVersion`
- `submissionData`
- `completedBy`
- `completedAt`

This keeps workflow code from depending on hidden context and improves auditability.

## Delivery and Retry Semantics

Completion delivery back into Temporal is reliable, not a best-effort inline side effect. It is implemented as a **transactional outbox** with at-least-once delivery.

The important failure case is:

- task completion is persisted successfully
- but signal delivery to the workflow does not succeed immediately (Temporal down, network partition, process crash)

The outbox ensures this is always recoverable without data loss or user confusion.

### Transactional Outbox

When a task reaches a terminal state (`completed` or `cancelled`) and Temporal is configured, the server writes a `signal_outbox` row **in the same database transaction** that persists the task state change. Task state and delivery intent therefore commit atomically: if the task is durably terminal, the signal is durably queued. A crash at any point cannot leave a completed task with no queued signal.

A background **signal relay** drains the outbox:

- it polls for `pending` rows whose `nextAttemptAt` is due
- it locks rows with `FOR UPDATE SKIP LOCKED`, so multiple server instances can run the relay without double-delivering
- on success the row is marked `delivered`
- on a transient error the attempt count increments and the row is rescheduled with exponential backoff
- when the workflow no longer exists, or `maxAttempts` is exhausted, the row is marked `failed`

Because the relay retries across process restarts and Temporal outages, delivery is **at-least-once**. Workflow signal handlers are keyed by `taskId` and should be idempotent.

### Signal Delivery Lifecycle

Each terminal task carries a `signalStatus` field that projects the outbox outcome for easy querying:

| Status | Meaning |
|---|---|
| `not_applicable` | Temporal is not configured (no signal is queued) |
| `pending` | Queued in the outbox; delivery in progress or awaiting retry |
| `delivered` | Signal acknowledged by Temporal |
| `failed` | Workflow gone or all retries exhausted; workflow is out of sync |

`signalDeliveredAt` and `signalFailedAt` timestamps are set accordingly. The relay updates both the outbox row and this projection as outcomes resolve.

### Recovery

An operator with `tasks:manage` can re-queue a failed or stuck delivery:

```
POST /tasks/:id/retry-signal
```

This resets the task's outbox row to `pending` (attempts cleared) so the relay re-attempts delivery. It does not deliver inline — the endpoint returns immediately with `signalStatus: pending`.

### Monitoring

Operators can query for all tasks with delivery failures:

```
GET /tasks?signalStatus=failed
POST /tasks/search  { "signalStatus": "failed" }
```

## Failure Semantics

The system should fail clearly at the main boundaries.

### Task Creation Failure

Task creation should fail when:

- the task definition does not exist
- no published form version can be resolved
- the input contract is not satisfied
- runtime overrides violate task-definition constraints

These failures should be surfaced to workflow code as explicit creation errors.

### Task Completion Failure

Task completion should fail when:

- the task is not in a completable state
- the acting user is not authorized
- the acting user is not the current assignee
- `submissionData` violates the locked submission contract

These failures should be returned synchronously to the UI/API caller.

### Delivery Failure After Completion

If completion persistence succeeds but workflow delivery is delayed, the task should remain completed in Flowstile. Delivery recovery belongs to the integration layer, not to the end user.

## Versioning and Change Management

Version discipline should follow the task contract, not just the visual form.

### Safe-ish Changes

Generally lower-risk changes include:

- label and help-text changes
- layout-only `uiSchema` changes
- additive optional context fields
- additive display-only context changes
- additive context visibility rules that only further restrict exposure without changing the stored task contract

### Version-Requiring Changes

Changes that should be treated as contract changes include:

- required-field changes in `submissionData`
- field-type changes in `submissionData`
- renamed or removed submission keys
- validation changes that reject previously valid submissions
- new required `inputData` fields

### Runtime Locking

At task creation:

- the published form version is resolved
- the task locks to that form version
- the runtime expectations for `inputData`, `contextData`, and `submissionData` are bound to that locked version

In-flight tasks are not retroactively rebound to later contracts.

For context specifically:

- raw stored `contextData` remains part of the locked task record
- effective context delivery may still vary by viewer because authorization-aware projection happens at read time
- visibility-policy changes may change what a given user sees without mutating the stored task payload

## First Canonical End-to-End Flow

This is the reference story the implementation should continuously test against.

1. Workflow code calls `createTaskAndWait`.
2. The SDK issues a create-task request with task definition code, workflow metadata, and runtime payloads.
3. The server resolves the task definition and latest published form version.
4. The server validates `inputData` and accepts any valid initial `submissionData`.
5. The server persists the task with locked version, task state, and runtime payloads.
6. The task appears in the inbox for eligible users.
7. An eligible user claims the task.
8. The server returns effective context, filtered form definition, and current filtered `submissionData` for that user.
9. The assignee edits `submissionData`.
10. The assignee submits completion.
11. The server validates the completion payload, marks the task completed, and persists completion metadata.
12. The worker delivers the completion envelope back into Temporal.
13. The workflow resumes with the structured result.

If the implementation supports this flow cleanly, the core runtime contract is working.
