"""Temporal worker bootstrap for Flowstile.

Configures the Flowstile activity client, connects to Temporal, and builds a
``temporalio.worker.Worker`` with the Flowstile-provided activities already
registered alongside your own. The preflight doctor from the TypeScript SDK is
not yet ported (deferred); validate your task codes/forms against the server for
now.

    from temporalio import workflow
    from flowstile.worker import create_flowstile_worker
    from myapp.workflows import ApprovalWorkflow
    from myapp.activities import score_application

    worker = await create_flowstile_worker(
        task_queue="flowstile",
        workflows=[ApprovalWorkflow],
        activities=[score_application],
        flowstile={"base_url": "http://localhost:3000", "api_key": API_KEY},
        temporal_address="localhost:7233",
    )
    await worker.run()
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

from temporalio.client import Client
from temporalio.worker import Worker

from .activities import FLOWSTILE_ACTIVITIES, configure_flowstile_activities


async def create_flowstile_worker(
    *,
    task_queue: str,
    workflows: Sequence[type],
    flowstile: dict[str, Any],
    activities: Optional[Sequence[Any]] = None,
    temporal_address: str = "localhost:7233",
    temporal_namespace: str = "default",
    client: Optional[Client] = None,
    **worker_kwargs: Any,
) -> Worker:
    """Build a Temporal worker with Flowstile activities registered.

    ``flowstile`` is a dict with ``base_url`` and either ``api_key`` (preferred
    for workers) or ``auth={"email", "password"}``. Pass an existing ``client``
    to reuse a connection; otherwise one is created from ``temporal_address``.
    """
    configure_flowstile_activities(
        base_url=flowstile["base_url"],
        api_key=flowstile.get("api_key"),
        auth=flowstile.get("auth"),
    )

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
