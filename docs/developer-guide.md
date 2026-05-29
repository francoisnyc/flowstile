---
title: Developer Guide
description: Architecture-first introduction to Flowstile for engineers evaluating, integrating, or contributing to the project.
---

# Flowstile Developer Guide

Flowstile is the human-task and form layer for Temporal. It is delivered as self-hosted open-source infrastructure for Temporal teams.

Flowstile gives Temporal applications a durable way to pause for human input, render structured forms, route tasks to the right people, and resume workflows with the submitted data. The goal is straightforward: developers should be able to add a human approval, review, or data-entry step to a workflow without inventing a one-off inbox, a one-off form system, or a one-off signaling bridge.

In practice, that means Flowstile is trying to remove a particular kind of accidental complexity. Human-in-the-loop workflows usually force teams to mix orchestration logic, UI state, authorization rules, task routing, and form lifecycle concerns into the same application code. Flowstile pulls those concerns apart. Temporal remains responsible for orchestration. Flowstile owns the human work layer around it.

This guide is written for engineers evaluating, integrating, or contributing to Flowstile. It is intentionally architecture-first. The fastest way to understand Flowstile is to understand where state lives, what runs in your stack, and what contract Flowstile exposes to your workflows.

## What Flowstile Is

Flowstile has three parts:

- `Flowstile Server`: owns persistent state, authentication, authorization, form definitions, task definitions, and runtime tasks. It exposes the REST API and serves the web UI in production.
- `Flowstile Worker`: runs alongside your Temporal worker code. It handles the Temporal-side integration for human task completion and activity calls.
- `@flowstile/sdk`: gives workflow authors an ergonomic API for creating tasks and waiting for results.

At the product level, Flowstile provides:

- A form designer based on JSON Schema and JSON Forms
- A task inbox for claiming, completing, and managing human work
- A task lifecycle enforced by a formal state machine
- A signal-based integration model that resumes Temporal workflows with submitted form data

The product focus is intentionally narrow: Flowstile is built first as the human-task and form layer for Temporal. At the same time, the form model is kept open on purpose. Forms are first-class resources with their own lifecycle rather than task attachments hidden inside workflow configuration.

Flowstile is not trying to be a generic form platform with workflow features bolted on afterward. The center of the product is durable human work inside Temporal applications: forms matter because they structure task input and output, task state matters because humans need a managed inbox, and the workflow integration matters because those human steps must resume durable execution cleanly.

## V1 Contract

Flowstile v1 gives Temporal teams a complete human-task path: define versioned forms, bind them to reusable task definitions, create tasks from workflow code, complete them in a web inbox, and resume workflows with the submitted data.

`V1 includes`

- built-in email/password authentication with sessions
- users, groups, roles, and role-based visibility rules
- form definitions with draft and published versions
- reusable task definitions linked to forms by stable code
- runtime tasks with claim, unclaim, complete, and cancel transitions
- a web inbox for viewing, claiming, and completing work
- server-side filtering of schemas and data based on user visibility
- worker and SDK integration for workflow pause/resume through task completion

`V1 does not include yet`

- visual drag-and-drop form building
- BPMN modeling or workflow execution
- advanced tooling for migrating in-flight workflows across form-version changes
- OIDC as the primary authentication path
- standalone form-delivery workflows outside the human-task path

This scope is intentionally focused. The goal of v1 is to make the core human-task experience reliable, secure, and intuitive before expanding into more ambitious modeling, identity, and platform surfaces.

## How It Fits Into a Temporal System

Flowstile is deliberately split between a shared server and application-local worker integration.

The server owns the durable application state. That includes users, groups, roles, forms, process registration, task definitions, and task instances. It is also the system of record for task status and form data.

The worker lives with your Temporal application because that is where workflow context exists. When a workflow creates a human task, the integration path is:

1. Workflow code calls the SDK.
2. The SDK triggers an activity that calls the Flowstile Server REST API.
3. The server creates a runtime task and makes it available in the inbox.
4. A user claims and completes the task in the UI.
5. The completion event is routed back into Temporal as a signal.
6. The workflow resumes with the submitted data.

