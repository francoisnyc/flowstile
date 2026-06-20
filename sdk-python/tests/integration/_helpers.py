"""Shared helpers for the live-stack integration tests (not collected by pytest)."""

from __future__ import annotations

import asyncio
import os
import re
import time
from typing import Any, Optional

import httpx

BASE = os.getenv("FLOWSTILE_BASE_URL", "http://localhost:3000")
TEMPORAL = os.getenv("TEMPORAL_ADDRESS", "localhost:7233")
API_KEY = os.getenv("FLOWSTILE_API_KEY", "fsk_dev_local_worker_DO_NOT_USE_IN_PROD")
TASK_QUEUE = "flowstile-python-e2e"


async def login(http: httpx.AsyncClient, email: str = "alice@example.com", password: str = "password") -> str:
    resp = await http.post(f"{BASE}/auth/login", json={"email": email, "password": password})
    resp.raise_for_status()
    match = re.search(r"flowstile_token=([^;]+)", resp.headers.get("set-cookie", ""))
    assert match, "no token in Set-Cookie"
    return match.group(1)


async def provision(http: httpx.AsyncClient, token: str, suffix: str) -> str:
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
        json={"name": f"Python E2E {suffix}", "milestones": [{"code": "REVIEW", "name": "Review"}]},
        headers=headers,
    )
    resp.raise_for_status()
    process_id = resp.json()["id"]

    task_code = f"PY_E2E_TASK_{suffix}"
    resp = await http.post(
        f"{BASE}/processes/{process_id}/tasks",
        json={"code": task_code, "formDefinitionCode": form_code, "milestoneCode": "REVIEW", "defaultPriority": "high"},
        headers=headers,
    )
    resp.raise_for_status()
    return task_code


async def find_task(http: httpx.AsyncClient, token: str, pid: str, code: str) -> Optional[dict[str, Any]]:
    """Return the task dict (any status) for the given code on a case, or None."""
    resp = await http.get(
        f"{BASE}/cases/by-process-instance/{pid}", headers={"Authorization": f"Bearer {token}"}
    )
    if resp.status_code != 200:
        return None
    for task in resp.json().get("tasks", []):
        if (task.get("taskDefinition") or {}).get("code") == code:
            return task
    return None


async def wait_for_open_task(http: httpx.AsyncClient, token: str, pid: str, code: str, timeout: float = 20) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        task = await find_task(http, token, pid, code)
        if task and task["status"] in ("created", "claimed"):
            return task["id"]
        await asyncio.sleep(0.5)
    raise AssertionError(f"open task {code} not found on {pid}")


async def wait_for_task_status(
    http: httpx.AsyncClient, token: str, pid: str, code: str, status: str, timeout: float = 15
) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        task = await find_task(http, token, pid, code)
        if task and task["status"] == status:
            return True
        await asyncio.sleep(0.5)
    return False


async def claim_and_complete(http: httpx.AsyncClient, token: str, task_id: str, data: dict[str, Any]) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    (await http.post(f"{BASE}/tasks/{task_id}/claim", headers=headers)).raise_for_status()
    (await http.post(f"{BASE}/tasks/{task_id}/complete", json={"data": data}, headers=headers)).raise_for_status()


async def cancel_task(http: httpx.AsyncClient, token: str, task_id: str) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    (await http.post(f"{BASE}/tasks/{task_id}/cancel", headers=headers)).raise_for_status()
