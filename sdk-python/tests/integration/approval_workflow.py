"""Workflow definition for the e2e example, in its own sandbox-clean module.

Temporal reloads a workflow's module inside the deterministic sandbox, so this
module must import only workflow-safe things (no httpx, no Temporal client). This
mirrors the TypeScript rule that `workflows.ts` imports only
``@temporalio/workflow``-safe modules.
"""

from __future__ import annotations

from temporalio import workflow

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
