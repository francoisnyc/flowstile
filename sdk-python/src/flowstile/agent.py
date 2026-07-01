"""Bring-your-own agent handler + runner for chat tasks.

An **agent handler** produces the next reply and an updated draft for a chat task.
The **runner** polls the Flowstile server for chat tasks that have an unanswered
human message and dispatches to the registered handler. This is *your* code,
running in *your* infrastructure (like the Temporal worker) — Flowstile never
calls an LLM itself.

The handler body is where you'd call your model. The handlers you register can be
deterministic (scripted) so tests stay hermetic, or a thin wrapper around an LLM
in production. The handler never completes the task — a human does that.

This module imports the HTTP client, so (like ``FlowstileClient``) it must not be
imported into a Temporal workflow sandbox — import it in worker/agent processes.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .client import FlowstileClient


@dataclass
class AgentTurn:
    """What the handler sees: the transcript, the current draft, and the latest
    human message it should respond to."""

    task_id: str
    goal: str
    messages: list[dict[str, Any]]  # full transcript, oldest first
    draft: dict[str, Any]  # current submissionData
    last_human_message: Optional[str]  # content of the latest human message


@dataclass
class AgentReply:
    """What the handler returns: the next agent message and fields to merge into
    the draft submission."""

    content: str
    draft: Optional[dict[str, Any]] = None


Handler = Callable[[AgentTurn], AgentReply]

_REGISTRY: dict[str, Handler] = {}


def agent_handler(name: str) -> Callable[[Handler], Handler]:
    """Register a handler under an agent name (matches ``Chat.agent``)."""

    def deco(fn: Handler) -> Handler:
        _REGISTRY[name] = fn
        return fn

    return deco


def registered_agents() -> dict[str, Handler]:
    return dict(_REGISTRY)


async def process_task_once(client: FlowstileClient, task: dict[str, Any], handler: Handler) -> bool:
    """If the task's last message is an unanswered human turn, produce exactly one
    agent reply (patching the draft first, then posting the message). Returns
    ``True`` if it replied. Idempotent per human turn: once it replies the last
    message is the agent's, so a re-sweep is a no-op."""
    task_id = task["id"]
    messages = await client.list_messages(task_id)
    if not messages or messages[-1].get("role") != "human":
        return False
    turn = AgentTurn(
        task_id=task_id,
        goal=(task.get("chat") or {}).get("goal", ""),
        messages=messages,
        draft=dict(task.get("submissionData") or {}),
        last_human_message=messages[-1]["content"],
    )
    reply = handler(turn)
    if reply.draft:
        await client.patch_submission(task_id, reply.draft)
    await client.post_message(task_id, reply.content)
    return True


async def run_agents(
    client: FlowstileClient,
    *,
    poll_interval: float = 1.0,
    once: bool = False,
) -> None:
    """Poll for chat tasks needing a reply and dispatch to registered handlers.

    Runs forever unless ``once=True`` (a single sweep — useful for tests). Uses a
    service credential, so it sees every task."""
    while True:
        result = await client.request("GET", "/tasks")
        for task in (result or {}).get("items", []):
            chat = task.get("chat")
            if not chat or task.get("status") in ("completed", "cancelled"):
                continue
            handler = _REGISTRY.get(chat.get("agent"))
            if handler is not None:
                await process_task_once(client, task, handler)
        if once:
            return
        await asyncio.sleep(poll_interval)
