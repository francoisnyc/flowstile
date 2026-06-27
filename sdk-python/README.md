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

### Typed results & task descriptors (codegen)

`flowstile-codegen` reads a process's live forms and generates a typed model per
form **and** a `FlowstileTask` descriptor per task that binds the task code to its
model (a thin wrapper over `datamodel-code-generator`):

```bash
pip install 'flowstile[codegen]'
flowstile-codegen --process "Loan Origination" --api-key fsk_... --out loan_models.py
```

```python
# loan_models.py (generated — do not edit)
class LoanApplicationReviewOutput(BaseModel):
    DECISION: Literal["PROCEED", "REJECT"]
    ...

LOAN_REVIEW_APPLICATION = FlowstileTask("LOAN_REVIEW_APPLICATION", output=LoanApplicationReviewOutput)
```

Pass the descriptor — the code and model **can't be mismatched**, and `result.data`
is typed and validated:

```python
from loan_models import LOAN_REVIEW_APPLICATION

result = await self.create_task_and_wait(LOAN_REVIEW_APPLICATION, input_data={...})
if result.data.DECISION == "PROCEED":   # typed; mypy-checked
    ...
```

Keep it honest in CI with the drift guard (regenerate-and-diff; non-zero if stale):

```bash
flowstile-codegen --process "Loan Origination" --api-key fsk_... --out loan_models.py --check
```

For quick or dynamic cases, skip codegen: pass an `output=AModel` you hand-write,
or omit it and `result.data` is a plain dict. Runnable worker:
[`examples/loan_approval_worker.py`](examples/loan_approval_worker.py).

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
        preflight=[LOAN_REVIEW_APPLICATION],   # codes/descriptors → fail boot on a typo
    )
    await worker.run()

asyncio.run(main())
```

`create_flowstile_worker` registers the Flowstile activities (task create/cancel,
case-entity read/patch) alongside your own. The optional `preflight=` checks each
task code resolves to a published form at startup (with a "did you mean" hint),
so a typo fails loudly at boot, not mid-workflow (`FLOWSTILE_DOCTOR=warn`/`off`
to soften/skip).

## Status

Mirror of the TypeScript SDK's produce-and-await core: REST client, the
`create_task_and_wait` workflow helper, the case-entity activities, and the
`context_from`/`persist` mappings. The runtime surface is validated **end to end
against a live Temporal + Flowstile server** (`tests/integration/`, run with
`FLOWSTILE_E2E=1`): the happy path (create → human-complete → resume); both
mappings — `persist` (output) and `context_from` (input), with the case-entity
read/patch activities; `timeout_ms` (→ `TaskTimeoutError` + task cancelled); the
server-sent task-cancelled signal (→ `TaskCancelledError`); and workflow
cancellation (best-effort task cleanup). These double as the worked Python example.

At parity with the TypeScript SDK's authoring DX: typed results (`output=` or
generated models), generated task descriptors that bind code↔model, the `--check`
drift guard, and a worker-boot `preflight=` that validates task codes resolve to
published forms. The `define_process` sugar is intentionally not ported —
descriptors + `create_task_and_wait` cover the same ground more idiomatically in
Python.

## Development

```bash
uv sync
uv run pytest
uv run ruff check
uv run mypy
```

Licensed under Apache-2.0 (see the repository root `LICENSE`).
