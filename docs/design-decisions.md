---
title: Design Decisions
description: Records important design choices that shape Flowstile's product model and runtime boundaries.
---

# Flowstile Design Decisions

This note captures important design choices that shape Flowstile's product model and runtime boundaries. It is not a full spec. It exists to record why certain decisions were made so later implementation does not silently collapse them.

## Why Flowstile Uses Explicit Task Contracts

Flowstile intentionally uses a more explicit runtime task model than a single generic `data` payload.

The v1 runtime model distinguishes between:

- `inputData`
- `contextData`
- `submissionData`

Alongside those payloads, Flowstile distinguishes between:

- the input contract
- the context contract
- the submission contract

## Why Not Collapse Everything Into One Task Data Blob

A single task `data` object is initially simpler to explain, but it tends to overload too many meanings into one structure:

- workflow-provided input
- read-only supporting business context
- human-editable data
- human-submitted result

That simplicity becomes fragile once the product has to handle:

- partial form progress
- external systems of record
- RBAC-aware context delivery
- field visibility
- in-flight compatibility across form versions
- auditability of what the workflow supplied versus what the human changed

Flowstile separates these concerns because they evolve differently and are owned by different parts of the system.

## Ownership Boundaries

The runtime split supports a clearer ownership model:

- the workflow owns task meaning and provides the candidate task payloads
- Flowstile owns task persistence, validation, lifecycle, and authorized delivery
- the assignee edits only the submission payload

This keeps Flowstile from becoming an accidental system of record for the entire business object while still allowing it to manage human work durably.

## Why Context Is Separate

`contextData` exists because humans often need to see business information that they should not directly edit.

Examples:

- customer summaries
- historical approvals
- computed risk indicators
- external references
- read-only snapshots

If that information is collapsed into the same payload as editable submission data, the system becomes harder to reason about:

- it is less clear what the form is actually allowed to modify
- it is harder to filter sensitive context safely
- it is harder to explain compatibility rules

By separating context from submission, Flowstile can persist rich supporting data while still presenting a strict editable contract to the assignee.

## Raw Context vs. Effective Context

Flowstile distinguishes between:

- raw stored `contextData`
- effective context delivered to a specific user

The workflow or surrounding application assembles the candidate context for the task. Flowstile stores that context and then applies role/group visibility rules before sending any view of it to the browser.

This means:

- the workflow defines what context may be relevant
- Flowstile defines what context a given user may actually see

This split keeps business context assembly out of the UI while keeping security enforcement inside the product boundary.

## Why This Is Better Than a Simpler Unified Model

Compared to a unified task-data model, the explicit contract model gives Flowstile stronger footing in these areas:

- clearer workflow-to-task boundary
- safer handling of external business data
- better change management
- cleaner distinction between read-only and editable data
- stronger auditability
- easier future support for richer visibility policies

The tradeoff is extra conceptual weight. Flowstile accepts that tradeoff because the human-task product surface is already carrying workflow orchestration, identity, form versioning, and task lifecycle semantics. Making the data boundary explicit reduces accidental complexity later.

## Current Decision

Flowstile should keep the explicit `inputData`, `contextData`, and `submissionData` split in its design and runtime documentation.

If future implementation pressure suggests collapsing these concepts for convenience, that change should be treated as a real architectural decision rather than a harmless simplification.
