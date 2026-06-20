"""Flowstile Python SDK.

Client-side surface is exported here. The Temporal-facing pieces live in
submodules so importing the client never pulls in the workflow sandbox:

    from flowstile import FlowstileClient
    from flowstile.workflows import FlowstileWorkflowBase   # workflow code
    from flowstile.worker import create_flowstile_worker    # worker bootstrap
    from flowstile import activities                        # activity defns
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .errors import FlowstileApiError, TaskCancelledError, TaskTimeoutError
from .mapping import build_persist_patch, normalize_mapping, project_context
from .types import (
    CaseEntityResult,
    CompletedBy,
    Task,
    TaskCompletedSignalPayload,
    TaskResult,
    VariableMapping,
    task_cancelled_signal_name,
    task_completed_signal_name,
)

__version__ = "0.0.1"

if TYPE_CHECKING:
    from .client import FlowstileClient


def __getattr__(name: str) -> Any:
    # Lazy-import the httpx-backed client so that importing workflow-safe
    # submodules (flowstile.workflows, .types, .mapping) — which run this
    # package __init__ first — never drags httpx into the Temporal sandbox.
    if name == "FlowstileClient":
        from .client import FlowstileClient

        return FlowstileClient
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "FlowstileClient",
    "FlowstileApiError",
    "TaskCancelledError",
    "TaskTimeoutError",
    "build_persist_patch",
    "normalize_mapping",
    "project_context",
    "CaseEntityResult",
    "CompletedBy",
    "Task",
    "TaskCompletedSignalPayload",
    "TaskResult",
    "VariableMapping",
    "task_cancelled_signal_name",
    "task_completed_signal_name",
]
