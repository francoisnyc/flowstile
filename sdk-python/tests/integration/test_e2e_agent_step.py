"""End-to-end 'agent as a step': a workflow records agent/system events to the
case timeline while a human reviews. Asserts the events appear on the case, the
agent's curated payload, and the two-tier split (load-bearing value in the case
entity, story in the event log). Self-skips unless FLOWSTILE_E2E=1.
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
from approval_workflow import AgentStepWorkflow
from temporalio.client import Client

from flowstile.worker import create_flowstile_worker

pytestmark = pytest.mark.skipif(
    not os.getenv("FLOWSTILE_E2E"),
    reason="requires a live Flowstile server + Temporal (set FLOWSTILE_E2E=1)",
)


async def test_agent_step_records_timeline() -> None:
    suffix = uuid.uuid4().hex[:8]
    pid = f"py-agent-{suffix}"
    async with httpx.AsyncClient(timeout=20) as http:
        token = await login(http)
        task_code = await provision(http, token, suffix)

        client = await Client.connect(TEMPORAL, namespace="default")
        worker = await create_flowstile_worker(
            task_queue=TASK_QUEUE,
            workflows=[AgentStepWorkflow],
            flowstile={"base_url": BASE, "api_key": API_KEY},
            client=client,
        )
        async with worker:
            handle = await client.start_workflow(
                AgentStepWorkflow.run,
                {"task_code": task_code, "process_instance_id": pid, "amount": 5000},
                id=pid,
                task_queue=TASK_QUEUE,
            )
            task_id = await wait_for_open_task(http, token, pid, task_code)
            await claim_and_complete(http, token, task_id, {"DECISION": "APPROVE", "NOTES": "ok"})
            result = await handle.result()

        assert result == {"recommendation": "APPROVE", "score": 750, "decision": "APPROVE"}

        # The case timeline carries the agent + system events, attributed and curated.
        case = (
            await http.get(
                f"{BASE}/cases/by-process-instance/{pid}",
                headers={"Authorization": f"Bearer {token}"},
            )
        ).json()
        events = case["events"]
        assert [(e["actor"], e["label"]) for e in events] == [
            ("agent", "Risk assessment"),
            ("system", "Decision recorded"),
        ]
        assert events[0]["payload"]["recommendation"] == "APPROVE"
        assert events[0]["payload"]["score"] == 750
        assert events[0]["phase"] == "ASSESSMENT"

        # Two-tier split: load-bearing value lives in the case entity, not the log.
        entity = (
            await http.get(
                f"{BASE}/cases/by-process-instance/{pid}/entity",
                headers={"Authorization": f"Bearer {token}"},
            )
        ).json()["entity"]
        assert entity["riskScore"] == 750
        assert entity["decision"] == "APPROVE"
