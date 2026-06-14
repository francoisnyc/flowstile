---
title: Design Decisions
description: Records important design choices that shape Flowstile's product model and runtime boundaries.
---

# Flowstile Design Decisions

This note captures important design choices that shape Flowstile's product model and runtime boundaries. It is not a full spec. It exists to record why certain decisions were made so later implementation does not silently collapse them.

## Why Flowstile Uses Explicit Task Contracts

Flowstile intentionally uses a more explicit runtime task model than a single generic `data` payload.

The v1 runtime model distinguishes between:

- `inputData`
- `contextData`
- `submissionData`

Alongside those payloads, Flowstile distinguishes between:

- the input contract
- the context contract
- the submission contract

## Why Not Collapse Everything Into One Task Data Blob

A single task `data` object is initially simpler to explain, but it tends to overload too many meanings into one structure:

- workflow-provided input
- read-only supporting business context
- human-editable data
- human-submitted result

That simplicity becomes fragile once the product has to handle:

- partial form progress
- external systems of record
- RBAC-aware context delivery
- field visibility
- in-flight compatibility across form versions
- auditability of what the workflow supplied versus what the human changed

Flowstile separates these concerns because they evolve differently and are owned by different parts of the system.

## Ownership Boundaries

The runtime split supports a clearer ownership model:

- the workflow owns task meaning and provides the candidate task payloads
- Flowstile owns task persistence, validation, lifecycle, and authorized delivery
- the assignee edits only the submission payload

This keeps Flowstile from becoming an accidental system of record for the entire business object while still allowing it to manage human work durably.

## Why Context Is Separate

`contextData` exists because humans often need to see business information that they should not directly edit.

Examples:

- customer summaries
- historical approvals
- computed risk indicators
- external references
- read-only snapshots

If that information is collapsed into the same payload as editable submission data, the system becomes harder to reason about:

- it is less clear what the form is actually allowed to modify
- it is harder to filter sensitive context safely
- it is harder to explain compatibility rules

By separating context from submission, Flowstile can persist rich supporting data while still presenting a strict editable contract to the assignee.

## Raw Context vs. Effective Context

Flowstile distinguishes between:

- raw stored `contextData`
- effective context delivered to a specific user

The workflow or surrounding application assembles the candidate context for the task. Flowstile stores that context and then applies role/group visibility rules before sending any view of it to the browser.

This means:

- the workflow defines what context may be relevant
- Flowstile defines what context a given user may actually see

This split keeps business context assembly out of the UI while keeping security enforcement inside the product boundary.

## Why This Is Better Than a Simpler Unified Model

Compared to a unified task-data model, the explicit contract model gives Flowstile stronger footing in these areas:

- clearer workflow-to-task boundary
- safer handling of external business data
- better change management
- cleaner distinction between read-only and editable data
- stronger auditability
- easier future support for richer visibility policies

The tradeoff is extra conceptual weight. Flowstile accepts that tradeoff because the human-task product surface is already carrying workflow orchestration, identity, form versioning, and task lifecycle semantics. Making the data boundary explicit reduces accidental complexity later.

## Current Decision

Flowstile should keep the explicit `inputData`, `contextData`, and `submissionData` split in its design and runtime documentation.

If future implementation pressure suggests collapsing these concepts for convenience, that change should be treated as a real architectural decision rather than a harmless simplification.

## Why Visibility Is Need-to-Know, Not Just Permission-Gated

A coarse permission like `tasks:read` answers "may this user use the inbox at all" — but it does not answer "*which* tasks." Treating `tasks:read` as "see every task" leaks the entire work queue to anyone who can open the inbox: who is being investigated, which customers have escalations, how many exceptions are open. For a human-task layer that sits in front of sensitive business processes, that is the wrong default.

Flowstile instead follows the model Camunda established: a task is visible only to those with a reason to act on it — its assignee, its candidate users, or members of its candidate groups. Everyone else gets nothing, and a task with no candidates and no assignee is visible only to oversight rather than falling open to the whole tenant.

Three decisions fall out of this:

- **Candidates are per-instance, snapshotted at creation.** The task definition supplies defaults, but the read boundary lives on the task itself (`candidateUsers`/`candidateGroups` columns), overridable per `POST /tasks`. This mirrors form-version locking: changing a definition never silently re-scopes work already in flight, and a workflow can route a specific instance to a specific reviewer.