The important boundary is this: Flowstile owns human-task state and presentation, while Temporal continues to own orchestration and workflow execution.

At the task boundary, Flowstile deals with three kinds of data:

- input data provided by the workflow when the task is created
- context data used to help the assignee understand the work
- submission data returned when the task is completed

This keeps the contract explicit without forcing Flowstile to become the system of record for the application's business entities.

The workflow can assemble rich task context, but Flowstile is responsible for producing the authorized view of that context delivered to a specific user.

That separation has a few concrete benefits:

- workflow code stays focused on business flow instead of inbox behavior
- forms can evolve independently from workflow deployments
- task state is queryable and manageable without reconstructing it from workflow internals
- role-based visibility and assignment rules have a natural home in the product layer
- teams get a reusable human-task capability instead of rebuilding it process by process

## Your First Human Task

The intended developer experience is a small amount of workflow code with a predictable result. A human task should feel like a durable pause point, not an integration project.

`createTaskAndWait` is called inside a Temporal workflow function. It creates a task, suspends the workflow on a Temporal signal, and returns typed completion data when a human finishes the task.

```ts
import { createTaskAndWait } from '@flowstile/sdk/workflows';

interface LoanDecision {
  AMOUNT: number;
  APPROVAL_DECISION: 'approved' | 'rejected';
}

const result = await createTaskAndWait<LoanDecision>({
  taskDefinitionId: 'task-def-uuid',
  processInstanceId: 'correlation-id',
  priority: 'high',
  inputData: { CUSTOMER_ID: customerId },
  contextData: { CUSTOMER_NAME: customerName },
  timeoutMs: 3 * 24 * 60 * 60 * 1000, // 3 days
});

const amount = result.data.AMOUNT;
const decision = result.data.APPROVAL_DECISION;
// result.completedBy.email and result.completedAt are also available
```

The result is fully typed via the generic parameter. `createTaskAndWait` handles three things internally:

- creates a task through the Flowstile Server REST API
- suspends the workflow on a Temporal signal
- returns validated, typed completion data when a human finishes the task

The SDK also exports a `FlowstileClient` class (from `@flowstile/sdk`) for direct API calls outside workflow code, but `createTaskAndWait` is the primary integration point for Temporal workflows.

That contract is the center of the product. If Flowstile feels intuitive, it is because this path feels obvious and boring in the best possible way. The workflow asks for human input, Flowstile manages the human work, and the workflow resumes with typed data when that work is done.

## Core Concepts

### Form Definitions

A `FormDefinition` is a versioned, reusable form contract. It is built from:

- `jsonSchema`: the data model
- `uiSchema`: layout and widget hints
- `visibilityRules`: field-level access rules based on roles and groups
- `formMessages`: validation and helper text

Forms are first-class entities and are versioned independently from processes. A task definition references a form by stable `code`, not by a database ID. When a runtime task is created, it locks to the currently published form version. In-flight tasks are never retroactively changed by later form edits.

That independence is a product choice as much as a data-model choice. Flowstile uses forms primarily in support of human tasks, but the form system is designed to remain useful on its own terms: portable, versioned, and not bound to a Temporal-specific representation.

### Process Definitions

A `ProcessDefinition` is lightweight registration metadata for a workflow or business process. It exists for organization and administration. The actual workflow logic remains in Temporal application code.

### Task Definitions

A `TaskDefinition` describes a reusable human task type within a process. It binds together:

- a stable task `code`
- the process it belongs to
- the form code it should render
- candidate users and groups
- a default priority

This is the template developers and operators configure once and reuse many times.

### Tasks

A `Task` is the runtime instance created by workflow execution. It carries:

- the referenced task definition
- the locked form version
- the Temporal workflow ID
- task status
- assignee
- priority
- due dates
- the workflow-provided input payload
- the context exposed to the assignee
- the submission payload produced by human completion

This is the unit a human sees in the inbox and acts on.

