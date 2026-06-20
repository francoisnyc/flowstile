"""Unit tests for FlowstileClient auth, retry, and parsing (httpx mocked)."""

from __future__ import annotations

import httpx
import pytest
import respx

from flowstile import FlowstileApiError, FlowstileClient

BASE = "http://srv"
TASK_JSON = {
    "id": "t1",
    "taskDefinitionId": "td1",
    "status": "created",
    "workflowId": "w1",
    "processInstanceId": "pi1",
}


@respx.mock
async def test_create_task_sends_api_key_and_parses() -> None:
    route = respx.post(f"{BASE}/tasks").mock(return_value=httpx.Response(200, json=TASK_JSON))
    async with FlowstileClient(BASE, api_key="secret") as client:
        task = await client.create_task({"workflowId": "w1", "taskDefinitionCode": "X"})

    assert task.id == "t1"
    assert task.workflow_id == "w1"
    assert route.calls.last.request.headers["authorization"] == "Bearer secret"


@respx.mock
async def test_api_error_includes_status_code() -> None:
    respx.post(f"{BASE}/tasks").mock(return_value=httpx.Response(422, text="bad data"))
    async with FlowstileClient(BASE, api_key="k") as client:
        with pytest.raises(FlowstileApiError) as exc:
            await client.create_task({"workflowId": "w1"})
    assert exc.value.status_code == 422
    assert exc.value.path == "/tasks"


@respx.mock
async def test_case_entity_alias_parsing() -> None:
    respx.get(f"{BASE}/cases/by-process-instance/pi1/entity").mock(
        return_value=httpx.Response(200, json={"entity": {"k": "v"}, "entityVersion": 3})
    )
    async with FlowstileClient(BASE, api_key="k") as client:
        result = await client.get_case_entity("pi1")
    assert result.entity == {"k": "v"}
    assert result.entity_version == 3


@respx.mock
async def test_password_auth_logs_in_then_retries_on_401() -> None:
    login = respx.post(f"{BASE}/auth/login").mock(
        return_value=httpx.Response(
            204, headers={"set-cookie": "flowstile_token=jwt123; Path=/; HttpOnly"}
        )
    )
    # First call 401 (expired), second succeeds after re-login.
    respx.get(f"{BASE}/tasks/t1").mock(
        side_effect=[httpx.Response(401, text="expired"), httpx.Response(200, json=TASK_JSON)]
    )
    async with FlowstileClient(BASE, auth={"email": "a@b.c", "password": "pw"}) as client:
        task = await client.get_task("t1")

    assert task.id == "t1"
    # Logged in twice: once up front, once after the 401.
    assert login.call_count == 2
