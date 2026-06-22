"""Workflow definition for the e2e example, in its own sandbox-clean module.

Temporal reloads a workflow's module inside the deterministic sandbox, so this
module must import only workflow-safe things (no httpx, no Temporal client). This
mirrors the TypeScript rule that `workflows.ts` imports only
``@temporalio/workflow``-safe modules.
"""

from __future__ import annotations

from temporalio import workflow

from flowstile.errors import TaskCancelledError, TaskTimeoutError
from flowstile.workflows import FlowstileWorkflowBase


@workflow.defn
class E2EApprovalWorkflow(FlowstileWorkflowBase):
    @workflow.run
    async def run(self, params: dict) -> dict:
        result = await self.create_task_and_wait(
            task_definition_code=params["task_code"],
            process_instance_id=params["process_instance_id"],
            input_data=params.get("input_data", {}),
            persist={"DECISION": "decision"},
        )
        return {"decision": result.data["DECISION"], "completed_by": result.completed_by.email}


@workflow.defn
class LifecycleWorkflow(FlowstileWorkflowBase):
    """Surfaces how create_task_and_wait ends: completed, timed_out, or cancelled.

    Used to validate the timeout (timeout_ms → TaskTimeoutError) and the
    server-sent task-cancelled signal (→ TaskCancelledError) paths. Workflow
    *cancellation* is validated separately by cancelling the handle (it cannot
    return a marker — it re-raises and the workflow ends CANCELLED).
    """

    @workflow.run
    async def run(self, params: dict) -> dict:
        try:
            result = await self.create_task_and_wait(
                task_definition_code=params["task_code"],
                process_instance_id=params["process_instance_id"],
                timeout_ms=params.get("timeout_ms"),
            )
            return {"outcome": "completed", "decision": result.data.get("DECISION")}
        except TaskTimeoutError:
            return {"outcome": "timed_out"}
        except TaskCancelledError:
            return {"outcome": "cancelled"}


@workflow.defn
class ContextFromWorkflow(FlowstileWorkflowBase):
    """Two sequential tasks: the first persists DECISION onto the case entity;
    the second uses context_from to project it back into its own contextData.
    Validates the input mapping + the get_flowstile_case_entity activity e2e.
    """

    @workflow.run
    async def run(self, params: dict) -> dict:
        code = params["task_code"]
        pid = params["process_instance_id"]
        first = await self.create_task_and_wait(
            task_definition_code=code,
            process_instance_id=pid,
            persist={"DECISION": "decision"},
        )
        second = await self.create_task_and_wait(
            task_definition_code=code,
            process_instance_id=pid,
            context_from=["decision"],
        )
        return {"first": first.data["DECISION"], "second": second.data["DECISION"]}
