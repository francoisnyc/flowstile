"""End-to-end happy path for create_task_and_wait against a live stack.

Self-skips unless FLOWSTILE_E2E=1. Requires a running Flowstile server (with
TEMPORAL_ADDRESS configured) and a Temporal server. Provisions its own form,
process, and task via REST (as admin), runs a real Python Temporal worker hosting
a FlowstileWorkflowBase workflow, drives the human side over REST, and asserts the
typed result, completedBy, and the persisted case entity.

Doubles as the worked Python example: the SDK *produces and awaits*; the human
side (claim/complete) is plain REST, exactly as the web UI does it.
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
    login,
    provision,
    wait_for_open_task,
)
from approval_workflow import E2EApprovalWorkflow
from temporalio.client import Client

from flowstile.worker import create_flowstile_worker

pytestmark = pytest.mark.skipif(
    not os.getenv("FLOWSTILE_E2E"),
    reason="requires a live Flowstile server + Temporal (set FLOWSTILE_E2E=1)",
)


async def test_create_task_and_wait_end_to_end() -> None:
    suffix = uuid.uuid4().hex[:8]
    pid = f"py-e2e-{suffix}"

    async with httpx.AsyncClient(timeout=15) as http:
        token = await login(http)
        task_code = await provision(http, token, suffix)

        client = await Client.connect(TEMPORAL, namespace="default")
        worker = await create_flowstile_worker(
            task_queue=TASK_QUEUE,
            workflows=[E2EApprovalWorkflow],
            flowstile={"base_url": BASE, "api_key": API_KEY},
            client=client,
        )
        async with worker:
            handle = await client.start_workflow(
                E2EApprovalWorkflow.run,
                {"task_code": task_code, "process_instance_id": pid, "input_data": {"AMOUNT": 50000}},
                id=pid,
                task_queue=TASK_QUEUE,
            )
            task_id = await wait_for_open_task(http, token, pid, task_code)
            await claim_and_complete(http, token, task_id, {"DECISION": "APPROVE", "NOTES": "lgtm"})
            result = await handle.result()

        assert result["decision"] == "APPROVE"
        assert result["completed_by"] == "alice@example.com"

        entity = (
            await http.get(
                f"{BASE}/cases/by-process-instance/{pid}/entity",
                headers={"Authorization": f"Bearer {token}"},
            )
        ).json()["entity"]
        assert entity.get("decision") == "APPROVE"
