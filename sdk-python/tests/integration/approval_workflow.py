"""Workflow definition for the e2e example, in its own sandbox-clean module.

Temporal reloads a workflow's module inside the deterministic sandbox, so this
module must import only workflow-safe things (no httpx, no Temporal client). This
mirrors the TypeScript rule that `workflows.ts` imports only
``@temporalio/workflow``-safe modules.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Literal

from pydantic import BaseModel
from temporalio import workflow
from temporalio.common import RetryPolicy

from flowstile import FlowstileTask
from flowstile.errors import TaskCancelledError, TaskTimeoutError
from flowstile.workflows import FlowstileWorkflowBase


@workflow.defn
class AgentStepWorkflow(FlowstileWorkflowBase):
    """'Agent as a step': a (simulated) agent does automated work and records its
    trajectory to the case timeline, then a human reviews it. Demonstrates the
    two-tier split — load-bearing values go to the case entity; the agent's story
    goes to the case-event log.
    """

    @workflow.run
    async def run(self, params: dict) -> dict:
        pid = params["process_instance_id"]
        amount = params["amount"]

        # Agent step (deterministic stand-in for an activity that calls an LLM +
        # tools — the point here is the *recording*, not the model).
        score = 800 - amount // 100
        recommendation = "APPROVE" if score >= 650 else "REJECT"
        await self.record_case_event(
            pid,
            "agent",
            "Risk assessment",
            payload={
                "recommendation": recommendation,
                "score": score,
                "tools_used": ["credit_check", "fraud_screen"],
            },
            phase="ASSESSMENT",
        )
        # Load-bearing value the human step needs → the case entity (not the
        # timeline). The human task reads it back via context_from.
        await workflow.execute_activity(
            "patch_flowstile_case_entity",
            args=[pid, [{"op": "add", "path": "/riskScore", "value": score}]],
            start_to_close_timeout=timedelta(minutes=1),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

        result = await self.create_task_and_wait(
            task_definition_code=params["task_code"],
            process_instance_id=pid,
            context_from=["riskScore"],
            persist={"DECISION": "decision"},
        )
        await self.record_case_event(
            pid, "system", "Decision recorded", payload={"decision": result.data["DECISION"]}
        )
        return {"recommendation": recommendation, "score": score, "decision": result.data["DECISION"]}


class LoanReview(BaseModel):
    """A developer-authored form-output model — no codegen. Passed as `output`."""

    DECISION: Literal["APPROVE", "REJECT"]
    NOTES: str = ""


@workflow.defn
class DescriptorWorkflow(FlowstileWorkflowBase):
    """Drives a FlowstileTask descriptor (code + model + persist bound together)
    through create_task_and_wait — the generated-binding path."""

    @workflow.run
    async def run(self, params: dict) -> dict:
        # In real use this descriptor is generated; here we build it from the
        # per-test task code so the test is self-contained.
        review = FlowstileTask(params["task_code"], output=LoanReview, persist={"DECISION": "decision"})
        result = await self.create_task_and_wait(
            review, process_instance_id=params["process_instance_id"]
        )
        return {"decision": result.data.DECISION, "notes": result.data.NOTES}


@workflow.defn
class TypedOutputWorkflow(FlowstileWorkflowBase):
    @workflow.run
    async def run(self, params: dict) -> dict:
        result = await self.create_task_and_wait(
            output=LoanReview,
            task_definition_code=params["task_code"],
            process_instance_id=params["process_instance_id"],
        )
        # Typed attribute access — result.data.DECISION, not result.data["DECISION"].
        return {"decision": result.data.DECISION, "notes": result.data.NOTES}


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
