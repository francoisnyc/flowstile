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
| Replace business data | shallow-merge `setCaseVariables` (pre-redesign) | `updateProcessEntity(id, entity)` |
| Patch business data | none today; targeted by redesign | `patchProcessEntity(id, ops)` — RFC 6902 |
| Non-validated aux data | `variables` (current) | `updateProcessMetadata(id, metadata)` |
| Read business data back | none today; targeted by redesign | via `retrieveProcess` (entity included) |

KuFlow's `entity` (JSON-Schema-validated) vs `metadata` (free-form) split, and
`patchProcessEntity` (RFC 6902), are almost exactly the `caseEntitySchema`-backed
entity and JSON Patch write model specced in `design-decisions.md`. The case
entity redesign converges on KuFlow's process-entity API by design.

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

## Conclusions

1. **Case entity convergence is correct, with a concurrency edge.** KuFlow's
   `entity`/`metadata` split and `patchProcessEntity` mirror the specced case
   entity. The research found no ETag/version optimistic-concurrency mechanism in
   KuFlow (last-write-wins). Flowstile's planned `entityVersion` + `If-Match` is a
   genuine improvement for parallel-branch writes, not just parity.

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

4. **Ergonomics is the moat.** `createTaskAndWait<TOutput>()` with built-in
   timeout/cancel/typing, and per-task signal names, are materially nicer than
   KuFlow's signal+condition primitive. Protect this as the surface grows.

**Net:** on the *data model* Flowstile converges on KuFlow deliberately (with a
concurrency edge); on *SDK shape* it diverges deliberately (produce-and-await vs
full remote-control), and that divergence is the bring-your-own-Temporal,
embedded positioning expressed in code.

## Sources

- [kuflow-sdk-js (GitHub)](https://github.com/kuflow/kuflow-sdk-js)
- [KuFlow TypeScript Loan tutorial](https://docs.kuflow.com/developers/examples/curated/typescript/typescript-loan-tutorial)
- [KuFlow Temporal client integration](https://docs.kuflow.com/developers/client-integration-temporal)
- [KuFlow Authentication](https://docs.kuflow.com/developers/authentication)
- [KuFlow SDKs](https://docs.kuflow.com/developers/sdk)
- [Dynamic Forms with KuFlow and JSON Forms](https://kuflow.com/blog/en/dynamic-forms/)
- [KuFlow Public API reference](https://docs.kuflow.com/reference)
