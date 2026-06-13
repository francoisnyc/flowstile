---
title: Process Authoring Guide
description: Step-by-step guide to authoring a Flowstile process — from code-first definition through forms, types, case visibility, change management, versioning, and process mining. Doubles as the roadmap for the process-visibility and DX work.
---

# Process Authoring Guide

This guide walks through the full life of a Flowstile process: defining it in code, binding tasks to forms, generating types, running it, giving end users a map of where their case stands, and changing it safely after it ships. It describes the **target developer experience**. Steps that exist today are marked **Shipped**; steps that are planned are marked **Planned (Phase N)** and collected in the [roadmap](#roadmap) at the end. The guide is therefore both documentation and plan: when a phase ships, its sections stop being aspirational and the document stays true.

## Principles

Four decisions shape everything below. They are worth internalizing before reading the steps.

**The workflow is the territory; the case plan is a map.** Flowstile workflows are imperative Temporal code. Only the code executes, so only the code is authoritative about what *will* happen. Anything we show users about the future — phases, milestones, expected steps — is a declared, deliberately lossy map of that territory. Maps are allowed to simplify; they are not allowed to drive execution. Nothing in the case plan ever gates task creation or workflow progress. (Camunda solves model/code drift by making the diagram executable; Temporal solves it by deleting the diagram. Flowstile's position: keep the diagram as a *view*, and keep it honest mechanically — see step 7.) This generalizes into the scope test for every future case feature: **the case is a read-model — the moment a case feature becomes something the workflow depends on or business logic lives in, it is out of scope.** Milestone-gated task creation, case-level state machines, user-injected ad-hoc tasks, case transitions that signal workflows: each will sound reasonable in isolation, and each fails the test, because each turns the map into a second execution engine that can disagree with Temporal.

**Orientation, not prediction.** Users asking "what happens after I approve this?" want a stable mental model, not a runtime prediction of an imperative program. The case plan answers the orientation question (4–6 named phases in narrative order). It does not attempt to express conditionals, parallel branches, or sagas — those live in the timeline of what actually happened.

**A contract, not a guess — the OpenAPI discipline, applied to processes.** Flowstile already treats `docs/openapi.yaml` as a declared contract that CI proves the code conforms to (`openapi:generate && git diff --exit-code`). The case plan gets the same treatment: declared in code next to the workflow, projected to the server, and held in conformance — first by the type system (phase placement and plan membership are compile errors), with static analysis only as a deferred backstop for what types cannot see — so it cannot silently drift from what the workflow can actually do.

**Code owns structure; the server owns forms; ops config is shared.** Process structure (task codes, phases, plan order, task queue, workflow type) is authored in code, because it is inseparable from the workflow. Forms are authored in the UI designer, because form schemas are the type-bearing, business-editable artifact. Operational config (candidate groups/users, priorities) gets *defaults* from code and *overrides* from the UI/API; sync never clobbers an override.

---

## Step 1 — Define the process in code

**Status: Shipped.** `plan` on `defineProcess`, required `phase` on `defineTask`; the task-factory form scopes `phase` to the plan at compile time, and both forms validate phase membership at module load (a worker with a stale plan fails to boot).

A process is declared once, co-located with the workflow that implements it:

```typescript
import { defineProcess } from '@flowstile/sdk/process';

export const loanProcess = defineProcess('Loan Origination', {
  taskQueue: 'flowstile',
  // The case plan: ordered milestone codes, as users should understand them.
  plan: ['APPLICATION_REVIEW', 'CREDIT_ASSESSMENT', 'UNDERWRITING', 'FINAL_DECISION'],
}, (task) => ({
  reviewApplication: task<ReviewOutput>('REVIEW_APPLICATION', { phase: 'APPLICATION_REVIEW' }),
  verifyIdentity:    task<IdentityOutput>('VERIFY_IDENTITY',  { phase: 'APPLICATION_REVIEW' }),
  requestDocuments:  task<DocsOutput>('REQUEST_DOCUMENTS',    { phase: 'APPLICATION_REVIEW' }),
  assessRisk:        task<RiskOutput>('ASSESS_RISK',          { phase: 'UNDERWRITING' }),
  seniorReview:      task<SeniorOutput>('SENIOR_REVIEW',      { phase: 'UNDERWRITING' }),
  approveLoan:       task<ApprovalOutput>('APPROVE_LOAN',     { phase: 'FINAL_DECISION' }),
  handleFraudFlag:   task<FraudOutput>('HANDLE_FRAUD_FLAG',   { phase: null }), // exception path, unphased
}));
```

Rules of the plan:

- **`phase` is required, and its values are type-checked against `plan`.** Every task is either placed in a phase or explicitly opted out with `phase: null` — the compiler enforces placement. In the task-factory form above, `task` is scoped to the plan, so a typo'd or removed phase is a compile error at the exact line. (A legacy object form using standalone `defineTask` also exists — there, and in all cases as a backstop, `defineProcess` validates membership at module load and a worker with a stale plan refuses to boot.)
- **Phases map N:1 to task definitions.** "Application Review" spans three task definitions, one of which (`REQUEST_DOCUMENTS`) may be created zero or many times at runtime. A phase also spans N task *instances* — rework loops create repeated instances under one stable phase.
- **A phase may have zero tasks.** "Credit Assessment" can be fully automated (a Temporal activity). It will appear on the map and in mined statistics (step 9), but task-based state inference will jump over it (see step 6).
- **Exception tasks are explicitly unphased** (`phase: null`). The plan is the happy path on purpose. Do not try to express "shipped OR refunded" in the plan — that is the road to CMMN sentries and the brittleness this design exists to avoid.
- **Workflow code never references phases.** No `reachMilestone()` calls, no query handlers, no per-workflow boilerplate. The phase mapping lives entirely in the declaration above.

### Bootstrapping dev data: the seed script

The code declaration above tells the *worker* what the process looks like. But the *server* also needs matching records — process definitions, task definitions, and published forms — before any workflow can create tasks. There are two ways to get them there:

- **REST API** — `POST /processes`, `POST /processes/:id/tasks`, `PUT /forms/:code/draft` + `POST /forms/:code/publish`. Good for live iteration; ephemeral (lost on database reset).
- **Seed script** — `packages/server/src/seed.ts`, run via `pnpm --filter @flowstile/server db:seed`. This is the authoritative source for demo and development data: users, groups, roles, forms, processes, task definitions, and sample tasks. It truncates and rebuilds every run, so it's idempotent but destructive. When adding a new process, add a block here following the Loan Origination pattern (forms → process with `milestones` → task definitions with `milestoneCode`). The seed is what makes `pnpm dev` produce a working demo out of the box.

Once dev-mode sync ships (Phase 3), the worker will push structure from the code declaration to the server automatically — eliminating the need to maintain the seed block for structural data. Until then, the seed and the `defineProcess` declaration are two representations of the same truth, and both must be kept in sync manually.

## Step 2 — Run the worker: self-registration and the doctor

**Status: doctor Shipped (strict by default; `FLOWSTILE_DOCTOR=warn|off` to relax); dev-mode sync Planned (Phase 3, directional). Today, process and task definitions are created via the REST API or seed script, and `workflowType`/`taskQueue` are set on the process definition manually.**

In dev mode (`pnpm dev`), starting the worker does two things beyond hosting workflows:

**Sync (push, not pull).** The worker upserts the process definition from the declaration in step 1: process name, task queue, the plan, task definition stubs with their phase links, and `workflowType` derived from the registered workflow function — eliminating the double-entry of queue and type strings. This is the `prisma db push` pattern: automatic in dev, **never automatic in production**. Production sync is an explicit, reviewed step (`flowstile-codegen sync`) in CI/CD, like a migration. Sync owns structure fields only; candidate groups, candidate users, and priority are written on create and never overwritten thereafter (UI/API edits to those are durable). Two rules keep that split ownership honest: sync output is **loud about what it skipped** (*"candidateGroups: keeping UI override"*) so the no-op is never mysterious, and sync **never hard-deletes** — a task definition that disappears from code is marked deprecated and surfaced in the process page rather than removed, because in-flight tasks may still reference it.

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

**Status: Shipped (manual CLI). Staleness detection and watch mode Planned (Phase 2).**

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

**Status: timeline, phase stepper, and computed phase states Shipped (the derivation's table-driven spec lives in `packages/server/test/unit/milestones.spec.ts`). Workflow-failure surfacing Planned (Phase 2).**

`POST /processes/:id/start` validates start-form data, starts the Temporal workflow, and creates the case. The case page then shows two layers, one per audience altitude:

**The phase stepper (the map).** A horizontal stepper across the top renders the plan: each phase **pending**, **active**, **achieved**, or **skipped**. Phase state is a **pure read-time projection** computed in `GET /cases/:id` from the tasks that already exist — no events table, no workflow cooperation:

- a phase with an open (created/claimed) task is *active*; when open tasks span multiple phases, the **earliest open phase in plan order is current** — so the bar regresses honestly during rework and never flickers as parallel work completes out of order;
- phases earlier in plan order render *achieved*, later ones *pending*;
- when the case ends, phases that never saw a task render *skipped* — a closed case never shows an eternally-pending phase (an order rejected at approval skips "Shipment" visibly, rather than appearing stuck);
- a zero-task automated phase jumps from pending to achieved when a later phase's task appears; if that ever matters for a days-long automated phase, an explicit override can be added later — it is deliberately not built first;
- rework moves the bar *backward* (a new Application Review task after Underwriting re-activates the earlier phase). That is the truth, shown honestly.

Because the state derivation is a pure function over existing rows, it can be tuned later (e.g., to a monotonic high-water mark) without touching stored data. **It ships as a table-driven test suite before any UI**: task-history fixtures mapped to expected phase states, reviewed as the spec — the same test-suite-as-contract discipline the rest of Flowstile uses. Every ambiguity (parallel phases, rework regression, cancelled-task handling) gets decided once, in the table, where disagreement is cheap.

**The task timeline (the territory).** The existing flat, `createdAt`-ordered timeline of real task instances, including unphased exception tasks. It is intentionally *not* grouped by phase: grouping breaks chronology under loops and exceptions, and the stepper already answers the orientation question.

**Failure visibility.** A failed workflow must not look like a quiet, empty case. `GET /cases/:id` consults Temporal for workflow status — cached with a short TTL and never blocking the case read on Temporal availability — and the case page says "workflow failed" with the failure summary. This matters beyond developer experience — operators will hit it even when nothing in this guide was done wrong.

The embeddable `@flowstile/react` package consumes the same computed `milestones: [{ code, name, state }]` from the case endpoint, so third-party apps get the stepper without reimplementing the derivation.

## Step 7 — Change management: conformance, types first

**Status: type-level checks Shipped (task-factory form; object form validated at module load). AST analysis explicitly Deferred.**

The plan is a static declaration and *will* drift from the workflow unless something stops it. The cheapest thing that stops it is the compiler, and it covers most of the surface:

1. **Placement** *(compile error, Phase 1)* — `phase` is a required property on `defineTask` (step 1). Adding a task without deciding its place on the map doesn't typecheck. No tooling, no maintenance, no false positives.
2. **Plan membership** *(compile error, Phase 1)* — `phase` values are typed against the `plan` array in the same literal. Renaming or deleting a phase breaks every stale reference at compile time.
3. **Liveness** *(deferred, warning-only)* — "does the workflow actually *call* `assessRisk.createAndWait()` anywhere?" is the one check types cannot do; it needs AST reachability analysis. It is deliberately **not** committed to a phase: walkers over real codebases (descriptors passed through helpers, re-exports, wrappers) have a long false-positive tail, and a CI gate that cries wolf gets `--no-verify`'d within a month and deleted within three. Build it when there is evidence of actual ghost-task drift that checks 1–2 didn't catch, and when it arrives, it is a warning forever — a smoke alarm, never a verifier. The same applies to order-plausibility checks (loops and branches make strict ordering undecidable anyway).

This still mirrors the OpenAPI gate in spirit — the map may be a simplification, but it may not be *wrong*, and wrongness is unmergeable — it just achieves it through the type system instead of a parallel analysis tool. If the AST backstop is ever built, the prior art says it's tractable: Cloudflare derives full diagrams (sequence, parallelism, conditionals, loops) from *minified* Workflows bundles at deploy time via AST analysis, and Flowstile's job — set membership over literal task codes in its own TypeScript source — is far smaller. A full developer-facing execution DAG (the Cloudflare-style diagram) is likewise a possible later admin-UI addition — for developers debugging, *not* for end users, and never merged with the stepper. The two artifacts serve different audiences at different altitudes; collapsing them is the mistake this whole design avoids.

## Step 8 — Process versioning

**Status: Planned (Phase 3). Today `ProcessDefinition.version` exists in the schema but nothing writes or reads it, and cases do not record the version they started under.**

Processes change after cases are in flight. Versioning answers "which description of the process does this case belong to?" — and deliberately *only* that.

**Scope boundary first: Flowstile versions the description, Temporal versions the execution.** An in-flight Temporal workflow keeps executing the code it started on (or code evolved via Temporal's own patching/worker-versioning mechanisms). Flowstile does not and cannot migrate running workflows; what it versions is the *map* — the plan, the task→phase assignments, the task definition set — so that display and analytics stay coherent across change.

The mechanics:

- **A version is a release artifact, not a save artifact.** Only the explicit production sync (`flowstile-codegen sync`, or a deliberate structural API edit) mints a version: when the pushed structure differs from what the server holds — task set, phase assignments, plan order, case entity schema — `ProcessDefinition.version` increments and a snapshot row (plan + task→phase map, per version) is retained. **Dev-mode auto-sync updates structure in place without bumping** — otherwise an afternoon of hot reloads mints v7 through v12 and poisons version-segmented analytics. Ops-config edits (candidates, priority) never bump the version in any mode.
- **Cases stamp their version.** `Case` gains `processDefinitionVersion`, written at start. This is the same philosophy as tasks locking `formDefinitionVersion` at creation, one level up.
- **Rendering rule.** Until versioning ships (Phase 1–2), cases read the *live* plan and degrade gracefully — a task whose phase no longer exists renders unphased; worst case is a cosmetic regrouping, never broken execution, which is exactly why the plan is display-only. Once versioning ships, a case renders against the plan snapshot of *its own* version, so renaming or reordering phases never rewrites the apparent history of an in-flight case. The UI may offer "view against latest" as an explicit comparison.
- **Analytics segmentation.** Mined statistics (step 9) are computed per `(processDefinitionId, version)`. Without this, duration and loop-back numbers silently blend incompatible process shapes — versioning is a *prerequisite* for honest mining, which is why it sits in Phase 3 ahead of Phase 4.

## Step 9 — Process mining: the map learns from reality

**Status: Planned (Phase 4).**

Every completed case is already an event log — tasks carry definition codes, phase links, `createdAt`/`completedAt`, assignees, outcomes. Process mining's three classic activities (discovery, conformance, enhancement) map onto Flowstile as follows:

- **Enhancement (first, highest value):** annotate the stepper with mined reality — *"Underwriting usually takes 1–3 days"*, *"12% of cases loop back from Underwriting to Application Review"*, *"Final Decision is skipped in 30% of cases (early rejection)"*. Durations for zero-task automated phases come from the gap between surrounding phases' timestamps, covering the inference gap noted in step 6. **Every mined statement carries a minimum-sample threshold and is shown as a range with its n** — version segmentation shrinks samples by design, and "typically 2 days" computed from nine cases is noise wearing a tooltip. Below the threshold, show nothing.
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
6. Push and release: placement was already proven by the compiler back in step 1; the explicit release sync mints process v2; in-flight v1 cases keep rendering against the v1 plan.

No curl, no manually invoked CLI, no foreign UI. Every seam either self-heals or fails loudly within seconds of the edit, and the one unavoidable context switch (form design) is reached by a printed link.

## The same loop, run by a coding agent

**Status: mostly possible today; the missing artifact is the skill. Planned (Phase 2).**

Increasingly, the "developer" running the loop above is a coding agent. The story is deliberately agent-legible — OpenAPI as the contract, code-first definitions, deterministic checks with printed remediation — and one packaging step makes it agent-*runnable*: a **`flowstile` skill** that restates this guide as agent instructions (loop steps, form-schema conventions, validation commands, API surface, auth via an API key). The skill and this guide are the same knowledge maintained once.

The notable consequence: **a coding agent can author forms today, with no new product code.** The pieces already exist —

1. Agent drafts the JSON Forms schema + UI schema + outcomes from the task definition and the workflow's data needs.
2. Agent submits via `PUT /forms/:code/draft` (authenticated with an API key); the server validates and rejects malformed schema.
3. Agent prints the designer URL; optionally starts a test case and screenshots the rendered form via the existing Playwright setup to self-verify before handing off.
4. **A human reviews the preview and publishes.** The draft → publish lifecycle is the gate — agents write drafts, only humans publish. Codegen then pulls the types as usual.

This keeps form ownership where it belongs (the server; the designer remains the review and business-editing surface) while removing the one step of the loop that previously forced a human context switch for authoring. An MCP server projecting the authoring endpoints from `docs/openapi.yaml` is a later ergonomic upgrade (typed tools, permission-gated calls); the API-key + REST path is sufficient to start.

### Where AI fits — and where it must not

The rule, consistent with the read-model scope test: **LLMs draft what humans intended; they never decide what the system does.** Every AI touchpoint sits upstream of a human gate that already exists:

- **Form drafting** (above) — gated by publish. Later, optionally in-product in the designer ("draft with AI", bring-your-own-key, hidden when unconfigured).
- **Plan/phase suggestion** — phase names and narrative order are human intent absent from the code, which is exactly what an LLM can *propose* from reading the workflow; the developer reviews the diff. Pairs with drift remediation: the type check *finds* the unplaced task deterministically, the suggestion *proposes* its phase.
- **Mining narratives** (Phase 4) — prose over the stats, subject to the same minimum-sample thresholds.

Explicitly out of bounds: the doctor's checks and "did you mean" hints (edit distance beats a model on speed, cost, and trust), codegen (types must be mechanically faithful), and anything in the runtime path (task creation, signal delivery, phase-state derivation — deterministic by contract, and Temporal workflows must be deterministic anyway). A doctor that is occasionally wrong is worse than no doctor.



| Phase | Theme | Contents |
|---|---|---|
| **1 — Orientation & the doctor** ✅ *shipped* | Give users the map; fail at the seam | `plan` on `defineProcess`, required type-checked `phase` on `defineTask` (placement + plan membership as compile errors); `milestones` JSONB projection on `ProcessDefinition` + `milestoneCode` on `TaskDefinition`; phase-state derivation shipped as a table-driven test suite, then computed in `GET /cases/:id`; stepper on the case page and in `@flowstile/react`; worker doctor preflight |
| **2 — Failure ergonomics & staleness** | Make breakage loud and typed | Non-retryable `404`/`422` task-creation errors with remediation hints; workflow failure status surfaced on the case page (cached, non-blocking); codegen staleness hash + `--watch`; `flowstile` skill packaging the agent-runnable authoring loop incl. agent-drafted forms (draft → preview → human publish) |
| **3 — Sync & versioning** *(directional)* | Kill the curl steps; version the description | Dev-mode worker self-registration (loud override-skips, soft-deprecate deletions, no version minting in dev); explicit release sync minting versions; `Case.processDefinitionVersion`; per-version plan snapshots; MCP server projecting the authoring endpoints from `docs/openapi.yaml` |
| **4 — Insight** *(directional)* | Let the map learn from reality | Mined phase durations, loop-back and skip rates on the stepper (min-sample thresholds, ranges with n, segmented by process version); UI process page as read-model (definitions, phases, form publish status, last sync, deprecated/orphan detection); optional developer-facing execution DAG in admin; in-product AI form drafting (BYO-key) and mining narratives |

Deliberately unscheduled: the AST liveness/order backstop (step 7) — built only if evidence shows the type-level checks missing real drift, and warning-only if so.

Ordering rationale: Phase 1 delivers the user-visible win, forces the data model into place, and includes the doctor because it is the cheapest fix for the worst failure mode. Phase 2 hardens the seams independently of sync. **Phases 3 and 4 are directional, not committed** — they are the right shape if Phase 1 validates the orientation hypothesis with real users, and they should be re-scoped against that feedback rather than built on momentum. Versioning (Phase 3) is a hard prerequisite for Phase 4's statistics being honest.

## Risks and open questions

Design changes already absorbed from review are in the body above (type-level conformance instead of AST-first, versions as release artifacts, soft-deprecate deletions, derivation-as-test-table). What remains genuinely open:

- **The orientation hypothesis itself is unvalidated.** Everything past Phase 1 assumes a phase stepper is what users need to feel oriented. Ship Phase 1, watch real users, and let that — not this document — decide how much of Phases 3–4 to build. A solo project can afford exactly one speculative platform layer at a time.
- **Split ownership of task-definition rows is a known bug factory.** "Code owns structure, UI owns ops config" is the right call, but the create-vs-update semantics need integration tests of their own before sync ships, and the first confusing "why didn't my code change apply?" report should be treated as a design smell, not user error.
- **This document lies the moment a status marker goes stale.** Doc-as-plan only works if shipping a phase and flipping its markers happen in the same PR. If that discipline slips, split the roadmap back out of the guide.
- **Small deployments may never clear mining thresholds.** If typical installs see tens of cases per process version, Phase 4's headline value shrinks to loop-back/skip *counts* rather than duration estimates. That may still be worth building — but check the base rates before committing.
- **The case entity sits closest to the read-model line.** A workflow-writable, schema-validated `entity` is system-of-record-shaped. It is a display-and-coordination scratchpad, not the authoritative store for business data — the developer guide already promises Flowstile won't become that system of record. If adopters start treating it as one, that's scope creep with data-governance consequences; the boundary deserves an explicit entry in `design-decisions.md`.
- **Business stakeholders have no change path.** Everything here serves the developer's loop and the end user's orientation; the process owner between them — who audits the process and requests changes — gets only the Phase 4 read-model page, and an actual change remains a TypeScript PR. That is the deliberate price of the code-first bet (a BPMS would attack exactly this gap). Acceptable for now; revisit if real adopters stall on it.

## Related reading

- `docs/design-decisions.md` — why task data is split into input/context/submission
- `docs/runtime-contract.md` — task lifecycle, payload, and access rules
- `docs/developer-guide.md` — architecture-first introduction
- Prior art informing this design: process mining's discovery/conformance/enhancement triad (van der Aalst); Temporal's *"The Fallacy of the Graph"* (the case against executable diagrams — which the display-only plan deliberately concedes); Cloudflare's AST-derived Workflows diagrams (proof that static extraction from imperative durable-workflow code works in production)
