# Task Variable Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `POST /tasks/search` endpoint that filters tasks by business variables stored in JSONB columns, backed by GIN indexes.

**Architecture:** New search endpoint in the existing tasks route file with Zod-validated body schema. Variable filters translate to PostgreSQL JSONB containment (`@>`) for exact match and `LIKE` for pattern match. GIN indexes on `inputData`, `contextData`, and `submissionData` columns provide sub-millisecond lookups.

**Tech Stack:** Fastify, Zod, TypeORM QueryBuilder, PostgreSQL JSONB + GIN indexes, Vitest

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `packages/server/src/plugins/database.ts` | Add GIN index creation after DataSource initialization |
| Modify | `packages/server/src/routes/tasks.ts` | Add `POST /tasks/search` route with Zod schema and QueryBuilder |
| Create | `packages/server/test/integration/task-search.spec.ts` | Integration tests for the search endpoint |
| Modify | `docs/openapi.yaml` | Regenerated OpenAPI spec (auto-generated) |

---

### Task 1: Add GIN Indexes on JSONB Columns

The project uses `synchronize: true` and has no migration files. GIN indexes require raw SQL — TypeORM's entity decorators only support B-tree indexes. The cleanest approach is to run idempotent `CREATE INDEX IF NOT EXISTS` statements after the DataSource initializes.

**Files:**
- Modify: `packages/server/src/plugins/database.ts`

- [ ] **Step 1: Read the database plugin**

Read `packages/server/src/plugins/database.ts` to find where `dataSource.initialize()` is called.

- [ ] **Step 2: Add GIN index creation after DataSource initialization**

In `packages/server/src/plugins/database.ts`, immediately after the `await dataSource.initialize()` call, add:

```typescript
// Create GIN indexes for JSONB variable search (idempotent)
await dataSource.query(`
  CREATE INDEX IF NOT EXISTS idx_tasks_input_data_gin ON tasks USING GIN ("inputData" jsonb_path_ops);
  CREATE INDEX IF NOT EXISTS idx_tasks_context_data_gin ON tasks USING GIN ("contextData" jsonb_path_ops);
  CREATE INDEX IF NOT EXISTS idx_tasks_submission_data_gin ON tasks USING GIN ("submissionData" jsonb_path_ops);
`);
```

These are idempotent (`IF NOT EXISTS`) so safe to run on every startup.

- [ ] **Step 3: Verify the build compiles**

```bash
pnpm --filter @flowstile/server build
```

Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/plugins/database.ts
git commit -m "feat(server): add GIN indexes on task JSONB columns for variable search"
```

---

### Task 2: Add the Search Endpoint Zod Schema and Route

**Files:**
- Modify: `packages/server/src/routes/tasks.ts`

- [ ] **Step 1: Define the Zod schemas**

In `packages/server/src/routes/tasks.ts`, after the existing `CompleteTaskBody` schema (line 70), add the search schemas:

```typescript
const VariableFilter = z.object({
  name: z.string().min(1),
  operator: z.enum(['eq', 'like']).default('eq'),
  value: z.union([z.string(), z.number()]),
}).refine(
  (f) => f.operator !== 'like' || (typeof f.value === 'string' && f.value.includes('%')),
  { message: 'like operator requires a string value containing at least one % wildcard' },
);

const SearchTasksBody = z.object({
  status: z.nativeEnum(TaskStatus).optional(),
  assigneeId: z.string().uuid().optional(),
  group: z.string().optional(),
  inputVariables: z.array(VariableFilter).optional(),
  contextVariables: z.array(VariableFilter).optional(),
  submissionVariables: z.array(VariableFilter).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
}).refine(
  (body) => {
    const total = (body.inputVariables?.length ?? 0)
      + (body.contextVariables?.length ?? 0)
      + (body.submissionVariables?.length ?? 0);
    return total <= 10;
  },
  { message: 'Maximum 10 variable filters total across all scopes' },
);
```

Note: The max-10 limit is enforced across all three scopes combined via a top-level `.refine()`, not per-array.

- [ ] **Step 2: Add the route handler**

Inside the `taskRoutes` function, after the `GET /tasks` route (after line 100), add:

```typescript
app.post('/tasks/search', { ...read, schema: { body: SearchTasksBody, tags: ['Tasks'] } }, async (request) => {
  const {
    status, assigneeId, group,
    inputVariables, contextVariables, submissionVariables,
    limit, offset,
  } = request.body;

  const qb = repo()
    .createQueryBuilder('t')
    .leftJoinAndSelect('t.taskDefinition', 'td')
    .leftJoinAndSelect('t.assignee', 'a')
    .orderBy('t.createdAt', 'DESC')
    .limit(limit)
    .offset(offset);

  if (status) qb.andWhere('t.status = :status', { status });
  if (assigneeId) qb.andWhere('t.assigneeId = :assigneeId', { assigneeId });
  if (group) qb.andWhere(':group = ANY(td.candidateGroups)', { group });

  let paramCounter = 0;
  const applyVariableFilters = (
    filters: { name: string; operator: string; value: string | number }[] | undefined,
    column: string,
  ) => {
    if (!filters?.length) return;

    for (const filter of filters) {
      const idx = paramCounter++;

      if (filter.operator === 'like') {
        if (typeof filter.value !== 'string') continue;
        qb.andWhere(
          `jsonb_extract_path_text(t."${column}", :vname_${idx}) LIKE :vval_${idx}`,
          { [`vname_${idx}`]: filter.name, [`vval_${idx}`]: filter.value },
        );
      } else {
        const containment = JSON.stringify({ [filter.name]: filter.value });
        qb.andWhere(
          `t."${column}" @> :vval_${idx}::jsonb`,
          { [`vval_${idx}`]: containment },
        );
      }
    }
  };

  applyVariableFilters(inputVariables, 'inputData');
  applyVariableFilters(contextVariables, 'contextData');
  applyVariableFilters(submissionVariables, 'submissionData');

  const [items, total] = await qb.getManyAndCount();
  return paginate(items.map(serializeTask), total, limit, offset);
});
```

**Security notes:**
- The `column` parameter is one of three hardcoded strings (`inputData`, `contextData`, `submissionData`) — never user input.
- For `eq`: `filter.name` goes into `JSON.stringify()`, the result is passed as a parameterized value — no injection risk.
- For `like`: both `filter.name` and `filter.value` are parameterized via `jsonb_extract_path_text()`.

- [ ] **Step 3: Verify the build compiles**

```bash
pnpm --filter @flowstile/server build
```

Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/routes/tasks.ts
git commit -m "feat(server): add POST /tasks/search endpoint with variable filters"
```

