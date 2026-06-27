# Flowstile Design Spec

**Date:** 2026-04-23
**Status:** Draft
**License:** Apache 2.0

## Problem Statement

Temporal.io has no open-source visual form builder or human-task inbox. KuFlow fills this gap but is proprietary SaaS. Flowstile is the missing open-source layer: a form schema designer, task inbox UI, and the Temporal signal glue that connects them.

**Target users:**
1. **Phase A** — Platform/DevOps teams building internal tools on Temporal who need human-in-the-loop steps (approvals, reviews, data entry)
2. **Phase B** — Business users who interact with the task inbox and forms without writing code

## Architecture

Two-service architecture with an SDK package:

```
┌─────────────────────────┐         ┌─────────────────────────┐
│    FLOWSTILE SERVER     │  REST   │    FLOWSTILE WORKER     │
│                         │◄───────►│                         │
│  React UI               │         │  Signal Handler         │
│  - Task Inbox (2-panel) │         │  - Listens for task     │
│  - Form Designer        │         │    completion signals   │
│  - Process Admin        │         │  - Routes form data     │
│  - User/Role Mgmt       │         │    back to workflows    │
│                         │         │                         │
│  NestJS REST API        │         │  Activities             │
│  - /processes            │         │  - createTask           │
│  - /tasks               │         │  - getTaskResult        │
│  - /forms               │         │  - notifyUser           │
│  - /users               │         │                         │
│                         │         │          │ gRPC          │
│  Auth Layer             │         │          ▼              │
│  - Built-in email/pass  │         │  ┌───────────────┐     │
│  - Session management   │         │  │Temporal Server │     │
│  - RBAC                 │         │  └───────────────┘     │
│          │              │         └─────────────────────────┘
│          ▼              │
│  ┌────────────┐         │         ┌─────────────────────────┐
│  │ PostgreSQL │         │         │   @flowstile/sdk        │
│  └────────────┘         │         │   npm package, wraps    │
└─────────────────────────┘         │   REST API for use in   │
                                    │   Temporal workflows    │
                                    └─────────────────────────┘
```

**Flowstile Server** — NestJS backend serving the REST API and the React frontend. Owns all persistent state in PostgreSQL. Handles authentication, authorization, form schema storage, and task lifecycle.

**Flowstile Worker** — A Temporal worker that developers embed alongside their own workflow code. Contains the signal handler that listens for task completion events and routes form data back into workflows, plus activities that call the Flowstile Server REST API.

**@flowstile/sdk** — An npm package that wraps the REST API into ergonomic helpers for use inside Temporal workflows. The primary entry point for developers.

### Why Two Services

The server owns state and UI. The worker runs inside the developer's Temporal worker process so it can receive signals and execute activities within workflow context. This separation means the server can scale independently, and developers don't need to modify the server to add new workflows.

## Data Model

### FormDefinition (independent, versioned)

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| code | string | Unique human-readable identifier (e.g., `LOAN_APPLICATION`) |
| version | integer | Auto-incremented on publish |
| jsonSchema | JSONB | Standard JSON Schema defining the data model |
| uiSchema | JSONB | JSON Forms UI Schema defining layout, widgets, rules |
| visibilityRules | JSONB | Per-field role/group-based visibility configuration |
| formMessages | JSONB | Custom validation messages, help text |
| status | enum | `draft` or `published` |
| createdAt | timestamp | |
| updatedAt | timestamp | |

Multiple rows can share the same `code` — each published version is a separate immutable row. There is at most one row per code with `status = draft` (the working copy). Publishing a draft creates a new row with the next version number and `status = published`, then deletes the draft row.

Forms are **first-class entities**, versioned independently from processes. A form can be reused across multiple task definitions. When a task is created, it locks to the currently published version of the form — in-flight tasks are never affected by subsequent edits.

### ProcessDefinition

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| name | string | Human-readable name |
| version | integer | |
| status | enum | `active`, `inactive` |
| createdAt | timestamp | |
| updatedAt | timestamp | |

Lightweight registration of a process for organizational purposes. The actual workflow logic lives in the developer's Temporal code.

### TaskDefinition

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| code | string | Unique identifier (e.g., `REVIEW_LOAN`) |
| processDefinitionId | UUID | FK → ProcessDefinition |
| formDefinitionId | UUID | FK → FormDefinition |
| candidateGroups | text[] | Groups whose members can claim this task |
| candidateUsers | text[] | Specific users who can claim this task |
| defaultPriority | enum | `low`, `normal`, `high`, `urgent` |
| createdAt | timestamp | |
| updatedAt | timestamp | |