The key distinction is that Flowstile manages human work around business data, but does not require owning the canonical business record. The workflow can provide identifiers, snapshots, or supporting context from external systems and then decide how completion data is reconciled back into the system of record.

## Runtime Lifecycle

Flowstile treats task lifecycle as a hard contract, not a loose convention.

Valid states are:

- `created`
- `claimed`
- `completed`
- `cancelled`

Valid transitions are:

- create: `created`
- claim: `created -> claimed`
- unclaim: `claimed -> created`
- complete: `claimed -> completed`
- cancel: `created -> cancelled`
- cancel: `claimed -> cancelled`

Two principles matter here.

First, terminal states are terminal. A completed or cancelled task cannot transition back into active work.

Second, completion requires ownership. Flowstile does not allow `created -> completed`. A task must be claimed before it can be completed.

Reassignment is modeled as `unclaim` followed by `claim`, rather than as a bespoke transition. Partial form data is preserved on unclaim so work is not lost when ownership changes.

## Visibility And Security Model

Flowstile applies role and group visibility rules on the server side.

When a user opens a task, the server evaluates the form's `visibilityRules` against that user's roles and groups. Fields the user should not see are removed from:

- the JSON Schema
- the UI Schema
- the task data payload

This means the browser never receives hidden data in the first place. That choice is intentional. It avoids the false safety of client-side hiding and keeps the security model legible.

The same principle applies to task context. If supporting business context is provided for a task, Flowstile should filter it before delivery when that context exceeds what the current user is allowed to see.

## API Surface

The Flowstile API is organized around the resources the product exposes:

- `/auth`
- `/users`
- `/groups`
- `/forms`
- `/processes`
- `/task-definitions`
- `/tasks`

The most important runtime endpoints are:

- `POST /tasks` to create a task instance
- `GET /tasks` to list tasks (filter by `status`, `assigneeId`, `group`)
- `GET /tasks/:id` to retrieve a task with form schema filtered for the current user
- `POST /tasks/search` to search tasks by business variables stored in `inputData`, `contextData`, or `submissionData`
- `POST /tasks/:id/claim`
- `POST /tasks/:id/unclaim`
- `POST /tasks/:id/complete`
- `POST /tasks/:id/cancel`

### Task Variable Search

`POST /tasks/search` accepts the same metadata filters as `GET /tasks` plus scoped variable filters:

```json
{
  "status": "created",
  "inputVariables": [
    { "name": "ORDER_ID", "operator": "eq", "value": "ORD-2024-1002" }
  ],
  "contextVariables": [
    { "name": "CUSTOMER_NAME", "operator": "like", "value": "Alice%" }
  ],
  "submissionVariables": [
    { "name": "DECISION", "operator": "eq", "value": "APPROVED" }
  ],
  "limit": 20,
  "offset": 0
}
```

Operators: `eq` (exact match on string, number, or boolean — uses the GIN index) and `like` (case-insensitive pattern match with `%` wildcard, falls back to a sequential scan). All filters are ANDed. Maximum 10 variable filters total across all scopes per request.

Forms are addressed by stable `code` values rather than opaque IDs. That matters for developer experience. A form code can live comfortably in source code, configuration, and CI pipelines without becoming environment-specific.

## Package Layout

Flowstile uses a monorepo with five packages:

```text
packages/
  server/   Fastify API and production web serving
  worker/   Temporal worker integration
  sdk/      @flowstile/sdk
  ui/       React application for the inbox and form designer
  react/    @flowstile/react — embeddable React SDK for third-party apps
```

The repository is optimized for shared types, coordinated iteration, and a local development loop where backend and frontend can move together without hand-maintained copies of contracts.

## Development Model

In local development, the UI and server run as separate packages for fast feedback:

- `ui` runs as a Vite application
- `server` runs as a Fastify app
- the UI dev server proxies API requests to the server
- Docker Compose provides PostgreSQL and Temporal for local infrastructure

In production, the server is expected to serve the built frontend assets while the Temporal worker integration remains its own deployable concern. This keeps the public deployment story simple without forcing the codebase into a single package.

