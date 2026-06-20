"""End-to-end validation of create_task_and_wait against a live stack.

Self-skips unless FLOWSTILE_E2E=1. Requires a running Flowstile server (with
TEMPORAL_ADDRESS configured) and a Temporal server. Provisions its own form,
process, and task via REST (as admin), runs a real Python Temporal worker hosting
a FlowstileWorkflowBase workflow, drives the human side over REST, and asserts the
typed result, completedBy, and the persisted case entity.

This doubles as the worked Python example: the SDK *produces and awaits*; the
human side (claim/complete) is plain REST, exactly as the web UI does it.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
import uuid

import httpx
import pytest
from approval_workflow import E2EApprovalWorkflow
from temporalio.client import Client

from flowstile.worker import create_flowstile_worker

pytestmark = pytest.mark.skipif(
    not os.getenv("FLOWSTILE_E2E"),
    reason="requires a live Flowstile server + Temporal (set FLOWSTILE_E2E=1)",
)

BASE = os.getenv("FLOWSTILE_BASE_URL", "http://localhost:3000")
TEMPORAL = os.getenv("TEMPORAL_ADDRESS", "localhost:7233")
API_KEY = os.getenv("FLOWSTILE_API_KEY", "fsk_dev_local_worker_DO_NOT_USE_IN_PROD")
TASK_QUEUE = "flowstile-python-e2e"


async def _login(http: httpx.AsyncClient, email: str, password: str) -> str:
    resp = await http.post(f"{BASE}/auth/login", json={"email": email, "password": password})
    resp.raise_for_status()
    match = re.search(r"flowstile_token=([^;]+)", resp.headers.get("set-cookie", ""))
    assert match, "no token in Set-Cookie"
    return match.group(1)


async def _provision(http: httpx.AsyncClient, token: str, suffix: str) -> str:
    """Create + publish a form, a process, and a task def. Returns the task code."""
    headers = {"Authorization": f"Bearer {token}"}
    form_code = f"PY_E2E_FORM_{suffix}"
    form = {
        "code": form_code,
        "jsonSchema": {
            "type": "object",
            "properties": {
                "AMOUNT": {"type": "number"},
                "DECISION": {"type": "string", "enum": ["APPROVE", "REJECT"]},
                "NOTES": {"type": "string"},
            },
            "required": ["DECISION"],
        },
        "uiSchema": {
            "type": "VerticalLayout",
            "elements": [
                {"type": "Control", "scope": "#/properties/AMOUNT", "options": {"readonly": True}},
                {"type": "Control", "scope": "#/properties/DECISION"},
                {"type": "Control", "scope": "#/properties/NOTES", "options": {"multi": True}},
            ],
        },
    }
    (await http.post(f"{BASE}/forms", json=form, headers=headers)).raise_for_status()
    (await http.post(f"{BASE}/forms/{form_code}/publish", headers=headers)).raise_for_status()

    resp = await http.post(
        f"{BASE}/processes",
        json={"name": f"Python E2E Approval {suffix}", "milestones": [{"code": "REVIEW", "name": "Review"}]},
        headers=headers,
    )
    resp.raise_for_status()
    process_id = resp.json()["id"]

    task_code = f"PY_E2E_APPROVAL_{suffix}"
    resp = await http.post(
        f"{BASE}/processes/{process_id}/tasks",
        json={
            "code": task_code,
            "formDefinitionCode": form_code,
            "milestoneCode": "REVIEW",
            "defaultPriority": "high",
        },
        headers=headers,
    )
    resp.raise_for_status()
    return task_code


async def _wait_for_open_task(http: httpx.AsyncClient, token: str, pid: str, code: str) -> str:
    headers = {"Authorization": f"Bearer {token}"}
    deadline = time.time() + 20
    while time.time() < deadline:
        resp = await http.get(f"{BASE}/cases/by-process-instance/{pid}", headers=headers)
        if resp.status_code == 200:
            for task in resp.json().get("tasks", []):
                td = task.get("taskDefinition") or {}
                if td.get("code") == code and task["status"] == "created":
                    return task["id"]
        await asyncio.sleep(0.5)
    raise AssertionError(f"open task {code} not found on {pid}")


async def _claim_and_complete(http: httpx.AsyncClient, token: str, task_id: str, data: dict) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    (await http.post(f"{BASE}/tasks/{task_id}/claim", headers=headers)).raise_for_status()
    (await http.post(f"{BASE}/tasks/{task_id}/complete", json={"data": data}, headers=headers)).raise_for_status()


async def test_create_task_and_wait_end_to_end() -> None:
    suffix = uuid.uuid4().hex[:8]
    pid = f"py-e2e-{suffix}"

    async with httpx.AsyncClient(timeout=15) as http:
        token = await _login(http, "alice@example.com", "password")
        task_code = await _provision(http, token, suffix)

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
            task_id = await _wait_for_open_task(http, token, pid, task_code)
            await _claim_and_complete(http, token, task_id, {"DECISION": "APPROVE", "NOTES": "lgtm"})
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
