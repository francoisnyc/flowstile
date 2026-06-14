---
title: KuFlow SDK Comparison
description: Method-by-method comparison of the Flowstile SDK against KuFlow's TypeScript SDK, and what the differences tell us about Flowstile's positioning.
---

# Flowstile SDK vs KuFlow SDK

KuFlow is the closest commercial analog to Flowstile: a task/form/entity layer
built on Temporal. This note compares the two SDKs method-by-method and records
which differences are deliberate (positioning) and which are gaps worth closing
(parity). It exists so that future SDK changes do not accidentally erode the
distinctions that justify Flowstile's existence.

> **API generations.** KuFlow has two: legacy v1/v2 (separate `Process` and
> `Task` resources) and current v3 (a unified `ProcessItem` with
> `type: TASK | MESSAGE | THREAD`). Where it matters both are noted. Some KuFlow
> details below are reconstructed from indexed documentation rather than read
> from `.d.ts`; treat exact method casing as needing confirmation against the
> published types. The behavioral conclusions are well-supported.

## 1. Package layout

| Concern | Flowstile | KuFlow |
|---|---|---|
| REST client | `@flowstile/sdk` (`FlowstileClient`) | `@kuflow/kuflow-rest` (`KuFlowRestClient`) |
| Temporal activities | `@flowstile/sdk/activities` (subpath) | `@kuflow/kuflow-temporal-activity-kuflow` |
| Temporal workflow helpers | `@flowstile/sdk/workflows` (subpath) | `@kuflow/kuflow-temporal-workflow-kuflow` |
| Worker bootstrap | none — user wires their own worker | `@kuflow/kuflow-temporal-worker` |
| Embeddable UI | `@flowstile/react` | none — portal-hosted forms |

KuFlow splits into 4+ packages and ships a worker bootstrap because it owns the
Temporal namespace. Flowstile ships one package with subpath exports, no worker
bootstrap (bring-your-own-worker), and uniquely ships an embeddable React SDK.

## 2. Auth

| Flowstile | KuFlow |
|---|---|
| `{ email, password }` → JWT, one 401 re-auth retry | `clientId` + `clientSecret` application credentials |

KuFlow uses machine application credentials — correct for server-to-server.
Flowstile currently authenticates the worker as a *human* user (seeded
email/password). This is a parity gap (see Conclusions).

## 3. Process / Case operations

| Capability | Flowstile | KuFlow |
|---|---|---|
| Start a process | none (task-first; workflow started externally) | `createProcess(...)` |
| Retrieve | `getCase`, `getCaseByProcessInstance` | `retrieveProcess(id)` |
| List/find | `listCases({status,limit,offset})` | `findProcesses(options)` |
| Replace business data | `setCaseEntity` (full replace, schema-validated) **[shipped]** | `updateProcessEntity(id, entity)` |
| Patch business data | `patchCaseEntity` (RFC 6902, `entityVersion`/`expectedVersion`) **[shipped]** | `patchProcessEntity(id, ops)` — RFC 6902 |
| Non-validated aux data | initial scalar snapshot of `inputData` (no schema) | `updateProcessMetadata(id, metadata)` |
| Read business data back | `getCaseEntity` **[shipped]**; activities `getFlowstileCaseEntity` / `patchFlowstileCaseEntity` | via `retrieveProcess` (entity included) |

KuFlow's `entity` (JSON-Schema-validated) vs `metadata` (free-form) split, and
`patchProcessEntity` (RFC 6902), are almost exactly the `caseEntitySchema`-backed
entity and JSON Patch write model. **This has shipped** (it was "planned" when this
note was first written): the case entity now has read-back and patch, plus the one
genuine improvement over KuFlow — `entityVersion` + `expectedVersion` optimistic
concurrency for parallel-branch writes, which KuFlow lacks (last-write-wins). On
the data model Flowstile has converged on KuFlow's process-entity API by design,
with a concurrency edge.

## 4. Task / ProcessItem operations

| Capability | Flowstile | KuFlow (v3 / legacy) |
|---|---|---|
| Create | `createTask` | `createProcessItem` / `createTask` |
| Retrieve | `getTask` | `retrieveProcessItem` / `retrieveTask` |
| List/find | none in SDK | `findProcessItems` / `findTasks` |
| Claim | none in SDK | `claimProcessItemTask` / `claimTask` |
| Complete | none in SDK (human completes via UI → signal) | `completeProcessItemTask` / `completeTask` |
| Assign | none in SDK | `assignProcessItemTask` / `assignTask` |
| Cancel | `cancelTask` | via lifecycle |
| Save form data | none (validated only at completion) | `saveProcessItemTaskData` / `saveTaskJsonFormsValueData` |
| Patch form data | none | `patchProcessItemTaskData` — RFC 6902 |
| Upload document | `uploadAttachment` | `saveProcessItemTaskDataDocument` / `saveTaskElementValueDocument` |
| Download document | `downloadAttachment` | document retrieval ops |
| Append log/activity | none | `appendProcessItemTaskLog` |

