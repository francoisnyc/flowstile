"""The Flowstile Python developer story, end to end.

A complete, runnable Temporal worker that drives a human-approval step. Run it
against a Flowstile server that has a LOAN_REVIEW task definition + published
form, with Temporal reachable:

    FLOWSTILE_API_KEY=fsk_... python examples/loan_approval_worker.py

The shape it demonstrates:
  1. Describe the form output as a plain pydantic model — no code generation.
  2. Subclass FlowstileWorkflowBase and call self.create_task_and_wait(...).
  3. Read result.data.DECISION as a TYPED attribute (not a dict key).
  4. Boot the worker with create_flowstile_worker, which registers the built-in
     Flowstile activities for you.
"""

from __future__ import annotations

import asyncio
import os
from typing import Literal

from pydantic import BaseModel
from temporalio import workflow

from flowstile.worker import create_flowstile_worker
from flowstile.workflows import FlowstileWorkflowBase

TASK_QUEUE = "loans"


# 1 — The form's submission shape, authored by hand. Idiomatic, self-documenting,
#     and it gives you typed + validated results with no build step.
class LoanReview(BaseModel):
    DECISION: Literal["APPROVE", "REJECT"]
    NOTES: str = ""


@workflow.defn
class LoanApprovalWorkflow(FlowstileWorkflowBase):
    @workflow.run
    async def run(self, application: dict) -> dict:
        # 2/3 — create the human task and durably wait. Passing `output=LoanReview`
        # makes result.data a validated LoanReview instance.
        result = await self.create_task_and_wait(
            output=LoanReview,
            task_definition_code="LOAN_REVIEW",
            process_instance_id=application["processInstanceId"],
            input_data={"AMOUNT": application["data"]["AMOUNT"]},
            context_data={"CUSTOMER_NAME": application["data"]["CUSTOMER_NAME"]},
            persist={"DECISION": "decision"},  # promote the decision to the case entity
            timeout_ms=24 * 60 * 60 * 1000,    # cancel + raise TaskTimeoutError after a day
        )
        decision = result.data.DECISION  # ← typed: "APPROVE" | "REJECT"
        return {
            "approved": decision == "APPROVE",
            "notes": result.data.NOTES,
            "reviewed_by": result.completed_by.email,
        }


async def main() -> None:
    # 4 — bootstrap the worker (registers the Flowstile activities alongside yours).
    worker = await create_flowstile_worker(
        task_queue=TASK_QUEUE,
        workflows=[LoanApprovalWorkflow],
        flowstile={
            "base_url": os.environ.get("FLOWSTILE_SERVER_URL", "http://localhost:3000"),
            "api_key": os.environ["FLOWSTILE_API_KEY"],
        },
        temporal_address=os.environ.get("TEMPORAL_ADDRESS", "localhost:7233"),
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
