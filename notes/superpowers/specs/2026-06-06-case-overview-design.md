# Case Overview & Comments

## Goal

Give end users a clear sense of where a case stands — which tasks are done, what's active, what's next — and let participants discuss the case with simple flat comments.

## Architecture

The case detail page is redesigned as a two-column layout: a vertical task timeline on the left showing chronological progress, and collapsible detail panels (case data, documents, comments) on the right. Comments are a new entity scoped to cases with visibility inheriting from `canSeeCase` and posting gated by `tasks:write`. No new infrastructure — everything builds on existing case and task data.

## Design Decisions

### Task timeline over stage-based progress

Flowable uses CMMN stages and milestones for progress visualization. That requires workflow authors to declare stage metadata upfront. Flowstile's timeline derives progress entirely from existing task data (`createdAt`, `completedAt`, `status`, `assignee`, `taskDefinition.code`) — zero configuration for workflow authors. It works for linear and branching workflows alike.

### Flat chronological ordering

Tasks are ordered by `createdAt`. Parallel tasks (created at the same moment) appear adjacent with no visual branching. This keeps the timeline simple and handles parallelism implicitly. The status dots already convey what's active vs waiting.

### Case-level comments only

Camunda and Flowable attach comments to tasks. Bonitasoft attaches them to cases. Case-level comments are simpler (one thread per case) and avoid scattering conversation across multiple task-specific threads. A user working on a specific task can navigate to the case to discuss.

### No threads, reactions, or rich text

Comments are plain text, flat (no replies), immutable once posted. This matches Bonitasoft's model and keeps the scope small. Threads and rich text can be added later without schema changes.

### Comment visibility follows case visibility

If you can see the case (via `canSeeCase`), you can read its comments. Posting requires `tasks:write` — reusing the existing permission rather than introducing a new `cases:comment` permission. Read-only users (`tasks:read` only) can follow the discussion but not participate.

---

## Data Model

### New entity: `CaseComment`

Table: `case_comments`

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | uuid | PK, auto-generated | |
| `caseId` | uuid | FK → `cases.id`, NOT NULL, indexed | |
| `authorId` | uuid | FK → `users.id`, NOT NULL | |
| `body` | text | NOT NULL, 1–2000 chars | Plain text |
| `createdAt` | timestamp | NOT NULL, default now | |

No `updatedAt` — comments are immutable. No soft delete for v1.

Index: `idx_case_comment_case_id` on `caseId` for efficient listing.

### No changes to existing entities

The task timeline is derived from existing task data. No new columns on `cases` or `tasks`.

---

## API

### New endpoints

#### `GET /cases/:id/comments`

List comments for a case, ordered by `createdAt` ascending.

**Auth:** Must pass `canSeeCase` check (same visibility rules as `GET /cases/:id`).

**Response:** `{ items: CaseComment[] }`

No pagination for v1 — cases won't accumulate thousands of comments in normal usage.

**Comment shape:**
```json
{
  "id": "uuid",
  "caseId": "uuid",
  "author": {
    "id": "uuid",
    "email": "alice@example.com",
    "displayName": "Alice"
  },
  "body": "Credit score looks good, fast-tracking this one.",
  "createdAt": "2026-06-06T14:30:00.000Z"
}
```

The `author` object is eagerly joined — no second lookup needed by the UI.

#### `POST /cases/:id/comments`

Create a comment on a case.

**Auth:** Must pass `canSeeCase` check AND have `tasks:write` permission.

**Request body:**
```json
{
  "body": "string (1–2000 characters)"
}
```

**Response:** 201 with the created comment (same shape as above).

**Validation:** `body` is required, must be a non-empty string, max 2000 characters. Returns 422 if invalid.

### Changes to existing endpoints

#### `GET /cases/:id`

Add `commentCount: number` to the response. This is a `COUNT(*)` on `case_comments` for the case, computed alongside the existing query. The UI uses this to show "Comments (3)" in the panel header without fetching all comments upfront.

---

## UI

### Case detail page redesign

`packages/ui/src/pages/CaseDetailPage.tsx` — rewrite from single-column to two-column layout.

#### Header

- Case title (from `title` or `processDefinitionName` or `processInstanceId`)
- Status badge (existing)
- ProcessInstanceId chip with copy button (existing)
- Summary line: "Started by {user} · {date}" and "{completed} of {total} tasks completed"