This is the deepest divergence. KuFlow's SDK is **engine-side and symmetric** —
it can drive the entire task lifecycle (claim, partial save, complete, assign,
log) because KuFlow's backend owns task state and the SDK is how the platform
manipulates it. Flowstile's SDK is **producer-side and asymmetric**: the workflow
creates and cancels; the human claims and completes through the UI; the workflow
learns the result via a Temporal signal. Flowstile has no `claim`/`complete`/
`saveData` in the SDK at all — by design, not omission.

## 5. Temporal wait ergonomics

| | Flowstile | KuFlow |
|---|---|---|
| Wait helper | `createTaskAndWait<TOutput>()` — one typed call | async-activity, or manual `setHandler(KUFLOW_ENGINE_SIGNAL_PROCESS_ITEM) + condition()` |
| Signal | `flowstile:task:completed:<taskId>` (per task) | `KUFLOW_ENGINE_SIGNAL_PROCESS_ITEM` (one signal, demuxed by item id) |
| Result typing | generic `TOutput`, `result.data.DECISION` typed | `data.value` map, untyped field codes |
| Timeout | built in (`timeoutMs` → cancels task, `TaskTimeoutError`) | caller implements |
| Workflow-cancel cleanup | built in (`nonCancellable` task cancel) | caller implements |
| Task-cancelled signal | `TaskCancelledError` | caller handles |

Flowstile packages timeout, cancellation cleanup, and typed output into a single
ergonomic await; per-task signal names avoid demultiplexing. This is the DX
differentiator named in the positioning decision and the asset to protect as the
entity model grows.

## 6. Form / data model

| | Flowstile | KuFlow |
|---|---|---|
| Form tech | JSON Forms (schema + uiSchema) | JSON Forms (schema + uiSchema) |
| Validation | AJV server-side, hard-rejects (422) | server-side soft — saves `{ value, valid, errors }`, marks invalid |
| Task payload split | `inputData` / `contextData` / `submissionData` (3 contracts) | single `data` blob (+ legacy "elements") |
| Field visibility/RBAC | server-side visibility rules filter schema + data | task permissions / principals |

Both use JSON Forms. Two real divergences: validation strictness (Flowstile
hard-rejects; KuFlow saves-but-flags, enabling progressive partial saves) and the
three-contract payload split (a deliberate Flowstile decision recorded in
`design-decisions.md` vs KuFlow's single `data` object).

## 7. Process authoring surface (new axis of divergence)

| Capability | Flowstile | KuFlow |
|---|---|---|
| Process/task definition | server-side **+ a typed code-first projection** (`defineProcess`/`defineTask`, codegen) | portal-configured; worker references by id/code |
| Case plan / phases | `plan` + `phase` (compile-checked), milestone stepper | none |
| Boot-time conformance | worker **doctor** preflight (task codes, published forms, queue, plan) | none (Temporal retry catches runtime failures) |
| Variable I/O mapping | `contextFrom` / `persist` (declarative, SDK-applied, plumbing-only) | manual in worker code |

This surface has **no KuFlow equivalent** — it is Flowstile-only ergonomics for a
code-first TypeScript author. KuFlow is REST-resource + portal-config; Flowstile
adds a typed authoring/projection layer (descriptors, plan/stepper, doctor,
declarative mappings) on top of server-side definitions. This is a *new* axis of
deliberate divergence (the "ergonomics is the moat" positioning), and `contextFrom`/
`persist` is genuinely novel — the engines that have declarative I/O mapping
(Camunda/Bonita) put it in the *model*; KuFlow does it manually. So here Flowstile
is in greenfield, owning the design rather than following a precedent.

## 8. Surfacing automated / agent work (an asymmetry cost)

KuFlow orchestrates "tasks, both human and automated": an **automatic task** is a
first-class process item the worker completes programmatically (`claimProcessItem`
+ `completeProcessItem`). Because it is a task, it appears in the process view and
audit trail **for free** — KuFlow's *symmetric* SDK buys uniform visibility of
human and automated steps. KuFlow also has `appendProcessItemTaskLog`.

Flowstile's SDK is *asymmetric* (human-only completion — see §4), so it **cannot**
model automated work as a completable task without reopening the completion
boundary. The cost: automated steps (Temporal activities) are invisible in the case
view; only their results land in case variables, and the milestone stepper jumps
over automated phases. Note also Flowstile does **not** copy KuFlow/Bonita-style
connectors or external tasks — those are Temporal's job (activities, task queues,
retry policies, deterministic replay), and Temporal does them better than the BPMN
engines' manual replay.