## Design Principles

Flowstile is opinionated in a few places because those choices make the system easier to trust.

Forms are independent versioned entities because task UX changes more often than workflow code, and in-flight work should not be invalidated by a later form edit.

The form model stays open because form design, publication, and visibility rules are valuable capabilities in their own right. Flowstile is focused on human tasks, but it should not paint the form system into a task-only corner.

The task contract is explicit because input, context, and submission evolve differently. Workflow-provided task input should be validated at creation time, supporting context should be allowed to evolve more additively, and submitted data should remain version-sensitive and stable for in-flight work.

The worker integration is separate from the server because workflow signaling belongs close to the Temporal runtime, not in a shared admin service.

Visibility is enforced on the server because hidden data that still arrives in the client is not a serious security model.

The state machine is explicit because task systems become hard to reason about when transitions are implicit, inconsistently enforced, or reconstructed from UI behavior.

## What A Good Integration Should Feel Like

The Flowstile mental model should settle quickly.

You should be able to tell, without much effort, which concerns belong to Temporal and which belong to Flowstile. Creating a human task should look like normal workflow code, not like a sidecar integration with hidden coupling. The same nouns should mean the same things everywhere: in the docs, in the API, in the UI, and in application code.

The system should also behave predictably under change. Form versions should not surprise in-flight work. Reassignment should preserve useful progress. Visibility rules should be enforced in a way that does not depend on the browser being honest. When something goes wrong, the failure should be understandable from the task model itself rather than from undocumented behavior between services.

## Embeddable React SDK

The `@flowstile/react` package lets internal teams embed Flowstile task forms into their own React apps with minimal integration effort.

### Quickstart

```tsx
import { FlowstileTask } from '@flowstile/react';
import '@flowstile/react/styles.css';

function WarehouseDashboard({ taskId }: { taskId: string }) {
  return (
    <FlowstileTask
      taskId={taskId}
      onComplete={(data) => console.log('Task completed:', data)}
      onError={(err) => console.error('Error:', err.message)}
      onClaim={() => console.log('Task claimed')}
    />
  );
}
```

This renders the task form with Claim/Submit buttons based on the current user's permissions and the task's state.

### Hook + Renderer (Custom UX)

For full control over layout and behavior, use the hook and renderer separately:

```tsx
import { useFlowstileTask, FlowstileForm } from '@flowstile/react';
import '@flowstile/react/styles.css';

function CustomTaskView({ taskId }: { taskId: string }) {
  const { task, form, data, status, error, validationErrors, isMutating, claim, complete } =
    useFlowstileTask(taskId);

  if (status === 'loading') return <Spinner />;
  if (status === 'error') return <ErrorBanner error={error!} />;

  const [formData, setFormData] = useState(data);

  return (
    <div>
      <h2>Task: {task!.id}</h2>
      <FlowstileForm
        schema={form!.jsonSchema}
        uiSchema={form!.uiSchema}
        data={formData}
        onChange={setFormData}
        readOnly={!task!.actions.canComplete}
        validationErrors={validationErrors ?? undefined}
      />
      {task!.actions.canClaim && (
        <button onClick={claim} disabled={isMutating}>Claim</button>
      )}
      {task!.actions.canComplete && (
        <button onClick={() => complete(formData)} disabled={isMutating}>Submit</button>
      )}
    </div>
  );
}
```

### Authentication

By default, the SDK sends credentials (cookies) with all requests. This works for same-origin or same-site deployments where the Flowstile server sets the `flowstile_token` HttpOnly cookie.

For cross-origin deployments or service-to-service scenarios, use Bearer tokens:

```tsx
// Static token (short-lived)
<FlowstileTask taskId="..." token="eyJhbG..." />

// Dynamic token getter (preferred — supports refresh)
<FlowstileTask taskId="..." getToken={async () => {
  const res = await fetch('/api/flowstile-token');
  return (await res.json()).token;
}} />
```

Token security guidance:

- Tokens should be short-lived (minutes, not days) and scoped to minimum required permissions
- Never store tokens in localStorage or sessionStorage (XSS exposure)
- `getToken` is preferred over `token` because it supports transparent refresh without re-rendering
- The SDK only attaches tokens to Flowstile API requests under the configured `baseUrl`
- `baseUrl` must come from trusted application configuration, never from user-controlled input

### CORS Setup

For cross-origin embedding (e.g. `warehouse.company.com` embedding tasks from `api.company.com`), configure the server's `CORS_ORIGINS` environment variable:

```
CORS_ORIGINS=https://warehouse.company.com,https://dashboard.company.com
```

When set, only the listed origins are allowed. Credentials (cookies) are included for listed origins. When unset, the server operates in same-origin mode only.

Mutating requests (POST, PUT, PATCH, DELETE) using cookie auth are additionally validated against the Origin header for CSRF protection. Requests from unlisted origins receive 403. Requests with valid Bearer tokens bypass this check.

### Server-Provided Actions

The `GET /tasks/:id` response includes a server-computed `actions` object:

```typescript
task.actions: {
  canClaim: boolean;
  canUnclaim: boolean;
  canComplete: boolean;
  canCancel: boolean;
}
```

These are computed from task status, user assignment, permissions, and group membership. Clients must render buttons based on these flags — never by comparing `task.assignee` to a local user identity. This ensures consistent authorization regardless of how the client resolves user identity.

### Submission Integrity

The server enforces a writable-field boundary at completion time:

- Fields marked `readOnly` in visibility rules cannot be overwritten by clients
- Submitted keys outside the writable set are silently stripped before merge
- Previously stored data in read-only fields is preserved
- After stripping, the merged data is validated against the full form JSON Schema

The SDK renders fields as read-only in the form as a UX hint, but the server-side stripping is the actual authorization boundary.

### Validation Errors

When the server returns 422 on completion, the SDK parses the `details` array into `validationErrors` keyed by JSON Pointer paths (RFC 6901):

```typescript
// validationErrors shape:
{
  '/customerName': ['is required'],
  '/address/street': ['must be a string'],
  '/items/0/quantity': ['must be >= 1'],
}
```

These paths match AJV's `instancePath` format. Pass `validationErrors` to `<FlowstileForm>` to display them inline.

### API Reference

```typescript
// Hook
import { useFlowstileTask } from '@flowstile/react';
const result = useFlowstileTask(taskId: string, opts?: {
  baseUrl?: string;       // defaults to '' (same origin)
  token?: string;         // static Bearer token
  getToken?: () => Promise<string>;  // async token getter (preferred)
});
// Returns: { task, form, data, status, error, validationErrors, isMutating,
//            claim, unclaim, complete, cancel, refetch }

// Renderer
import { FlowstileForm } from '@flowstile/react';
<FlowstileForm schema={} uiSchema={} data={} onChange={} readOnly={} validationErrors={} />

// Convenience component
import { FlowstileTask } from '@flowstile/react';
<FlowstileTask taskId={} baseUrl={} token={} getToken={} onComplete={} onError={} onClaim={} />

// Stylesheet
import '@flowstile/react/styles.css';

// Types
import type { FlowstileApiError, Task, TaskActions, TaskForm } from '@flowstile/react';
```

### Peer Dependencies

| Package | Tested Range |
|---------|-------------|
| `react` | >=18.0.0 <20 |
| `@jsonforms/core` | ^3.4.0 |
| `@jsonforms/react` | ^3.4.0 |
| `@jsonforms/vanilla-renderers` | ^3.4.0 |

## Current Status

Flowstile is being built toward this contract. The architecture, core data model, state machine, package boundaries, and product semantics are defined. Some areas are still in foundation-stage implementation, especially around auth, worker packaging, full API coverage, and the UI surface.

That is deliberate. This guide is not meant to mirror temporary scaffolding. It describes the developer experience Flowstile is intended to deliver, and it should be used as a feedback loop against the spec, the implementation plan, and the codebase as they evolve.

