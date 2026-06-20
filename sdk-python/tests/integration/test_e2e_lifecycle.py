"""Lifecycle paths of create_task_and_wait against a live stack: timeout, the
server-sent task-cancelled signal, and workflow cancellation (best-effort task
cleanup). Self-skips unless FLOWSTILE_E2E=1.
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
    cancel_task,
    login,
    provision,
    wait_for_open_task,
    wait_for_task_status,
)
from approval_workflow import LifecycleWorkflow
from temporalio.client import Client

from flowstile.worker import create_flowstile_worker

pytestmark = pytest.mark.skipif(
    not os.getenv("FLOWSTILE_E2E"),
    reason="requires a live Flowstile server + Temporal (set FLOWSTILE_E2E=1)",
)


async def _worker(client: Client):
    return await create_flowstile_worker(
        task_queue=TASK_QUEUE,
        workflows=[LifecycleWorkflow],
        flowstile={"base_url": BASE, "api_key": API_KEY},
        client=client,
    )


async def test_timeout_raises_and_cancels_task() -> None:
    """timeout_ms elapses with no completion → TaskTimeoutError + task cancelled."""
    suffix = uuid.uuid4().hex[:8]
    pid = f"py-timeout-{suffix}"
    async with httpx.AsyncClient(timeout=20) as http:
        token = await login(http)
        task_code = await provision(http, token, suffix)
        client = await Client.connect(TEMPORAL, namespace="default")
        async with await _worker(client):
            handle = await client.start_workflow(
                LifecycleWorkflow.run,
                {"task_code": task_code, "process_instance_id": pid, "timeout_ms": 2000},
                id=pid,
                task_queue=TASK_QUEUE,
            )
            # Never complete the task; let the 2s timeout fire.
            result = await handle.result()

        assert result["outcome"] == "timed_out"
        # The helper cancelled the task on timeout (best effort).
        assert await wait_for_task_status(http, token, pid, task_code, "cancelled")


async def test_task_cancelled_signal_raises() -> None:
    """Cancelling the task via REST signals the workflow → TaskCancelledError."""
    suffix = uuid.uuid4().hex[:8]
    pid = f"py-taskcancel-{suffix}"
    async with httpx.AsyncClient(timeout=20) as http:
        token = await login(http)
        task_code = await provision(http, token, suffix)
        client = await Client.connect(TEMPORAL, namespace="default")
        async with await _worker(client):
            handle = await client.start_workflow(
                LifecycleWorkflow.run,
                {"task_code": task_code, "process_instance_id": pid},
                id=pid,
                task_queue=TASK_QUEUE,
            )
            task_id = await wait_for_open_task(http, token, pid, task_code)
            await cancel_task(http, token, task_id)
            result = await handle.result()

        assert result["outcome"] == "cancelled"


async def test_workflow_cancellation_cleans_up_task() -> None:
    """Cancelling the workflow best-effort cancels the open task on the server."""
    suffix = uuid.uuid4().hex[:8]
    pid = f"py-wfcancel-{suffix}"
    async with httpx.AsyncClient(timeout=20) as http:
        token = await login(http)
        task_code = await provision(http, token, suffix)
        client = await Client.connect(TEMPORAL, namespace="default")
        async with await _worker(client):
            handle = await client.start_workflow(
                LifecycleWorkflow.run,
                {"task_code": task_code, "process_instance_id": pid},
                id=pid,
                task_queue=TASK_QUEUE,
            )
            await wait_for_open_task(http, token, pid, task_code)
            await handle.cancel()
            with pytest.raises(Exception):
                await handle.result()

            # The best-effort cleanup should have cancelled the task on the server.
            assert await wait_for_task_status(http, token, pid, task_code, "cancelled")