- **Hidden means 404, not 403.** A `403` on `GET /tasks/:id` confirms the task exists — enough to enumerate IDs and map the queue. Returning `404` for anything outside your need-to-know set means existence itself is not leaked, and the same rule covers claim/unclaim/complete/cancel and the search endpoint (so filtering on business fields can't be used as an oracle).

- **Case visibility is derived, not stored.** Rather than maintaining a separate per-case ACL (Camunda 7's authorization rows), a case is visible if you started it, can see one of its tasks, or hold oversight (`cases:read` / `tasks:manage`). One rule, evaluated at query time, keeps task and case scope consistent by construction.

Oversight is the deliberate escape hatch: the workflow engine (a service credential) and human supervisors (`tasks:manage`, or `cases:read` for cases) bypass instance scope entirely, because triage, reassignment, and auditing require a queue-wide view. The boundary is *need-to-know for operators, full-visibility for oversight* — not all-or-nothing.

## The Case Entity: An Authoritative, Read-Back Business-Data Tier

A case is a thin entity anchored on `processInstanceId` that aggregates the tasks and attachments sharing that key. Cases need somewhere to hold a small amount of cross-task business data — the facts that identify and summarize the case (applicant, amount, current stage) and that later steps may need to act on.

The first design treated this as a **display projection**: a denormalized, unvalidated, write-only snapshot of select facts, analogous to a materialized view. Case variables were explicitly *not* a source of truth — the Temporal workflow and task `submissionData` were authoritative, and the projection was allowed to be stale or incomplete. Full-replace writes, no read-back, no validation.

That position was reconsidered and **reversed**. The case entity is now an **authoritative, schema-validated, read-back-able business-data tier** — closer to Bonita's Business Data Model (BDM) and KuFlow's `process.entity` than to a cache.

### Why The Projection Model Was Too Weak

The argument originally given against read-back was determinism: that reading external mutable state mid-workflow would break Temporal's deterministic replay. **That argument was wrong.** Temporal workflows never read external state directly — they read through an *activity*, whose result is recorded in history and replayed deterministically. Reading the case entity through an activity is ordinary, Temporal-native I/O, exactly like the activity that creates a task. KuFlow (itself built on Temporal), Bonita, and Camunda all support read-back of process/business data; none of them violate determinism by doing so.

Once the determinism objection falls, the remaining objections are weak:

- **Availability coupling** — the workflow needs Flowstile up to read the entity. But this is already true for task creation, and Temporal activity retries turn a transient outage into a delay, not a failure.
- **Dual source of truth** — only arises if the same fact lives in *both* workflow variables and the entity and can drift. If the entity is the *home* for a piece of cross-task business data and it is not also threaded as a workflow variable, there is exactly one copy.

The decisive argument is the **patched / parallel workflow** case. When a long-running workflow is amended with `patched()` to add an in-flight branch (for example, an extra parallel approval), the new branch is code that did not exist when earlier tasks ran. It has no closure over data those tasks collected; if that data was passed transiently into a task's `inputData` and then discarded, the new branch cannot reach it. Manual variable threading is brittle precisely in the long-running, patchable, parallel processes Flowstile exists to serve. A durable, read-back-able entity is visible to any branch — old or new, before or after the patch — and is the clean solution.

### What The Authoritative Model Costs

Allowing read-back turns the entity from a write-through cache into shared mutable state, which has one real engineering consequence: **full-replace writes become unsafe** because parallel branches clobber each other (last write wins). The entity model therefore uses:

- **JSON Patch (RFC 6902) writes applied server-side under a row lock.** Each branch sends *operations*, which the server applies on top of whatever is current, inside a transaction. Two branches writing *disjoint* fields never conflict and need no coordination. This is what makes the parallel-approval case safe.
- **Schema validation after patch application.** When the process definition declares a `caseEntitySchema`, the resulting entity is validated (reusing the existing AJV pipeline that validates `submissionData`); an invalid result rejects the patch with 422 and rolls back.
- **An `entityVersion` counter** for optimistic concurrency. Disjoint-field writes do not need it; the rare same-field read-modify-write can pass `If-Match` / `expectedVersion` and retry on 409.

A full-replace write (`PUT`) remains available for initialization and migrations. When a `caseEntitySchema` is present, the lazy case row initializes its entity to `null` (an arbitrary scalar snapshot of `inputData` would likely violate the schema) and the workflow populates it; when no schema is present, the convenience scalar snapshot of `inputData` is retained as today's unvalidated behavior.

### Relationship To Other Engines

This places Flowstile's data model deliberately alongside the established BPM engines:

- **Bonita** separates transient/form data (validated by *contracts*), case/process variables, and the **BDM** (schema-defined, persistent, queryable, authoritative). Flowstile's task payloads + form-schema validation mirror the first; the case entity mirrors the BDM. Bonita's own guidance — *use business data for anything meaningful outside a single process* — is the same instinct behind the case entity.
- **Camunda** has only scoped variables (process vs task-local) with no schema validation and no separate business-data tier. It is the *least* like the authoritative entity; it resembles the rejected projection model.
- **KuFlow** has `process.entity`: schema-validated, authoritative, with `updateProcessEntity` (full replace) and `patchProcessEntity` (JSON Patch). The redesigned case entity is functionally equivalent.

The one deliberate divergence from Bonita/KuFlow: in those products the business-data tier substitutes for weak orchestration state, so it is the primary store. In Flowstile, **Temporal's durable workflow state remains the engine's source of truth**; the case entity is authoritative for the *cross-task business facts the workflow chooses to publish to it*, not a replacement for the workflow's own state. The workflow decides what belongs in the entity (identifying, summarizing, and cross-branch-shared facts) versus what stays private to its execution.

### Current Decision

The case entity is an authoritative, optionally schema-validated, read-back-able business-data tier, written via JSON Patch under a row lock with an `entityVersion` for optimistic concurrency. It is not a display-only projection. Documentation and SDK surface must describe it as something the workflow may legitimately read back and depend on — reversing the earlier "not a source of truth" framing.

## Positioning: Self-Hosted, Embeddable, Bring-Your-Own-Temporal

Adopting an authoritative case entity moves Flowstile's *data model* visibly toward KuFlow — which is itself a task/form/entity layer built on Temporal. This convergence is acceptable and even correct: KuFlow and Bonita independently arrived at this shape because it is the right shape for human-in-the-loop work over a workflow engine. Being contrarian about the data model for the sake of differentiation would make Flowstile worse, not different.

The differentiation must therefore live in **positioning**, not in the data model. Flowstile is deliberately:

1. **Bring-your-own-Temporal.** KuFlow is a hosted destination that owns the Temporal cluster and the workflow lifecycle. Flowstile runs against the *user's* Temporal cluster and *user's* workflow code. The pitch is "add a durable human-task inbox to the Temporal you already run," not "move your processes into our platform." The workflow author keeps orchestration; Flowstile is the human-task layer.

2. **SDK-first / embedded developer experience.** `createTaskAndWait` reads like an ordinary `await` inside an ordinary Temporal workflow. The author writes Temporal, not a Flowstile-shaped framework. This ergonomic — human tasks as function calls — is a primary asset and must be protected as the entity model grows.

3. **Embeddable, not portal-only.** `@flowstile/react` lets developers drop Flowstile task forms into their own applications. Flowstile may offer a portal, but it is also a component library embedded in third-party apps, not solely a destination users log into.

### Current Decision

Flowstile adopts the BPM-standard authoritative data model deliberately, and differentiates on positioning: **open, self-hosted, embeddable, riding the user's own Temporal cluster.** The failure mode to avoid is converging on KuFlow's data model *and* its portal-first, platform-owns-Temporal positioning simultaneously — at which point Flowstile would simply be a weaker KuFlow. Any move that makes Flowstile own the Temporal cluster or become portal-only should be treated as a real strategic decision, not an incremental product step.

## Declarative for Data, Imperative for Control

`contextFrom` and `persist` (the task variable mappings) are declarative because they are **pure data plumbing** — copy a case variable into a task's context, copy a submission field into the case entity, optionally rename. They carry no expressions and no transforms.

Everything that is **control flow** — sequencing, branching, loops, timeouts, compensation/saga — stays in the workflow body as ordinary TypeScript. This line is deliberate and load-bearing:

- It keeps a single source of truth. The workflow *is* the orchestration; nothing in declarative config can reorder or gate it.
- It avoids the BPMN-engine trap of an expression language (FEEL / JUEL / Groovy) that becomes a second, weaker place business logic lives and silently drifts from the code that actually runs.
- It is the same reasoning behind "the case plan never gates execution" and "no calculated fields": the declarative surface is for **data and display**; the imperative surface (workflow code) is for **logic**.

The test for any future SDK ergonomic: if it copies/renames/projects *data*, it may be declarative; if it sequences, branches, retries, or compensates (*control*), it belongs in the workflow body. Ship helpers that *compose* primitives, not constructs that *bundle* control flow into a method signature.

## BPMN Constructs Map to Temporal Code, Not Flowstile Features

A recurring question when evaluating Flowstile against BPMN engines (Camunda, Bonita, KuFlow) is "where is the service task / connector / external task / subprocess / saga?" The consistent answer: **a BPMN engine bundles these into a visual model because a diagram is its medium; Temporal unbundles every one of them into composable code, which is strictly more flexible.** Flowstile therefore does *not* grow them as features — that would reimplement, worse, what Temporal already provides:

- **Service task** → a Temporal activity.
- **Connector (in/out)** → data mapping is `contextFrom`/`persist`; the external call is an activity. Its retry/replay is Temporal's retry policy + the Temporal UI — automatic, and better than a manual "replay this connector" button.
- **External task** → a Temporal task queue (pull-based workers) or async activity completion (hand-off-and-complete-later). Temporal task queues *are* external tasks, done right.
- **Subprocess / sequence** → a function, sequential `await`, or a child workflow for isolation.
- **Saga / compensation** → a compensations array in the workflow. Critically, **saga cannot cross a human-task commit**: a completed human task is an audited, irreversible decision, so you compensate the automated steps and *escalate* the human one (forward recovery), never roll it back. The Order Fulfillment demo models this correctly.

Two firm boundaries follow:

- **The SDK does not complete tasks.** The workflow creates and cancels; the human claims and completes through the UI; the workflow learns the result via a per-task Temporal signal. Adding `claimTask`/`completeTask` would pull task-state ownership into Flowstile and erode the bring-your-own-Temporal distinction — and programmatically completing a *human* task forges its `completedBy` audit. If code can do the work, it is an activity, not a human task.
- **No connector / external-task / replay engine in Flowstile.** Dispatch, retry, and replay are Temporal's job (the territory, and it does them better than the BPMN engines). Flowstile's job is the human-work layer and the *business-facing view* of what happened (the map).

## Surfacing Automated and Agent Work: A Case-Event Log (Proposed — Not Built)

> **Status: design direction, not implemented.** Recorded so the shape is agreed before any code.

The asymmetry above has a cost. KuFlow makes automated work a first-class "automatic task" the worker completes programmatically, so it appears in the process view *for free* — its **symmetric** SDK buys uniform visibility of human and automated steps. Flowstile's **asymmetric** SDK (human-only completion) buys clean human-decision semantics but means automated steps (Temporal activities) are **invisible** in the case view: only their *results* land in case variables, and the milestone stepper jumps over automated phases.

The principled answer — consistent with "Flowstile records the business map, Temporal owns the execution territory" — is **not** to make automated work a completable task (that reopens the completion boundary) and **not** to read Temporal history into the case view (that is the execution territory: noisy, developer-facing, coupling). It is an **optional, display-only case-event log the workflow publishes to**: a `recordCaseEvent({ actor, label, payload, at, phase? })` primitive, plus an ergonomic `recordedActivity` wrapper that runs an activity, projects its result, and logs it. Properties:

- **Display-only / read-model.** The workflow never *depends* on it; same relationship the case entity has to workflow state — a curated business view, not an authority. It passes the read-model scope test only while it stays optional and display-only.
- **Actor-tagged.** `actor: human | system | agent` gives automated steps and AI agents a *first-class, honestly-labeled* slot in the timeline — the alternative to letting an agent masquerade as a human by completing a task.
- **Curated, not a Temporal mirror.** The workflow records the business-meaningful moments with projected payloads (like `persist`'s allowlist), not every internal activity. The full execution trace stays in the Temporal UI for developers.
- **Carries an instrumentation cost.** Every recorded event is a line of workflow code, so it is opt-in, never automatic — the same trade weighed for the milestone stepper.

This one primitive answers several otherwise-separate requests — service-task visibility, connector-execution visibility, RPA/agent actors in the case view, and the milestone stepper's long-automated-phase gap. That convergence is the signal it is the right abstraction rather than four features.