The proposed Flowstile answer — **not** a completable task, **not** reading Temporal
history — is an optional, display-only **case-event log** the workflow publishes to,
with `actor: human | system | agent` (see `design-decisions.md` → "Surfacing
Automated and Agent Work"). It is *not built*; it is the principled, asymmetry-
respecting alternative, and the slot that makes RPA/agent actors legible in the
case view.

## Conclusions

1. **Case entity convergence is correct, with a concurrency edge — and shipped.**
   KuFlow's `entity`/`metadata` split and `patchProcessEntity` mirror the case
   entity, which now has read-back, JSON Patch, and `entityVersion`/`expectedVersion`
   optimistic concurrency. KuFlow has no version mechanism (last-write-wins), so
   the concurrency model is a genuine improvement for parallel-branch writes, not
   just parity.

2. **SDK symmetry is the deepest divergence, and it flows from positioning.**
   KuFlow's SDK can drive the whole task lifecycle because its platform owns task
   state. Flowstile is produce-and-await because Temporal owns orchestration and
   the human owns completion through the UI. **Do not add `claimTask`/
   `completeTask` to the Flowstile SDK** — that would pull task state-ownership
   into Flowstile and erode the BYO-Temporal distinction.

3. **Two parity gaps worth closing (neither compromises differentiation):**
   - **Service auth.** Email/password for a worker is wrong; add API-key /
     service credentials like KuFlow's clientId/secret.
   - **Partial save + soft validation (optional).** KuFlow's
     save-with-`{valid,errors}` enables progressive form completion.
     `design-decisions.md` already lists "partial form progress" as a motivator;
     a soft-validating partial-save endpoint is the KuFlow-shaped answer if we
     want it.

4. **Ergonomics is the moat — and it has grown.** `createTaskAndWait<TOutput>()`
   with built-in timeout/cancel/typing and per-task signals, plus the newer
   code-first authoring surface (§7: `defineProcess`/`defineTask`, plan/phase, the
   doctor, `contextFrom`/`persist`), are materially nicer than KuFlow's
   signal+condition primitive and manual wiring — on its home turf (code-first TS
   Temporal human tasks). KuFlow leads on breadth: multi-language SDKs, symmetric
   programmatic task control, partial-save/soft-validation, and being a proven
   product. Better-designed for the niche, not yet better-proven.

5. **The asymmetry cost is real and has a designed answer.** The human-only SDK
   that protects the audit boundary also makes automated/agent work invisible in
   the case view (§8), where KuFlow gets visibility for free via symmetric
   automatic tasks. The answer is *not* to add programmatic completion but the
   proposed display-only, actor-tagged **case-event log** — which also readies
   Flowstile for agent actors.

**Net:** on the *data model* Flowstile has converged on KuFlow deliberately (with a
shipped concurrency edge); on *SDK shape and authoring* it diverges deliberately
(produce-and-await + a typed code-first authoring layer vs full remote-control +
portal-config), and that divergence is the bring-your-own-Temporal, embedded
positioning expressed in code. The one place the asymmetry *costs* visibility —
automated/agent steps — is addressed by a proposed case-event log, not by eroding
the human-completion boundary.

## Sources

- [kuflow-sdk-js (GitHub)](https://github.com/kuflow/kuflow-sdk-js)
- [KuFlow TypeScript Loan tutorial](https://docs.kuflow.com/developers/examples/curated/typescript/typescript-loan-tutorial)
- [KuFlow Temporal client integration](https://docs.kuflow.com/developers/client-integration-temporal)
- [KuFlow Authentication](https://docs.kuflow.com/developers/authentication)
- [KuFlow SDKs](https://docs.kuflow.com/developers/sdk)
- [Dynamic Forms with KuFlow and JSON Forms](https://kuflow.com/blog/en/dynamic-forms/)
- [KuFlow Public API reference](https://docs.kuflow.com/reference)
