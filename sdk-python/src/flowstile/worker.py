"""Temporal worker bootstrap for Flowstile.

Configures the Flowstile activity client, connects to Temporal, and builds a
``temporalio.worker.Worker`` with the Flowstile-provided activities already
registered alongside your own. Optionally runs a boot preflight that validates
your task codes resolve to published forms.

    from temporalio import workflow
    from flowstile.worker import create_flowstile_worker
    from myapp.workflows import ApprovalWorkflow
    from myapp.activities import score_application
    from myapp.loan_models import LOAN_REVIEW_APPLICATION   # generated descriptor

    worker = await create_flowstile_worker(
        task_queue="flowstile",
        workflows=[ApprovalWorkflow],
        activities=[score_application],
        flowstile={"base_url": "http://localhost:3000", "api_key": API_KEY},
        temporal_address="localhost:7233",
        preflight=[LOAN_REVIEW_APPLICATION],   # codes or FlowstileTask descriptors
    )
    await worker.run()
"""

from __future__ import annotations

import os
from typing import Any, Optional, Sequence, Union

from temporalio.client import Client
from temporalio.worker import Worker

from .activities import FLOWSTILE_ACTIVITIES, configure_flowstile_activities
from .client import FlowstileClient
from .preflight import check_tasks
from .types import FlowstileTask


async def create_flowstile_worker(
    *,
    task_queue: str,
    workflows: Sequence[type],
    flowstile: dict[str, Any],
    activities: Optional[Sequence[Any]] = None,
    temporal_address: str = "localhost:7233",
    temporal_namespace: str = "default",
    client: Optional[Client] = None,
    preflight: Optional[Sequence[Union[str, FlowstileTask[Any]]]] = None,
    **worker_kwargs: Any,
) -> Worker:
    """Build a Temporal worker with Flowstile activities registered.

    ``flowstile`` is a dict with ``base_url`` and either ``api_key`` (preferred
    for workers) or ``auth={"email", "password"}``. Pass an existing ``client``
    to reuse a connection; otherwise one is created from ``temporal_address``.

    ``preflight`` is a list of task codes (or ``FlowstileTask`` descriptors) to
    validate against the server before starting — each must resolve to a task
    definition with a published form. Findings are printed; with
    ``FLOWSTILE_DOCTOR=warn`` they don't block startup, ``=off`` skips the check
    entirely (default is strict: a finding raises).
    """
    configure_flowstile_activities(
        base_url=flowstile["base_url"],
        api_key=flowstile.get("api_key"),
        auth=flowstile.get("auth"),
    )

    if preflight:
        await _run_preflight(flowstile, preflight)

    if client is None:
        client = await Client.connect(temporal_address, namespace=temporal_namespace)

    all_activities = [*FLOWSTILE_ACTIVITIES, *(activities or [])]
    return Worker(
        client,
        task_queue=task_queue,
        workflows=list(workflows),
        activities=all_activities,
        **worker_kwargs,
    )


async def _run_preflight(
    flowstile: dict[str, Any], preflight: Sequence[Union[str, FlowstileTask[Any]]]
) -> None:
    mode = os.environ.get("FLOWSTILE_DOCTOR", "strict")
    if mode == "off":
        return
    codes = [t.code if isinstance(t, FlowstileTask) else t for t in preflight]
    pf_client = FlowstileClient(
        flowstile["base_url"], api_key=flowstile.get("api_key"), auth=flowstile.get("auth")
    )
    try:
        findings = await check_tasks(pf_client, codes)
    finally:
        await pf_client.aclose()

    if not findings:
        print(f"  ✓ preflight: {len(codes)} task code(s) resolve to published forms")
        return
    for finding in findings:
        print(f"  ✗ preflight: {finding}")
    if mode != "warn":
        raise RuntimeError(
            "Flowstile preflight failed — fix the findings above, or set "
            "FLOWSTILE_DOCTOR=warn to start anyway (=off to skip)."
        )
