# Code review — attachment / document feature

Scope: the attachment feature as introduced by `1ce3f54` (Phases 1–8),
`0a2b92b`, `d3ea13a` (react), `2aee3e1` (e2e), reviewed against `master`.
Findings are ordered by severity. Each entry is `file:line — problem — fix`.

The feature is in good shape overall: uploads stream to the store (no full
buffering), the global size cap is enforced at the multipart layer with the
partial upload cleaned up on overflow, terminal tasks reject uploads, linking
happens inside the completion transaction after the state-machine transition,
download gates pending vs. linked access, and `toReference` already coerces the
`bigint` size with `Number()`. The findings below are the gaps that remain.

---

## Medium

### M1. `accept` / `maxSize` are validated against client-supplied metadata, not the stored upload
`packages/server/src/common/attachments.ts:105-124`,
`packages/server/src/routes/tasks.ts:489-516`

At completion, `validateAndCollectReferences` enforces the field's `accept` and
`maxSize` using `ref.contentType` and `ref.size` — values taken from the
**client-supplied** reference object in `submissionData`, not from the
authoritative `Attachment` row. The completion handler *does* load the
`Attachment` rows immediately after (`routes/tasks.ts:506`) to verify ownership
and `PENDING` status, but it never re-checks size/content-type against them.

So the constraints are trivially bypassed: upload a 50 MB executable (succeeds —
only the 25 MB global cap applies at upload, and content-type is never checked
there), then complete with
`{ DOCUMENT: { attachmentId: <real>, size: 100, contentType: "application/pdf", ... } }`.
Both the `maxSize` and `accept` checks pass against the spoofed values, and the
task completes with a 50 MB EXE linked to a "PDF only, 5 MB" field.

Fix: validate `accept`/`maxSize` against the loaded `Attachment` row
(`att.contentType`, `att.size`), not the request ref. Since the rows are
already fetched at `routes/tasks.ts:506`, pass them into the check (or re-derive
the ref from `att` before validating).

### M2. Completed `submissionData` stores client-controlled file metadata verbatim
`packages/server/src/routes/tasks.ts:518-520`

`mergedSubmission` (the client's ref objects) is persisted as-is. Only
`attachmentId` is authenticated against the DB; `fileName`, `size`, `checksum`,
and `contentType` in the stored ref are whatever the client sent. Download
itself is safe (it reads `fileName`/`contentType`/`size` from the
`Attachment` row at `routes/attachments.ts:142-144`), but every other consumer
of `submissionData` — the completion **signal payload** delivered to the
Temporal workflow, the inbox UI, variable search — sees the spoofed metadata. A
workflow that branches on `submissionData.DOCUMENT.checksum` or `.fileName` is
acting on attacker-controlled data.

Fix: when linking, overwrite each stored ref's metadata from the authoritative
`Attachment` row (rebuild via `toReference(att)`) so `submissionData` and the
signal payload carry trustworthy values. This also resolves M1.

### M3. Pending uploads are swept after 24h, breaking slow completions
`packages/server/src/plugins/attachment-sweeper.ts:9,26-34`

Attachments stay `PENDING` until task completion links them. The sweeper
deletes `PENDING` rows (and their bytes) older than `ATTACHMENT_ORPHAN_TTL_MS`,
default `86400000` (24h). If more than 24h elapse between upload and completion,
the blob and row are deleted; the completion handler's "must be a pending
upload for this task" check (`routes/tasks.ts:509-515`) then fails with `422`
and the user can no longer complete with that file.

Flowstile tasks are explicitly long-lived (the SDK's default `timeoutMs` is 24h
and human tasks routinely wait days), and a user may attach a document early in
a multi-day task. A 24h orphan TTL is short relative to that window.

Fix: raise the default TTL well above the expected upload→complete gap and
document the ceiling; or, more durably, link (or otherwise mark "referenced by
a live task") at the moment a ref is saved rather than only at completion, so
in-flight attachments are never eligible for sweeping.

---

## Low

### L1. Content-Disposition allows CR/LF/control-char header injection
`packages/server/src/routes/attachments.ts:142-144`

```ts
.header('Content-Type', att.contentType)
.header('Content-Disposition', `attachment; filename="${att.fileName.replace(/"/g, '\\"')}"`)
```

Double quotes are escaped, but `fileName` (from the client's `data.filename` at
upload, line 79) can still contain CR/LF or other control characters, which can
break or inject response headers. There's also no RFC 5987 `filename*` for
non-ASCII names, and the client-supplied `contentType` is echoed back as the
response `Content-Type` with no `X-Content-Type-Options: nosniff`.

Fix: strip control characters (`fileName.replace(/[\x00-\x1f]/g, '')`) in
addition to escaping quotes, emit `filename*=UTF-8''<encodeURIComponent(name)>`
alongside an ASCII fallback, and add `X-Content-Type-Options: nosniff`. (The
forced `Content-Disposition: attachment` already prevents inline rendering, so
this is defense in depth.)

### L2. A LINKED attachment with a null `fieldKey` bypasses the visibility check
`packages/server/src/routes/attachments.ts:117-137`

Download access control only applies the field-visibility check when
`att.status === LINKED && att.fieldKey` is truthy. A `LINKED` row with
`fieldKey === null` matches neither branch, so any user with `tasks:read` on the
task can download it. In the current flow `fieldKey` is always resolved from the
schema at link time (`routes/tasks.ts:563`), so this shouldn't occur — but it's
an unsafe default: a future code path that links without a field key silently
opens access.

Fix: treat "linked but unresolved field" as deny-by-default (fall through to an
explicit `403` / uploader-or-manage check) rather than letting it skip
authorization.

### L3. Sweeper loads all orphans unbatched
`packages/server/src/plugins/attachment-sweeper.ts:31-50`

`sweep()` does a single `getMany()` of every `PENDING` orphan past the cutoff,
then deletes them one-by-one in a loop. After downtime or a TTL change this set
could be large, loading every row into memory in one query. Minor.

Fix: add `.take(BATCH_SIZE)` and let the poll interval drain the backlog across
ticks.
</content>