### Task (runtime instance)

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| taskDefinitionId | UUID | FK → TaskDefinition |
| formDefinitionVersion | integer | Locked at task creation time |
| workflowId | string | Temporal workflow ID |
| processInstanceId | string | Correlation ID for grouping |
| status | enum | `created`, `claimed`, `completed`, `cancelled` |
| assignee | UUID | FK → User (nullable until claimed) |
| data | JSONB | Form submission data |
| priority | enum | Override from task definition default |
| dueDate | timestamp | |
| followUpDate | timestamp | |
| createdAt | timestamp | |
| completedAt | timestamp | |

### User

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| email | string | Unique |
| displayName | string | |
| passwordHash | string | bcrypt |
| status | enum | `active`, `inactive` |
| createdAt | timestamp | |

### Group

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| name | string | Unique |

Plus a `group_members` join table (group_id, user_id).

### Role

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK |
| name | string | Unique (e.g., `admin`, `task-user`) |
| permissions | text[] | e.g., `forms:write`, `tasks:read`, `users:manage` |

Plus a `user_roles` join table (user_id, role_id).

## Authentication & Authorization

### Phase 1: Built-in Auth

- Email/password registration and login
- Session-based authentication (HTTP-only cookies)
- RBAC with roles and permissions
- User and group management UI

This gives us a working auth system for development and testing of all task assignment, role-based visibility, and group-based features from day one.

### Phase 2: OIDC Integration

- Add OIDC provider support (Keycloak, Auth0, etc.)
- Map external identity claims to internal roles/groups
- Built-in auth remains as fallback

**Rationale:** Every successful OSS project in this space (Windmill, n8n, Kestra) ships built-in auth as baseline. OIDC-only would make local development and testing painful, and would block progress on role/group features.

## Form Designer

### Phase 1: Code Editor (v1)

Monaco editor (the VS Code editor component) with four tabs:

1. **Schema** — JSON Schema defining the data model (field names, types, constraints)
2. **UI Schema** — JSON Forms UI Schema (layout, widget selection, show/hide rules)
3. **Visibility Rules** — Per-field role/group-based visibility configuration
4. **Messages** — Custom validation messages and help text

Features:
- **Live validation** indicator (valid/invalid) as the user types
- **Live preview** panel on the right showing the rendered form via JSON Forms
- **Role switcher** in the preview panel — toggle between different roles/groups to see how the form looks for each audience
- **Version management** — save drafts, publish versions
- **Ctrl+Space** for JSON Schema suggestions

### Phase 2: Visual Builder (future)

Drag-and-drop form builder that generates JSON Schema + UI Schema under the hood. The code editor remains available as an advanced mode. Phase 2 scope — not part of v1.

**Technology choice:** JSON Forms (eclipsesource) for form rendering. MIT-licensed, supports React/Angular/Vue, uses standard JSON Schema. We chose this over Camunda's form-js because form-js uses a proprietary Camunda-specific JSON format, while JSON Forms uses standard JSON Schema which enables server-side processing and avoids vendor lock-in.

## Task Inbox

Two-panel layout inspired by Camunda Tasklist:

### Left Panel — Task List
- **Filter chips:** "Assigned to me" (default), "Unassigned", "All open"
- **Search bar** for finding tasks by name, process, or reference ID
- **Sort controls:** by due date, priority, creation date
- **Task cards** showing: task name, process name, reference ID, priority badge, due date, assignee
- Active task highlighted with blue left border

### Right Panel — Task Detail + Form
- **Task header** with name, process, reference, creation date
- **Action buttons:** Unassign, Complete
- **Rendered form** via JSON Forms, populated with existing data if any
- Form fields respect role-based visibility (server-filtered)

### Task Lifecycle
1. Task is **created** (via SDK call from workflow)
2. Task appears in inbox for candidate users/groups
3. User **claims** the task (moves from "Unassigned" to "Assigned to me")
4. User fills in the form and clicks **Complete**
5. Form data is saved and a Temporal signal is sent to the workflow
6. Workflow resumes with the form data

## Role-Based Form Visibility

Server-side schema filtering. When the server sends a form to the browser, it:

1. Reads the form's `visibilityRules` configuration
2. Checks the current user's roles and groups
3. **Strips fields** from both the JSON Schema and UI Schema that the user shouldn't see
4. **Strips corresponding data** from the form data payload

The browser never receives fields or data the user isn't authorized to see. This is more secure than client-side hiding (where data is in the DOM but hidden) and simpler than maintaining multiple UI schemas per role.

**Example:** A multi-step approval form has a `SALARY` field. The `visibilityRules` say only the `hr` group can see it. When a non-HR user opens the task, the server removes `SALARY` from the schema, UI schema, and data before responding.

## SDK

### Package: `@flowstile/sdk`

Wraps the Flowstile Server REST API into ergonomic helpers for Temporal workflows.

### Primary API

