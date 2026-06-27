"""Unit tests for the boot preflight (task codes → published forms)."""

from __future__ import annotations

import httpx
import respx

from flowstile import FlowstileClient
from flowstile.preflight import _closest, _levenshtein, check_tasks

BASE = "http://srv"
PROCESSES = {"items": [{"id": "p1", "name": "P"}]}
TASKS = {"items": [
    {"code": "TASK_A", "formDefinitionCode": "FORM_A"},
    {"code": "TASK_B", "formDefinitionCode": "FORM_B"},
]}


def _mock_topology(form_b_status: int = 200) -> None:
    respx.get(f"{BASE}/processes?limit=200").mock(return_value=httpx.Response(200, json=PROCESSES))
    respx.get(f"{BASE}/processes/p1/tasks").mock(return_value=httpx.Response(200, json=TASKS))
    respx.get(f"{BASE}/forms/FORM_A").mock(return_value=httpx.Response(200, json={"code": "FORM_A"}))
    respx.get(f"{BASE}/forms/FORM_B").mock(
        return_value=httpx.Response(form_b_status, json={"code": "FORM_B"} if form_b_status == 200 else {})
    )


@respx.mock
async def test_all_codes_resolve() -> None:
    _mock_topology()
    async with FlowstileClient(BASE, api_key="k") as client:
        findings = await check_tasks(client, ["TASK_A", "TASK_B"])
    assert findings == []


@respx.mock
async def test_unknown_code_with_did_you_mean() -> None:
    _mock_topology()
    async with FlowstileClient(BASE, api_key="k") as client:
        findings = await check_tasks(client, ["TASK_C"])
    assert len(findings) == 1
    assert findings[0].code == "TASK_C"
    assert "unknown task code" in findings[0].message
    assert "did you mean" in findings[0].message  # TASK_A/TASK_B are 1 edit away


@respx.mock
async def test_unpublished_form_flagged() -> None:
    _mock_topology(form_b_status=404)
    async with FlowstileClient(BASE, api_key="k") as client:
        findings = await check_tasks(client, ["TASK_B"])
    assert len(findings) == 1
    assert "no published version" in findings[0].message


def test_levenshtein_and_closest() -> None:
    assert _levenshtein("abc", "abc") == 0
    assert _levenshtein("abc", "abd") == 1
    assert _closest("TASK_A", ["TASK_B", "OTHER"]) == "TASK_B"
    assert _closest("WILDLY_DIFFERENT_CODE", ["X", "Y"]) is None
