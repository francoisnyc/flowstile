---
title: Process Authoring Guide
description: Step-by-step guide to authoring a Flowstile process — from code-first definition through forms, types, case visibility, change management, versioning, and process mining. Doubles as the roadmap for the process-visibility and DX work.
---

# Process Authoring Guide

This guide walks through the full life of a Flowstile process: defining it in code, binding tasks to forms, generating types, running it, giving end users a map of where their case stands, and changing it safely after it ships. It describes the **target developer experience**. Steps that exist today are marked **Shipped**; steps that are planned are marked **Planned (Phase N)** and collected in the [roadmap](#roadmap) at the end. The guide is therefore both documentation and plan: when a phase ships, its sections stop being aspirational and the document stays true.

## Principles

Four decisions shape everything below. They are worth internalizing before reading the steps.

**The workflow is the territory; the case plan is a map.** Flowstile workflows are imperative Temporal code. Only the code executes, so only the code is authoritative about what *will* happen. Anything we show users about the future — phases, milestones, expected steps — is a declared, deliberately lossy map of that territory. Maps are allowed to simplify; they are not allowed to drive execution. Nothing in the case plan ever gates task creation or workflow progress. (Camunda solves model/code drift by making the diagram executable; Temporal solves it by deleting the diagram. Flowstile's position: keep the diagram as a *view*, and keep it honest mechanically — see step 7.)

**Orientation, not prediction.** Users asking "what happens after I approve this?" want a stable mental model, not a runtime prediction of an imperative program. The case plan answers the orientation question (4–6 named phases in narrative order). It does not attempt to express conditionals, parallel branches, or sagas — those live in the timeline of what actually happened.

**A contract, not a guess — the OpenAPI discipline, applied to processes.** Flowstile already treats `docs/openapi.yaml` as a declared contract that CI proves the code conforms to (`openapi:generate && git diff --exit-code`). The case plan gets the same treatment: declared in code next to the workflow, projected to the server, and conformance-checked in CI so it cannot silently drift from what the workflow can actually do.

**Code owns structure; the server owns forms; ops config is shared.** Process structure (task codes, phases, plan order, task queue, workflow type) is authored in code, because it is inseparable from the workflow. Forms are authored in the UI designer, because form schemas are the type-bearing, business-editable artifact. Operational config (candidate groups/users, priorities) gets *defaults* from code and *overrides* from the UI/API; sync never clobbers an override.

---

## Step 1 — Define the process in code

**Status: partially Shipped — `defineProcess`/`defineTask` exist; `plan` and `phase` are Planned (Phase 1).**

A process is declared once, co-located with the workflow that implements it:

```typescript
import { defineProcess, defineTask } from '@flowstile/sdk/process';

export const loanProcess = defineProcess('Loan Origination', {
  taskQueue: 'flowstile',
  // The case plan: ordered business phases, as users should understand them.
  plan: ['Application Review', 'Credit Assessment', 'Underwriting', 'Final Decision'],
  tasks: {
    reviewApplication: defineTask<ReviewOutput>('REVIEW_APPLICATION', { phase: 'Application Review' }),
    verifyIdentity:    defineTask<IdentityOutput>('VERIFY_IDENTITY',  { phase: 'Application Review' }),
    requestDocuments:  defineTask<DocsOutput>('REQUEST_DOCUMENTS',    { phase: 'Application Review' }),
    assessRisk:        defineTask<RiskOutput>('ASSESS_RISK',          { phase: 'Underwriting' }),
    seniorReview:      defineTask<SeniorOutput>('SENIOR_REVIEW',      { phase: 'Underwriting' }),
    approveLoan:       defineTask<ApprovalOutput>('APPROVE_LOAN',     { phase: 'Final Decision' }),
    handleFraudFlag:   defineTask<FraudOutput>('HANDLE_FRAUD_FLAG',   { phase: null }), // exception path, unphased
  },
});
```

Rules of the plan:

- **Phases map N:1 to task definitions.** "Application Review" spans three task definitions, one of which (`REQUEST_DOCUMENTS`) may be created zero or many times at runtime. A phase also spans N task *instances* — rework loops create repeated instances under one stable phase.
- **A phase may have zero tasks.** "Credit Assessment" can be fully automated (a Temporal activity). It will appear on the map and in mined statistics (step 9), but task-based state inference will jump over it (see step 6).
- **Exception tasks are explicitly unphased** (`phase: null`). The plan is the happy path on purpose. Do not try to express "shipped OR refunded" in the plan — that is the road to CMMN sentries and the brittleness this design exists to avoid.
- **Workflow code never references phases.** No `reachMilestone()` calls, no query handlers, no per-workflow boilerplate. The phase mapping lives entirely in the declaration above.

## Step 2 — Run the worker: self-registration and the doctor

**Status: Planned — doctor preflight (Phase 2), dev-mode sync (Phase 3). Today, process and task definitions are created via the REST API or seed script, and `workflowType`/`taskQueue` are set on the process definition manually.**

In dev mode (`pnpm dev`), starting the worker does two things beyond hosting workflows:

**Sync (push, not pull).** The worker upserts the process definition from the declaration in step 1: process name, task queue, the plan, task definition stubs with their phase links, and `workflowType` derived from the registered workflow function — eliminating the double-entry of queue and type strings. This is the `prisma db push` pattern: automatic in dev, **never automatic in production**. Production sync is an explicit, reviewed step (`flowstile-codegen sync`) in CI/CD, like a migration. Sync owns structure fields only; candidate groups, candidate users, and priority are written on create and never overwritten thereafter (UI/API edits to those are durable).

**Doctor (preflight).** On every boot — dev or prod, sync or no sync — the worker validates its declarations against the server and prints a table:

- every `defineTask` code exists as a task definition;
- every task definition's form code has a **published** version;
- the process's `workflowType` matches a workflow function this worker registers;
- the generated types file is current (see step 4).

In dev the doctor fails loudly; in prod it warns. This is the single highest-value seam check in the system: a typo'd task code becomes a red line in the terminal two seconds after save, instead of what it is today — a workflow that runs, retries a 404 three times, and dies in the Temporal UI while the Flowstile case sits silently empty.

## Step 3 — Design forms in the UI, and how tasks bind to them

**Status: Shipped.**

Forms are authored in the form designer (`/forms`): visual builder, raw JSON Schema source, outcomes, preview. Forms have a draft/published lifecycle — `PUT /forms/:code/draft` upserts the draft (200 update / 201 create); `POST /forms/:code/publish` atomically locks the draft and increments the version.

### Task → form mapping, precisely

The binding chain has one deliberate indirection and one deliberate snapshot:

```
TaskDefinition ──formDefinitionCode──▶ FormDefinition (code, many versions)
      │                                       │
      │ task created (POST /tasks)            │ latest PUBLISHED version resolved
      ▼                                       ▼
    Task ◀────formDefinitionVersion────── snapshotted onto the task, immutable
```

- **Binding is by stable `code`, never by version or UUID.** A task definition says "this work uses form `LOAN_REVIEW`", not "version 3 of form `LOAN_REVIEW`".
- **At task creation**, the server resolves the latest *published* version of that code and stamps `formDefinitionVersion` onto the task. If no published version exists, creation fails with `422` — the workflow cannot create work nobody can complete.
- **From that moment the task is locked.** Reads render the snapshotted version (with field-level visibility rules applied server-side); completion validates `submissionData` against the locked schema (state machine checked first: `409` before `422`). Publishing a new form version never rebinds in-flight tasks.

So when form `LOAN_REVIEW` goes from v1 to v2 mid-flight: tasks created before the publish render and validate against v1 forever; tasks created after get v2. Two assignees can simultaneously hold the "same" form at different versions, each internally consistent. The same snapshot philosophy applies to candidate users/groups (copied from the task definition at creation, overridable per-instance) — and, once process versioning ships (step 8), to the case plan itself.

## Step 4 — Generate types

**Status: Shipped (manual CLI). Staleness detection and watch mode Planned (Phase 3).**

`flowstile-codegen --process "Loan Origination" --task-queue flowstile` pulls the process, its task definitions, and each linked form's published JSON Schema from a running server, and emits a typed `process.ts`: one TypeScript interface per form output, wired into `defineTask<T>` descriptors. This is the *pull* direction — form schemas are server-authored, so their types flow down into code (the mirror of step 2's structure push).

Two planned improvements close the loop:

- **Staleness hash.** The generated file embeds a content hash of its source form schemas. The doctor (step 2) compares it on boot: *"`process.ts` is stale — form LOAN_REVIEW is now v3 (generated against v1)."* Stale types stop being silent.
- **Watch mode.** `flowstile-codegen --watch` (or regeneration folded into the worker's dev process) regenerates on form publish. Combined with `tsx watch`, publishing a breaking form change in the UI becomes a TypeScript error in the workflow within seconds. This is the moment the two authoring worlds — UI forms and code workflows — behave like one system.

**If you skip codegen entirely**, nothing is unsafe: descriptors degrade to `Record<string, unknown>` outputs, and the doctor still validates codes and published forms at boot. You lose types, not correctness feedback.

## Step 5 — Write the workflow

**Status: Shipped.**

The workflow is ordinary Temporal TypeScript. Human steps are `await descriptor.createAndWait({...})`; everything else — branching, loops, parallelism, saga compensation — is plain code. The phase declarations from step 1 impose nothing here. See `packages/worker/src/order-fulfillment/workflow.ts` for the canonical example (approval → payment → shipment confirmation, with compensation and an unphased exception task).

Failure semantics when the seams are broken anyway (**hardening Planned, Phase 2**): task-creation failures that cannot heal by retrying (`404` unknown task code, `422` no published form) are marked **non-retryable** with a remediation message naming the closest matching code and the fix, instead of today's three futile retries. The activity fails the workflow fast, and the failure is *visible in Flowstile* — see step 6.

## Step 6 — Run a case: the stepper, the timeline, and failure visibility

**Status: timeline Shipped. Phase stepper, computed phase states, and workflow-failure surfacing Planned (Phases 1–2).**

`POST /processes/:id/start` validates start-form data, starts the Temporal workflow, and creates the case. The case page then shows two layers, one per audience altitude:

**The phase stepper (the map).** A horizontal stepper across the top renders the plan: each phase **pending**, **active**, **achieved**, or **skipped**. Phase state is a **pure read-time projection** computed in `GET /cases/:id` from the tasks that already exist — no events table, no workflow cooperation:

- a phase with an open (created/claimed) task is *active*; the current phase is that of the most recently created open task;
- phases earlier in plan order render *achieved*, later ones *pending*;
- when the case ends, phases that never saw a task render *skipped* — a closed case never shows an eternally-pending phase (an order rejected at approval skips "Shipment" visibly, rather than appearing stuck);
- a zero-task automated phase jumps from pending to achieved when a later phase's task appears; if that ever matters for a days-long automated phase, an explicit override can be added later — it is deliberately not built first;
- rework moves the bar *backward* (a new Application Review task after Underwriting re-activates the earlier phase). That is the truth, shown honestly.

Because the state derivation is a pure function over existing rows, it can be tuned later (e.g., to a monotonic high-water mark) without touching stored data.

**The task timeline (the territory).** The existing flat, `createdAt`-ordered timeline of real task instances, including unphased exception tasks. It is intentionally *not* grouped by phase: grouping breaks chronology under loops and exceptions, and the stepper already answers the orientation question.

**Failure visibility.** A failed workflow must not look like a quiet, empty case. `GET /cases/:id` consults Temporal for workflow status and the case page says "workflow failed" with the failure summary. This matters beyond developer experience — operators will hit it even when nothing in this guide was done wrong.

The embeddable `@flowstile/react` package consumes the same computed `milestones: [{ code, name, state }]` from the case endpoint, so third-party apps get the stepper without reimplementing the derivation.

## Step 7 — Change management: conformance in CI

**Status: Planned (Phase 3).**

The plan is a static declaration and *will* drift from the workflow unless something stops it. Something stops it: a CI step statically extracts, via AST walk, the set of task codes the workflow can reach (every `.createAndWait()` call site on a literal-coded descriptor) and asserts:

1. **Placement** — every reachable task code is either assigned a phase or explicitly `phase: null`. Catches "added a task, forgot to put it on the map." *Hard failure.*
2. **Liveness** — every task the plan references is actually reachable in the code. Catches "deleted/renamed a task, the plan points at a ghost." *Hard failure.*
3. **Order plausibility** — the plan's phase order does not grossly contradict observed call order. Loops and branches make strict ordering undecidable, so this is a *warning*, never a hard failure.

This mirrors the existing OpenAPI gate exactly: the map may be a simplification, but it may not be *wrong*, and wrongness is unmergeable rather than something a reviewer must notice. Prior art says the static analysis is tractable: Cloudflare derives full diagrams (sequence, parallelism, conditionals, loops) from *minified* Workflows bundles at deploy time via AST analysis; Flowstile's job — set membership over literal task codes in its own TypeScript source — is far smaller. Dynamic codes or unresolvable call sites degrade to lint warnings: this is a smoke alarm, not a verifier.

A full developer-facing execution DAG (the Cloudflare-style diagram) is a possible later addition to the admin UI — for developers debugging, *not* for end users, and never merged with the stepper. The two artifacts serve different audiences at different altitudes; collapsing them is the mistake this whole design avoids.

## Step 8 — Process versioning

**Status: Planned (Phase 3). Today `ProcessDefinition.version` exists in the schema but nothing writes or reads it, and cases do not record the version they started under.**

Processes change after cases are in flight. Versioning answers "which description of the process does this case belong to?" — and deliberately *only* that.

**Scope boundary first: Flowstile versions the description, Temporal versions the execution.** An in-flight Temporal workflow keeps executing the code it started on (or code evolved via Temporal's own patching/worker-versioning mechanisms). Flowstile does not and cannot migrate running workflows; what it versions is the *map* — the plan, the task→phase assignments, the task definition set — so that display and analytics stay coherent across change.

The mechanics:

- **Version bump on structural diff.** When sync (step 2) pushes a structure that differs from what the server holds — task set, phase assignments, plan order, case entity schema — `ProcessDefinition.version` increments and a snapshot row (plan + task→phase map, per version) is retained. Manual API edits to structure bump it identically. Ops-config edits (candidates, priority) do *not* bump the version.
- **Cases stamp their version.** `Case` gains `processDefinitionVersion`, written at start. This is the same philosophy as tasks locking `formDefinitionVersion` at creation, one level up.
- **Rendering rule.** Until versioning ships (Phase 1–2), cases read the *live* plan and degrade gracefully — a task whose phase no longer exists renders unphased; worst case is a cosmetic regrouping, never broken execution, which is exactly why the plan is display-only. Once versioning ships, a case renders against the plan snapshot of *its own* version, so renaming or reordering phases never rewrites the apparent history of an in-flight case. The UI may offer "view against latest" as an explicit comparison.
- **Analytics segmentation.** Mined statistics (step 9) are computed per `(processDefinitionId, version)`. Without this, duration and loop-back numbers silently blend incompatible process shapes — versioning is a *prerequisite* for honest mining, which is why it sits in Phase 3 ahead of Phase 4.

## Step 9 — Process mining: the map learns from reality

**Status: Planned (Phase 4).**

Every completed case is already an event log — tasks carry definition codes, phase links, `createdAt`/`completedAt`, assignees, outcomes. Process mining's three classic activities (discovery, conformance, enhancement) map onto Flowstile as follows:

- **Enhancement (first, highest value):** annotate the stepper with mined reality — *"Underwriting typically takes 2 days"*, *"12% of cases loop back from Underwriting to Application Review"*, *"Final Decision is skipped in 30% of cases (early rejection)"*. Durations for zero-task automated phases come from the gap between surrounding phases' timestamps, covering the inference gap noted in step 6.
- **Conformance (observed vs declared):** flag where reality contradicts the map — a phase that never achieves, transitions the plan's order doesn't predict — feeding back into plan revisions. This complements step 7: CI checks the plan against the *code*; mining checks it against *history*.
- **Discovery (later, maybe):** induce the as-run graph from event logs alone, as a developer/analyst view.

The defining property of this layer: **zero authoring cost and zero drift by construction** — it is computed from what happened. It is also the only honest source of *probabilistic* future statements ("typically 2 days"), which no declared plan can provide. The three layers cover each other: the declared plan works from day one but cannot see reality; mining sees reality but has a cold start; CI conformance keeps the declared plan honest in between.

---

## The development loop, end to end

The target inner loop, replayed for "add a document-request step to loan origination":

1. Add `requestDocuments: defineTask('REQUEST_DOCUMENTS', { phase: 'Application Review' })` and call it from the workflow.
2. `tsx watch` restarts the worker → sync registers the new task definition stub → doctor prints: *"REQUEST_DOCUMENTS has no published form — create it at http://localhost:5173/forms/DOCUMENT_REQUEST"*.
3. Click the link, design the form, publish.
4. Types regenerate (watch mode); the workflow gets a compile error if its assumptions don't match the schema; fix, save, worker restarts clean.
5. Start a test case: the stepper shows Application Review active; the new task appears in the inbox.
6. Push: CI's conformance check passes because the task is placed in a phase; the structural diff bumps the process to v2; in-flight v1 cases keep rendering against the v1 plan.

No curl, no manually invoked CLI, no foreign UI. Every seam either self-heals or fails loudly within seconds of the edit, and the one unavoidable context switch (form design) is reached by a printed link.

## Roadmap

| Phase | Theme | Contents |
|---|---|---|
| **1 — Orientation** | Give users the map | `plan` on `defineProcess`, `phase` on `defineTask`; `milestones` JSONB projection on `ProcessDefinition` + `milestoneCode` on `TaskDefinition`; computed phase states in `GET /cases/:id`; stepper on the case page and in `@flowstile/react` |
| **2 — Fast feedback** | Fail at the seam, not in production | Worker doctor preflight; non-retryable `404`/`422` task-creation errors with remediation hints; workflow failure status surfaced on the case page |
| **3 — Sync & change management** | Make drift unmergeable | Dev-mode worker self-registration (prod sync explicit via CLI); codegen staleness hash + `--watch`; CI conformance check (AST placement/liveness, order warning); process versioning (version bump on structural diff, `Case.processDefinitionVersion`, per-version plan snapshots) |
| **4 — Insight** | Let the map learn from reality | Mined phase durations, loop-back and skip rates on the stepper (segmented by process version); UI process page as read-model (definitions, phases, form publish status, last sync, orphan detection); optional developer-facing execution DAG in admin |

Ordering rationale: Phase 1 delivers the user-visible win and forces the data model into place. Phase 2 is the cheapest, highest-leverage DX fix and is independent of sync. Phase 3 makes change *safe* and is a hard prerequisite (via versioning) for Phase 4's statistics being honest. Phase 4 is the payoff that compounds forever at zero authoring cost.

## Related reading

- `docs/design-decisions.md` — why task data is split into input/context/submission
- `docs/runtime-contract.md` — task lifecycle, payload, and access rules
- `docs/developer-guide.md` — architecture-first introduction
- Prior art informing this design: process mining's discovery/conformance/enhancement triad (van der Aalst); Temporal's *"The Fallacy of the Graph"* (the case against executable diagrams — which the display-only plan deliberately concedes); Cloudflare's AST-derived Workflows diagrams (proof that static extraction from imperative durable-workflow code works in production)
