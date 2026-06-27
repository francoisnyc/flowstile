# Task Variable Search Design

## Goal

Allow users and systems to find tasks by business data stored in `inputData`, `contextData`, and `submissionData` JSONB columns — without a schema change or separate variables table.

## Background

Currently `GET /tasks` filters only by `status`, `assigneeId`, and `group`. There is no way to answer "find all tasks for order ORD-2024-1002" or "all loan applications where the customer name starts with 'Alice'" without fetching everything client-side.

Industry platforms (Camunda, Flowable) solve this with structured variable filters. Their legacy approach (EAV variables table) is poorly suited to PostgreSQL — JSONB with GIN indexes is the modern equivalent with better performance, less storage, and simpler queries.

## Design

### Endpoint

```
POST /tasks/search
```

- **Permission:** `tasks:read`
- **Response:** Standard paginated shape `{ items, total, limit, offset }` with the same task serialization as `GET /tasks` (includes `taskDefinition`, `assignee`).

### Request Body Schema

```json
{
  "status": "claimed",
  "assigneeId": "uuid",
  "group": "loan-officers",
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

All fields are optional. If no filters are provided, behaves like `GET /tasks` (returns all tasks, paginated).

### Variable Filter Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | The JSON key to match |
| `operator` | `"eq"` \| `"like"` | no (default: `"eq"`) | Match operator |
| `value` | string \| number | yes | The value to match against |

### Filter Semantics

- Multiple variable filters within a scope are **ANDed**.
- Filters across scopes (`inputVariables` + `submissionVariables`) are **ANDed**.
- Metadata filters (`status`, `assigneeId`, `group`) are **ANDed** with variable filters.
- No OR logic in v1.

### Query Translation

| Operator | SQL Generation |
|----------|---------------|
| `eq` (string) | `column @> '{"KEY": "value"}'::jsonb` |
| `eq` (number) | `column @> '{"KEY": 123}'::jsonb` |
| `like` | `column->>'KEY' LIKE 'value'` |

The `eq` operator uses JSONB containment (`@>`), which is covered by the GIN `jsonb_path_ops` index. The `like` operator falls back to an index scan on the text extraction — acceptable for infrequent use, and specific expression indexes can be added later for hot fields.

### Database Migration

Add GIN indexes on the three JSONB columns. No table schema changes.

```sql
CREATE INDEX idx_tasks_input_data ON task USING GIN (input_data jsonb_path_ops);
CREATE INDEX idx_tasks_context_data ON task USING GIN (context_data jsonb_path_ops);
CREATE INDEX idx_tasks_submission_data ON task USING GIN (submission_data jsonb_path_ops);
```

### Validation

- `name` must be a non-empty string.
- `operator` must be `"eq"` or `"like"`.
- `value` must be a string or number. Objects and arrays are rejected.
- `like` operator requires `value` to be a string. Numbers are rejected for `like`.
- `like` values must contain at least one `%` wildcard (otherwise use `eq`).
- Maximum 10 variable filters total across all scopes per request.

### Security

- The endpoint requires `tasks:read` permission (same as `GET /tasks`).
- Variable values are parameterized — no SQL injection risk from `@>` containment or `LIKE` with parameterized patterns.
- The `like` operator uses PostgreSQL `LIKE` (not `ILIKE`) — case-sensitive by default.

## Scope

### In scope

- `POST /tasks/search` endpoint with Zod schema validation
- Scoped variable filters: `inputVariables`, `contextVariables`, `submissionVariables`
- Operators: `eq`, `like`
- GIN indexes on all three JSONB columns
- Integration tests covering: exact match, like match, compound filters, empty filters, invalid input

### Out of scope (future additions)

- Range operators (`gt`, `gte`, `lt`, `lte`) — requires expression indexes per field
- `in` operator (match any of N values)
- `includeVariables` response projection
- OR logic between variable filters
- Full-text search
- Sorting by variable values

## Relation to Existing Endpoints

`GET /tasks` remains unchanged — it serves the simple inbox list with metadata filters. `POST /tasks/search` is the power-user endpoint for variable-based queries. Both return the same response shape.
