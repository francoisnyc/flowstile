---
title: Flowstile Documentation
description: Documentation for Flowstile, the human-task and form layer for Temporal.
---

# Flowstile Documentation

Flowstile is the human-task and form layer for Temporal — a durable way to pause
workflows for human input, render structured forms, route tasks to the right
people, and resume with the submitted data. Processes are defined in **code**
(TypeScript or Python) and are authorable by an AI coding agent.

New here? Skim the **Developer Guide**, then run the demo from the
[README](../README.md).

## Guides

- [Developer Guide](./developer-guide.md) — architecture-first introduction for
  engineers evaluating, integrating, or contributing.
- [Process Authoring Guide](./process-authoring-guide.md) — author a process end
  to end: code-first definition, forms, typed workflow, and validation (covers
  both the TypeScript and Python worker tracks).
- [Self-Hosting](./self-hosting.md) — production deployment runbook: topology,
  environment variables, migrations, first-run admin bootstrap, secrets,
  observability.
- [Ad-Hoc Tasks with Inline Forms](./ad-hoc-tasks.md) — raise a one-off human task
  whose form is supplied at runtime, for emergent/agent-driven steps with no
  pre-published form.
- [Chat Tasks (Conversational Forms)](./chat-tasks.md) — fill a task by
  conversation: an agent gathers the data, the human reviews and commits it.

## Reference & Architecture

- [Runtime Contract](./runtime-contract.md) — the payload model, task/case
  lifecycle, state machine, and access rules any implementation must follow.
- [Design Decisions](./design-decisions.md) — why the task data model is split,
  declarative-data/imperative-control, and why BPMN constructs map to Temporal
  code rather than Flowstile features.
- [OpenAPI Spec](./openapi.yaml) — the authoritative REST API contract.
- [UI Direction](./ui-direction.md) — frontend stack, visual tone, and interaction
  principles.

## How it compares

- [KuFlow Comparison](./kuflow-comparison.md) — method-by-method Flowstile vs the
  KuFlow SDK.
- [Competitive Landscape](./competitive-landscape.md) — where Flowstile fits among
  KuFlow, Camunda, and building it yourself on Temporal.
