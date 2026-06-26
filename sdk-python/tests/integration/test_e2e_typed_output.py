"""End-to-end check of the typed-output DX: create_task_and_wait(output=Model)
returns a validated pydantic instance, so result.data.DECISION is typed — no
code generation. Self-skips unless FLOWSTILE_E2E=1.
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
from approval_workflow import TypedOutputWorkflow
from temporalio.client import Client

from flowstile.worker import create_flowstile_worker

pytestmark = pytest.mark.skipif(
    not os.getenv("FLOWSTILE_E2E"),
    reason="requires a live Flowstile server + Temporal (set FLOWSTILE_E2E=1)",
)


async def test_typed_output_model() -> None:
    suffix = uuid.uuid4().hex[:8]
    pid = f"py-typed-{suffix}"
    async with httpx.AsyncClient(timeout=20) as http:
        token = await login(http)
        task_code = await provision(http, token, suffix)

        client = await Client.connect(TEMPORAL, namespace="default")
        worker = await create_flowstile_worker(
            task_queue=TASK_QUEUE,
            workflows=[TypedOutputWorkflow],
            flowstile={"base_url": BASE, "api_key": API_KEY},
            client=client,
        )
        async with worker:
            handle = await client.start_workflow(
                TypedOutputWorkflow.run,
                {"task_code": task_code, "process_instance_id": pid},
                id=pid,
                task_queue=TASK_QUEUE,
            )
            task_id = await wait_for_open_task(http, token, pid, task_code)
            await claim_and_complete(http, token, task_id, {"DECISION": "APPROVE", "NOTES": "typed"})
            result = await handle.result()

        assert result == {"decision": "APPROVE", "notes": "typed"}
