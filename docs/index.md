---
title: Flowstile Documentation
description: Documentation for Flowstile, the human-task and form layer for Temporal.
---

# Flowstile Documentation

Flowstile is the human-task and form layer for Temporal. It gives Temporal applications a durable way to pause for human input, render structured forms, route tasks to the right people, and resume workflows with the submitted data.

This documentation is organized into three sections.

## Getting Started

- [Developer Guide](./developer-guide.md) — architecture-first introduction for engineers evaluating, integrating, or contributing to Flowstile.

## Architecture

- [Design Decisions](./design-decisions.md) — records why certain design choices were made so later implementation does not silently collapse them.
- [Runtime Contract](./runtime-contract.md) — defines the runtime contract between Temporal workflows, the Flowstile server, worker, and web inbox.

## UI

- [UI Direction](./ui-direction.md) — frontend stack, visual tone, and interaction principles for v1.