```typescript
import { Flowstile } from '@flowstile/sdk';

const flowstile = new Flowstile({ baseUrl: 'http://flowstile-server:3000' });

// One-liner: create a task and block until a human completes it
const result = await flowstile.createTaskAndWait({
  taskDefinition: 'LOAN_APPLICATION',
  assignTo: { groups: ['loan-officers'] },
  data: { CUSTOMER_ID: customerId },
  priority: 'high',
  dueDate: addDays(new Date(), 3),
});

// result.data contains the completed form data
const amount = result.data.AMOUNT;
const decision = result.data.APPROVAL_DECISION;
```

### How It Works

`createTaskAndWait` does three things:
1. **Activity:** Calls `POST /tasks` on the Flowstile Server to create the task
2. **Signal wait:** Blocks the workflow on a Temporal signal (`flowstile:task:completed:<taskId>`)
3. **Returns:** The completed form data when the signal arrives

This signal-based approach means the workflow is durably paused — it survives server restarts, deploys, and crashes. The signal is sent by the Flowstile Server when a user clicks "Complete" in the task inbox.

### Additional SDK Methods

```typescript
// Create task without waiting (fire-and-forget)
const taskId = await flowstile.createTask({ ... });

// Query task status
const task = await flowstile.getTask(taskId);

// Cancel a task
await flowstile.cancelTask(taskId);
```

### Comparison to Alternatives

| | Flowstile | KuFlow | Zeebe (Camunda 8) |
|---|---|---|---|
| Task creation | `createTaskAndWait()` | `createTaskAndWaitFinished()` | Job worker pattern |
| Signal mechanism | Temporal signals | Temporal signals | Zeebe job completion |
| Form binding | Task definition code | StructureDefinition code | BPMN user task + form key |
| SDK style | Explicit REST wrapper | Explicit REST wrapper | Job worker callback |
| Workflow coupling | Loose (REST calls) | Loose (REST calls) | Tight (engine-native) |

## REST API

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | /auth/login | Email/password login |
| POST | /auth/logout | End session |
| GET | /auth/me | Current user info |

### Users
| Method | Path | Description |
|--------|------|-------------|
| GET | /users | List users |
| POST | /users | Create user |
| PATCH | /users/:id | Update user |

### Groups
| Method | Path | Description |
|--------|------|-------------|
| GET | /groups | List groups |
| POST | /groups | Create group |
| PATCH | /groups/:id | Update group (members, name) |

### Forms
| Method | Path | Description |
|--------|------|-------------|
| GET | /forms | List form definitions |
| POST | /forms | Create new form definition |
| GET | /forms/:code | Get latest published version |
| GET | /forms/:code/versions | List all versions |
| PUT | /forms/:code/draft | Update draft |
| POST | /forms/:code/publish | Publish draft as new version |

Forms are addressed by `code` (human-readable) rather than UUID in the URL. This matters for GitOps workflows — teams can reference forms by stable codes in their Temporal workflow source code and CI/CD pipelines, rather than opaque UUIDs that change across environments.

### Processes
| Method | Path | Description |
|--------|------|-------------|
| GET | /processes | List process definitions |
| POST | /processes | Create process definition |
| GET | /processes/:id | Get process definition |
| PATCH | /processes/:id | Update process definition |

### Task Definitions
| Method | Path | Description |
|--------|------|-------------|
| GET | /processes/:id/tasks | List task definitions for a process |
| POST | /processes/:id/tasks | Create task definition |
| PATCH | /task-definitions/:id | Update task definition |

### Tasks (Runtime)
| Method | Path | Description |
|--------|------|-------------|
| GET | /tasks | List tasks (filterable by status, assignee, group) |
| POST | /tasks | Create task instance (called by SDK) |
| GET | /tasks/:id | Get task with form schema (filtered by user role) |
| POST | /tasks/:id/claim | Claim task |
| POST | /tasks/:id/unclaim | Release task |
| POST | /tasks/:id/complete | Submit form data and complete |
| POST | /tasks/:id/cancel | Cancel task |

### Comparison to Alternatives

| Concern | Flowstile | KuFlow | Zeebe |
|---------|-----------|--------|-------|
| Form management | First-class `/forms` resource | Nested in process definitions | External (Camunda Forms) |
| Versioning | Independent form versions | Tied to process version | Tied to BPMN deployment |
| Task operations | REST verbs on `/tasks/:id` | REST verbs on `/tasks/:id` | gRPC job protocol |
| Auth | Built-in + future OIDC | Platform-managed | Identity service |

## Project Structure

Turborepo monorepo with four packages:

```
flowstile/
├── packages/
│   ├── server/          — NestJS app (REST API + serves React UI in prod)
│   ├── worker/          — Temporal worker (signal handler + activities)
│   ├── sdk/             — @flowstile/sdk npm package
│   └── ui/              — React app (Vite)
├── docker-compose.yml   — PostgreSQL + Temporal Server + Flowstile Server + Worker
├── package.json         — pnpm workspace root
└── turbo.json           — Turborepo build config
```

**Why Turborepo:** Shared TypeScript types between packages (e.g., task/form interfaces used by both server and SDK). Parallel builds. Single repo for coordinated releases.

**Dev experience:** `docker compose up` starts everything. The UI dev server (Vite) proxies API calls to the NestJS server. Hot reload on all packages.

## Integration Points

### DMN (Decision Model and Notation) — v1

Flowstile is agnostic to what happens inside Temporal workflows. Developers can use DMN engines (like dmn-js or dmn-eval) as Temporal activities alongside Flowstile human tasks. The SDK documentation will include a pattern example showing how to combine a DMN decision activity with a Flowstile human approval task in a single workflow.

### BPMN Visualization — Phase B

Read-only BPMN visualization generated from Temporal workflow event history using bpmn-js. This would show users where their task sits in the overall process flow. This is a **rendering concern only** — Temporal remains the source of truth for workflow execution.

### BPMN as Source of Truth — Out of Scope

Flowstile will not implement a BPMN execution engine. Temporal is the orchestrator. Projects that need BPMN-as-source should look at Camunda/Zeebe.

### AI/MCP Integration — Future Consideration

The competitive landscape shows convergence between conversational AI agents and durable workflows (UiPath Maestro's "Temporal as a Service", OpenAI Agents SDK on Temporal). Flowstile's REST API and signal-based architecture make it naturally compatible with MCP (Model Context Protocol) tools — an AI agent could create tasks, check status, and receive results through the same API the SDK uses. This is not v1 scope but the architecture doesn't preclude it.

### Regulatory Context

EU AI Act Article 14 mandates human oversight for high-risk AI systems (deadline: August 2, 2026). Flowstile's human-in-the-loop capabilities are directly relevant for organizations that need to insert human review steps into AI-driven workflows for compliance. This is a positioning consideration, not a feature requirement for v1.

## Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Backend | NestJS (TypeScript) | Structured, good DI, TypeORM support |
| Frontend | React + Vite | Ecosystem size, JSON Forms support |
| Form rendering | JSON Forms (eclipsesource) | MIT, standard JSON Schema, multi-framework |
| Code editor | Monaco Editor | VS Code engine, JSON Schema validation |
| Database | PostgreSQL | JSONB for schemas, mature, free |
| Orchestration | Temporal.io | Durable execution, signal primitives |
| Monorepo | Turborepo + pnpm | Fast builds, shared types |
| Deployment | Docker Compose (dev), containers (prod) | Self-hosted first |

## Design Decisions Log

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Target users | Platform teams first, business users later | Need developer adoption before building low-code features |
| 2 | Deployment | Self-hosted, Docker Compose for dev | Open-source positioning, easy local setup |
| 3 | Frontend | React | Ecosystem, JSON Forms support, learning goal |
| 4 | Database | PostgreSQL | JSONB, maturity, cost |
| 5 | Auth | Built-in first, OIDC later | Every successful OSS project ships built-in auth |
| 6 | Form builder | Code editor first (Monaco), visual builder later | Faster to ship, serves developer audience |
| 7 | Form format | JSON Schema (JSON Forms), not Camunda form-js | Standard format, no vendor lock-in, server-side processing |
| 8 | Task inbox | Two-panel, Camunda-style filters | Proven UX pattern for task management |
| 9 | SDK | REST API + TypeScript wrapper | Ergonomic DX, loose coupling |
| 10 | Architecture | Two services (server + worker) | Independent scaling, clean separation |
| 11 | Data model | Forms as independent versioned entities | Reuse across tasks, safe in-flight versioning |
| 12 | Visibility | Server-side schema filtering | Security over convenience |
| 13 | License | Apache 2.0 | Patent protection, enterprise-friendly |
| 14 | BPMN/DMN | DMN as activities (v1), BPMN viz (Phase B), no BPMN engine | Temporal is the orchestrator |

## In-Flight Workflow Migration — Future Phase

When a form version is bumped and the new version requires data that existing workflows don't provide, in-flight workflows need migration. Proposed approach for a future phase:

- Use Temporal's **Reset-with-Move** to restart affected workflows from a checkpoint
- Use **`patched()` / `getVersion()`** in workflow code to handle version differences
- Flowstile owns task data in PostgreSQL, so form data is independent of workflow history
- Signal-based architecture creates natural checkpoints (each human task is a pause point)

This is a hard problem. Camunda solves it with a dedicated migration tool. We'll document the pattern and build tooling when there's real-world demand.