#### Left column: Task timeline

A vertical timeline with tasks ordered by `createdAt`.

Each task entry shows:
- **Status dot** — green filled (completed), blue with inner dot (claimed/active), grey outline (created/waiting)
- **Task name** — from `taskDefinition.code`
- **Status label** — "completed", "claimed", "created", "cancelled"
- **Actor and time** — "Completed by Alice · Jun 5, 2:30 PM" or "Claimed by Bob · 30min ago" or "Waiting"
- **Submission preview card** — for completed tasks, a one-line preview of scalar submission data fields. Clickable, navigates to `/inbox?task={id}`.
- **Active task card** — blue highlight with "Open →" link. Navigates to `/inbox?task={id}`.
- **Cancelled tasks** — shown with a red ✕ dot and strikethrough styling.

Timeline connector: a 2px vertical line connecting the dots, running from first to last task.

#### Right column: Detail panels

Three collapsible panels, all expanded by default:

**Case Data** — key-value display of `case.entity` scalar fields (existing logic). Label above value.

**Documents** — file list with icons, names as download links, sizes (existing logic, moved to panel).

**Comments** — comment list + input field:
- Each comment shows: author avatar (initial circle), author name, relative time, body text.
- Input field at the bottom: text area + "Post" button. Only rendered if the current user has `tasks:write` permission.
- Comments are fetched on page load alongside the case detail.
- After posting, the new comment appears immediately (optimistic or refetch).

### API client additions

`packages/ui/src/api/client.ts`:

```typescript
listCaseComments(caseId: string): Promise<{ items: CaseComment[] }>
createCaseComment(caseId: string, body: string): Promise<CaseComment>
```

### Type additions

`packages/ui/src/types.ts`:

```typescript
interface CaseComment {
  id: string;
  caseId: string;
  author: { id: string; email: string; displayName: string };
  body: string;
  createdAt: string;
}
```

Add `commentCount: number` to `CaseDetail`.

---

## Not in scope

- **Case list page changes** — the existing list with status filters and task counts is sufficient.
- **Embeddable React SDK** — no case overview in `@flowstile/react` for now.
- **Operational dashboard** — manager/admin monitoring of all cases is a separate future project.
- **Threaded replies** — flat comments only. Threads can be added later without schema changes (add nullable `parentId` FK).
- **Reactions/emoji** — not needed for v1.
- **Rich text / Markdown** — plain text only. Markdown rendering can be added later without schema changes.
- **Real-time updates** — no WebSocket or polling. Refresh to see new comments and task progress.
- **Comment deletion or editing** — comments are immutable for v1.

---

## Testing strategy

### Server

- **Integration tests for comment endpoints:**
  - `POST /cases/:id/comments` — happy path (201), missing body (422), body too long (422), unauthorized (401), no `tasks:write` (403), case not visible (404)
  - `GET /cases/:id/comments` — returns comments in `createdAt` order, empty list for case with no comments, case not visible (404)
  - `GET /cases/:id` — verify `commentCount` is present and accurate

- **Visibility tests:**
  - User who can see the case can read comments
  - User who cannot see the case gets 404 on comment endpoints (not 403, consistent with need-to-know pattern)
  - User with `tasks:read` but not `tasks:write` can read but not post comments

### UI

- **Manual verification:**
  - Two-column layout renders correctly
  - Task timeline shows correct status dots, ordering, and actor info
  - Collapsible panels work
  - Comment posting and display work
  - Clicking timeline task cards navigates to inbox
  - Summary line shows correct counts

---

## Files changed

| Package | File | Change |
|---------|------|--------|
| server | `src/entities/case-comment.entity.ts` | **New** — CaseComment entity |
| server | `src/routes/cases.ts` | Modify — add comment endpoints, add `commentCount` to GET /cases/:id |
| server | `test/integration/case-comments.spec.ts` | **New** — comment endpoint tests |
| server | `test/integration/cases.spec.ts` | Modify — test `commentCount` field |
| ui | `src/pages/CaseDetailPage.tsx` | Rewrite — two-column layout with timeline and panels |
| ui | `src/api/client.ts` | Modify — add comment API methods |
| ui | `src/types.ts` | Modify — add `CaseComment`, add `commentCount` to `CaseDetail` |
