"""Temporal activities the SDK injects into your worker.

These wrap Flowstile REST calls so a *workflow* can create/cancel tasks and
read/patch the case entity (workflow code itself must stay deterministic and
do no I/O). Register them on your Temporal worker — ``create_flowstile_worker``
does this for you — and call ``configure_flowstile_activities`` once at startup.

Activities exchange plain JSON dicts across the Temporal boundary (not pydantic
models), so no custom data converter is required.

One deliberate divergence from the TypeScript SDK: ``get_flowstile_case_entity``
swallows a 404 and returns ``{"entity": None, "entityVersion": 0}``. The first
task of a case has no entity yet, and detecting that 404 by type *across* the
activity boundary is awkward in Python — so it is handled here, on the
non-deterministic side, where it is trivial.
"""

from __future__ import annotations

from typing import Any, Optional

from temporalio import activity

from .client import FlowstileClient
from .errors import FlowstileApiError

_client: Optional[FlowstileClient] = None


def configure_flowstile_activities(
    *,
    base_url: str,
    api_key: Optional[str] = None,
    auth: Optional[dict[str, str]] = None,
) -> None:
    """Configure the shared client used by the Flowstile activities.

    Call once before starting your Temporal worker (``create_flowstile_worker``
    calls this for you).
    """
    global _client
    _client = FlowstileClient(base_url, api_key=api_key, auth=auth)


def _require_client() -> FlowstileClient:
    if _client is None:
        raise RuntimeError(
            "Flowstile activities are not configured. Call "
            "configure_flowstile_activities(...) before starting your worker."
        )
    return _client


@activity.defn
async def create_flowstile_task(body: dict[str, Any]) -> dict[str, Any]:
    task = await _require_client().create_task(body)
    return task.model_dump(by_alias=True)


@activity.defn
async def cancel_flowstile_task(task_id: str) -> dict[str, Any]:
    task = await _require_client().cancel_task(task_id)
    return task.model_dump(by_alias=True)


@activity.defn
async def get_flowstile_case_entity(process_instance_id: str) -> dict[str, Any]:
    try:
        result = await _require_client().get_case_entity(process_instance_id)
    except FlowstileApiError as err:
        if err.status_code == 404:
            return {"entity": None, "entityVersion": 0}
        raise
    return result.model_dump(by_alias=True)


@activity.defn
async def patch_flowstile_case_entity(
    process_instance_id: str,
    patch: list[dict[str, Any]],
    expected_version: Optional[int] = None,
) -> dict[str, Any]:
    result = await _require_client().patch_case_entity(
        process_instance_id, patch, expected_version
    )
    return result.model_dump(by_alias=True)


@activity.defn
async def set_flowstile_case_entity(
    process_instance_id: str,
    entity: dict[str, Any],
    expected_version: Optional[int] = None,
) -> dict[str, Any]:
    result = await _require_client().set_case_entity(
        process_instance_id, entity, expected_version
    )
    return result.model_dump(by_alias=True)


# All Flowstile-provided activities, for registration on a Temporal worker.
FLOWSTILE_ACTIVITIES = [
    create_flowstile_task,
    cancel_flowstile_task,
    get_flowstile_case_entity,
    patch_flowstile_case_entity,
    set_flowstile_case_entity,
]
