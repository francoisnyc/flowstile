# Workflow Validation Design Spec

**Date:** 2026-05-01
**Status:** Approved
**Goal:** Validate the end-to-end Flowstile design by proving the full signal loop: Temporal workflow creates a human task → user completes it in the inbox UI → workflow resumes with form data.

## Scope

This is a validation exercise, not a new feature. Everything needed already exists except:

1. Bearer token auth (server accepts JWT via Authorization header, not just cookies)
2. SDK auth (client can login and send JWT with requests)
3. A sample workflow that exercises `createTaskAndWait`
4. A script to start that workflow

## Non-Goals

- API key management (database-backed keys, revocation)
- Production auth hardening
- New UI features
- New API endpoints

## Design

### 1. Server: Bearer Token Auth

Extend the existing `@fastify/jwt` config in `packages/server/src/plugins/auth.ts` to extract JWT from both the cookie (browser) and the `Authorization: Bearer` header (SDK/service).

```typescript
extractToken: (request) => {
  const cookie = request.cookies?.flowstile_token;
  if (cookie) return cookie;
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
},
```

No new endpoints, no new middleware. The existing `requirePermission` checks work unchanged.

### 2. Seed: Service Account

Add a `service@flowstile.local` user to the seed script with `tasks:read` + `tasks:write` permissions (via the existing `task-user` role). This is the identity the worker uses to create tasks via the REST API.

### 3. SDK Client: Auth Support

Add optional credentials to `FlowstileClientOptions`:

```typescript
interface FlowstileClientOptions {
  baseUrl: string;
  auth?: { email: string; password: string };
}
```

The client calls `POST /auth/login` on first request, extracts the JWT from the `Set-Cookie` header, and sends it as `Authorization: Bearer <jwt>` on all subsequent requests. The JWT is cached for the lifetime of the client instance.

The `configureFlowstileActivities` function accepts the same auth options and passes them through to the client constructor.

### 4. Sample Workflow: Loan Approval

A `loanApprovalWorkflow` in `packages/worker/src/workflows.ts` that:

1. Receives input: `{ taskDefinitionId, customerName, amount, processInstanceId }`
2. Calls `createTaskAndWait` with the input, creating a REVIEW_LOAN task
3. Reads the human's decision from the completed form data
4. Returns `{ decision, notes, customerName, amount }`

This workflow uses the existing SDK `createTaskAndWait` function — no new workflow primitives.

### 5. Start Script

A `packages/worker/src/start-loan-workflow.ts` script that:

1. Connects to Temporal at `TEMPORAL_ADDRESS` (default `localhost:7233`)
2. Looks up the REVIEW_LOAN task definition ID from the Flowstile server
3. Starts a `loanApprovalWorkflow` with sample input
4. Prints the workflow ID and instructions

### 6. Dev Flow

```bash
# Terminal 1: Temporal dev server
temporal server start-dev

# Terminal 2: Flowstile server + UI (already running)

# Terminal 3: Worker
pnpm --filter @flowstile/worker dev

# Terminal 4: Start a workflow
npx tsx packages/worker/src/start-loan-workflow.ts

# Browser: login as alice, claim the task, fill form, click Complete
# Terminal 3 logs: workflow result with decision
```

## Files Changed

| File | Change |
|------|--------|
| `packages/server/src/plugins/auth.ts` | Add Bearer token extraction to `extractToken` |
| `packages/server/src/seed.ts` | Add `service@flowstile.local` user |
| `packages/sdk/src/types.ts` | Add `auth` to `FlowstileClientOptions` |
| `packages/sdk/src/client.ts` | Add login + JWT caching to `FlowstileClient` |
| `packages/sdk/src/activities.ts` | Pass auth config through `configureFlowstileActivities` |
| `packages/worker/src/workflows.ts` | Add `loanApprovalWorkflow` |
| `packages/worker/src/main.ts` | Pass auth config to `configureFlowstileActivities` |
| `packages/worker/src/start-loan-workflow.ts` | New: script to start a workflow |

## Success Criteria

1. Start Temporal dev server, Flowstile server, and worker
2. Run the start script → task appears in alice's inbox
3. Alice claims the task, fills in DECISION=APPROVED, clicks Complete
4. Worker logs the completed workflow result with the form data
5. Temporal UI shows the workflow as completed