---

### Task 3: Integration Tests — Exact Match Filters

**Files:**
- Create: `packages/server/test/integration/task-search.spec.ts`

- [ ] **Step 1: Write the test file with exact-match tests**

Create `packages/server/test/integration/task-search.spec.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import {
  createTestUser,
  loginAs,
  authed,
  createTestTaskSetup,
  cleanupTestData,
} from './helpers.js';

describe('POST /tasks/search', () => {
  let app: FastifyInstance;
  let cookie: string;
  let taskDefId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const user = await createTestUser(app, { permissions: ['tasks:read', 'tasks:write'] });
    cookie = await loginAs(app, user.email);

    const { taskDef } = await createTestTaskSetup(app);
    taskDefId = taskDef.id;
  });

  afterAll(async () => {
    await cleanupTestData(app);
    await app.close();
  });

  async function createTask(overrides: Record<string, unknown> = {}) {
    const res = await authed(app, cookie, {
      method: 'POST',
      url: '/tasks',
      payload: {
        taskDefinitionId: taskDefId,
        workflowId: `wf-search-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        ...overrides,
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string }>().id;
  }

  function search(body: Record<string, unknown>) {
    return authed(app, cookie, {
      method: 'POST',
      url: '/tasks/search',
      payload: body,
    });
  }

  it('returns all tasks when no filters are provided', async () => {
    const id = await createTask({ inputData: { ORDER_ID: 'all-test' } });

    const res = await search({});
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[]; total: number }>();
    expect(body.items.map((t) => t.id)).toContain(id);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('filters by inputVariables with eq operator', async () => {
    const matchId = await createTask({ inputData: { ORDER_ID: 'ORD-SEARCH-1' } });
    await createTask({ inputData: { ORDER_ID: 'ORD-SEARCH-2' } });

    const res = await search({
      inputVariables: [{ name: 'ORDER_ID', operator: 'eq', value: 'ORD-SEARCH-1' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string; inputData: Record<string, unknown> }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
    expect(body.items.every((t) => t.inputData.ORDER_ID === 'ORD-SEARCH-1')).toBe(true);
  });

  it('filters by numeric eq', async () => {
    const matchId = await createTask({ inputData: { AMOUNT: 99999 } });
    await createTask({ inputData: { AMOUNT: 11111 } });

    const res = await search({
      inputVariables: [{ name: 'AMOUNT', operator: 'eq', value: 99999 }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
  });

  it('filters by contextVariables', async () => {
    const matchId = await createTask({ contextData: { REGION: 'US-EAST' } });
    await createTask({ contextData: { REGION: 'EU-WEST' } });

    const res = await search({
      contextVariables: [{ name: 'REGION', operator: 'eq', value: 'US-EAST' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
  });

  it('filters by submissionVariables', async () => {
    const id = await createTask();
    await authed(app, cookie, { method: 'POST', url: `/tasks/${id}/claim` });
    await authed(app, cookie, {
      method: 'POST',
      url: `/tasks/${id}/complete`,
      payload: { data: { DECISION: 'APPROVED' } },
    });

    const res = await search({
      submissionVariables: [{ name: 'DECISION', operator: 'eq', value: 'APPROVED' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(id);
  });

  it('combines metadata and variable filters (AND)', async () => {
    const matchId = await createTask({
      inputData: { ORDER_ID: 'ORD-COMBO-1' },
    });

    const res = await search({
      status: 'created',
      inputVariables: [{ name: 'ORDER_ID', operator: 'eq', value: 'ORD-COMBO-1' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
  });

  it('combines filters across multiple scopes (AND)', async () => {
    const matchId = await createTask({
      inputData: { ORDER_ID: 'ORD-MULTI-1' },
      contextData: { CUSTOMER: 'Acme Corp' },
    });
    await createTask({
      inputData: { ORDER_ID: 'ORD-MULTI-1' },
      contextData: { CUSTOMER: 'Other Corp' },
    });

    const res = await search({
      inputVariables: [{ name: 'ORDER_ID', operator: 'eq', value: 'ORD-MULTI-1' }],
      contextVariables: [{ name: 'CUSTOMER', operator: 'eq', value: 'Acme Corp' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
    expect(body.items.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
pnpm --filter @flowstile/server test:integration -- --testPathPattern task-search
```

Expected: All 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/server/test/integration/task-search.spec.ts
git commit -m "test(server): add integration tests for task search exact-match filters"
```

---

### Task 4: Integration Tests — Like Operator, Validation, and Edge Cases

**Files:**
- Modify: `packages/server/test/integration/task-search.spec.ts`

- [ ] **Step 1: Add like operator, validation, and edge case tests**

Append these tests inside the existing `describe('POST /tasks/search', ...)` block in `packages/server/test/integration/task-search.spec.ts`:

```typescript
  it('filters with like operator using % wildcard', async () => {
    const matchId = await createTask({ inputData: { ORDER_ID: 'ORD-LIKE-001' } });
    await createTask({ inputData: { ORDER_ID: 'INVOICE-001' } });

    const res = await search({
      inputVariables: [{ name: 'ORDER_ID', operator: 'like', value: 'ORD-LIKE%' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: { id: string; inputData: Record<string, unknown> }[] }>();
    expect(body.items.map((t) => t.id)).toContain(matchId);
    expect(body.items.every((t) => String(t.inputData.ORDER_ID).startsWith('ORD-LIKE'))).toBe(true);
  });

  it('rejects like operator with numeric value', async () => {
    const res = await search({
      inputVariables: [{ name: 'AMOUNT', operator: 'like', value: 123 }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects like operator without % wildcard', async () => {
    const res = await search({
      inputVariables: [{ name: 'ORDER_ID', operator: 'like', value: 'ORD-001' }],
    });
    expect(res.statusCode).toBe(400);
  });

  it('respects pagination (limit and offset)', async () => {
    const marker = `PAGINATE-${Date.now()}`;
    await createTask({ inputData: { MARKER: marker } });
    await createTask({ inputData: { MARKER: marker } });
    await createTask({ inputData: { MARKER: marker } });

    const res1 = await search({
      inputVariables: [{ name: 'MARKER', operator: 'eq', value: marker }],
      limit: 2,
      offset: 0,
    });
    expect(res1.statusCode).toBe(200);
    const body1 = res1.json<{ items: unknown[]; total: number; limit: number; offset: number }>();
    expect(body1.items.length).toBe(2);
    expect(body1.total).toBe(3);
    expect(body1.limit).toBe(2);
    expect(body1.offset).toBe(0);

    const res2 = await search({
      inputVariables: [{ name: 'MARKER', operator: 'eq', value: marker }],
      limit: 2,
      offset: 2,
    });
    const body2 = res2.json<{ items: unknown[]; total: number }>();
    expect(body2.items.length).toBe(1);
    expect(body2.total).toBe(3);
  });

  it('returns 403 without tasks:read permission', async () => {
    const noPermsUser = await createTestUser(app, { permissions: [] });
    const noPermsCookie = await loginAs(app, noPermsUser.email);

    const res = await authed(app, noPermsCookie, {
      method: 'POST',
      url: '/tasks/search',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns empty results when no tasks match', async () => {
    const res = await search({
      inputVariables: [{ name: 'NONEXISTENT', operator: 'eq', value: 'no-match' }],
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{ items: unknown[]; total: number }>();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
```

- [ ] **Step 2: Run all search tests**

```bash
pnpm --filter @flowstile/server test:integration -- --testPathPattern task-search
```

Expected: All 13 tests pass.

- [ ] **Step 3: Run the full test suite to check for regressions**

```bash
pnpm test
```

Expected: All tests pass (existing 148 + 13 new = 161).

- [ ] **Step 4: Commit**

```bash
git add packages/server/test/integration/task-search.spec.ts
git commit -m "test(server): add like operator, validation, and pagination tests for task search"
```

---

### Task 5: Update OpenAPI Spec

**Files:**
- Modify: `docs/openapi.yaml` (auto-generated)

- [ ] **Step 1: Regenerate the OpenAPI spec**

The new route's Zod schema is automatically picked up by `@fastify/swagger`. Regenerate:

```bash
pnpm --filter @flowstile/server openapi:generate
```

- [ ] **Step 2: Verify the new endpoint appears**

Check that `POST /tasks/search` appears in the generated spec:

```bash
grep -A 2 '/tasks/search' docs/openapi.yaml
```

Expected: The endpoint appears with `requestBody` schema and the `Tasks` tag.

- [ ] **Step 3: Commit**

```bash
git add docs/openapi.yaml
git commit -m "docs: regenerate OpenAPI spec with POST /tasks/search"
```
