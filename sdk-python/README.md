# Flowstile Python SDK

Python SDK for [Flowstile](../README.md) — a human-task inbox and form layer for
Temporal.io workflows. Write your Temporal workflows in Python and pause them for
human input: a task appears in the Flowstile web inbox, a person completes a form,
and the workflow resumes with typed data via a Temporal signal.

The Flowstile **server** is language-agnostic (forms, RBAC, need-to-know
visibility, durable signal delivery). This package is a second client of that same
server, so a Python worker interoperates with the existing TypeScript stack.

## Install

```bash
uv add flowstile        # or: pip install flowstile
```

## Authoring a workflow

Because Python's Temporal SDK registers signal handlers on the workflow class and
Flowstile completion signals are dynamically named, the workflow helper is a
method on a base class (this is the one shape difference from the TypeScript SDK,
whose `createTaskAndWait` is a free function):

```python
from temporalio import workflow
from flowstile.workflows import FlowstileWorkflowBase

@workflow.defn
class LoanApprovalWorkflow(FlowstileWorkflowBase):
    @workflow.run
    async def run(self, payload: dict) -> dict:
        result = await self.create_task_and_wait(
            task_definition_code="REVIEW_LOAN",
            process_instance_id=payload["processInstanceId"],
            input_data={"AMOUNT": payload["data"]["AMOUNT"]},
            context_data={"CUSTOMER_NAME": payload["data"]["CUSTOMER_NAME"]},
            persist={"DECISION": "decision"},        # promote to the case entity
            timeout_ms=24 * 60 * 60 * 1000,          # optional deadline
        )
        return {"decision": result.data["DECISION"], "by": result.completed_by.email}
```

`create_task_and_wait` handles the durable wait, `timeout_ms` (→ `TaskTimeoutError`
+ best-effort cancel), the task-cancelled signal (→ `TaskCancelledError`), and the
declarative `context_from` / `persist` case-entity mappings.

## Running a worker

```python
import asyncio
from flowstile.worker import create_flowstile_worker
from myapp.workflows import LoanApprovalWorkflow

async def main():
    worker = await create_flowstile_worker(
        task_queue="flowstile",
        workflows=[LoanApprovalWorkflow],
        flowstile={"base_url": "http://localhost:3000", "api_key": "fsk_..."},
        temporal_address="localhost:7233",
    )
    await worker.run()

asyncio.run(main())
```

`create_flowstile_worker` registers the Flowstile activities (task create/cancel,
case-entity read/patch) alongside your own.

## Status

Mirror of the TypeScript SDK's produce-and-await core: REST client, the
`create_task_and_wait` workflow helper, the case-entity activities, and the
`context_from`/`persist` mappings. The typed code generator, the preflight doctor,
and the `define_process`/`define_task` authoring sugar are not yet ported. The
workflow helper's cleanup-after-cancellation path should be validated against a
Temporal test environment before production use.

## Development

```bash
uv sync
uv run pytest
uv run ruff check
uv run mypy
```

Licensed under Apache-2.0 (see the repository root `LICENSE`).
