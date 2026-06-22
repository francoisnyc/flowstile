"""End-to-end validation of context_from (input mapping) against a live stack.

Task 1 persists DECISION onto the case entity; task 2 declares
context_from=["decision"], so the server should deliver that value in task 2's
contextData. Exercises project_context + the get_flowstile_case_entity activity
through real Temporal. Self-skips unless FLOWSTILE_E2E=1.
"""

from __future__ import annotations

import os
import uuid

import httpx
import pytest
from _helpers import (
    API_KEY,
    BASE,
    TASK_QUEUE,
    TEMPORAL,
    claim_and_complete,
    get_task_detail,
    login,
    provision,
    wait_for_open_task,
)
from approval_workflow import ContextFromWorkflow
from temporalio.client import Client

from flowstile.worker import create_flowstile_worker

pytestmark = pytest.mark.skipif(
    not os.getenv("FLOWSTILE_E2E"),
    reason="requires a live Flowstile server + Temporal (set FLOWSTILE_E2E=1)",
)


async def test_context_from_projects_entity_into_next_task() -> None:
    suffix = uuid.uuid4().hex[:8]
    pid = f"py-ctxfrom-{suffix}"
    async with httpx.AsyncClient(timeout=20) as http:
        token = await login(http)
        task_code = await provision(http, token, suffix)

        client = await Client.connect(TEMPORAL, namespace="default")
        worker = await create_flowstile_worker(
            task_queue=TASK_QUEUE,
            workflows=[ContextFromWorkflow],
            flowstile={"base_url": BASE, "api_key": API_KEY},
            client=client,
        )
        async with worker:
            handle = await client.start_workflow(
                ContextFromWorkflow.run,
                {"task_code": task_code, "process_instance_id": pid},
                id=pid,
                task_queue=TASK_QUEUE,
            )

            # Task 1 → persist DECISION=APPROVE onto the case entity.
            first_id = await wait_for_open_task(http, token, pid, task_code)
            await claim_and_complete(http, token, first_id, {"DECISION": "APPROVE", "NOTES": "first"})

            # Task 2 (a new instance) should carry decision=APPROVE in contextData,
            # projected from the entity by context_from.
            second_id = await wait_for_open_task(http, token, pid, task_code, exclude={first_id})
            detail = await get_task_detail(http, token, second_id)
            assert detail["contextData"].get("decision") == "APPROVE"

            await claim_and_complete(http, token, second_id, {"DECISION": "REJECT", "NOTES": "second"})
            result = await handle.result()

        assert result == {"first": "APPROVE", "second": "REJECT"}
