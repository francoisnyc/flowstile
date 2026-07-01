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
    Chat,
    CompletedBy,
    FlowstileTask,
    Task,
    TaskCompletedSignalPayload,
    TaskResult,
    VariableMapping,
    task_cancelled_signal_name,
    task_completed_signal_name,
)
# Sandbox-safe (no httpx): the workflow base and Chat config, exported at the top
# level for the ergonomic `from flowstile import FlowstileWorkflowBase, Chat`.
from .workflows import FlowstileWorkflowBase

__version__ = "0.0.1"

if TYPE_CHECKING:
    from .agent import AgentReply, AgentTurn, agent_handler, registered_agents, run_agents
    from .client import FlowstileClient


def __getattr__(name: str) -> Any:
    # Lazy-import anything that pulls the httpx-backed client (FlowstileClient and
    # the agent runner) so importing workflow-safe submodules — which run this
    # package __init__ first — never drags httpx into the Temporal sandbox.
    if name == "FlowstileClient":
        from .client import FlowstileClient

        return FlowstileClient
    if name in ("agent_handler", "AgentTurn", "AgentReply", "run_agents", "registered_agents"):
        from . import agent

        return getattr(agent, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "FlowstileClient",
    "FlowstileWorkflowBase",
    "FlowstileApiError",
    "TaskCancelledError",
    "TaskTimeoutError",
    "build_persist_patch",
    "normalize_mapping",
    "project_context",
    "CaseEntityResult",
    "Chat",
    "CompletedBy",
    "FlowstileTask",
    "Task",
    "TaskCompletedSignalPayload",
    "TaskResult",
    "VariableMapping",
    "task_cancelled_signal_name",
    "task_completed_signal_name",
    "agent_handler",
    "AgentTurn",
    "AgentReply",
    "run_agents",
    "registered_agents",
]
