"""Unit tests for the chat agent runner (no network — a stub client)."""

from __future__ import annotations

from typing import Any

import pytest

from flowstile import AgentReply, AgentTurn, agent_handler
from flowstile.agent import process_task_once, registered_agents, run_agents


@agent_handler("test-intake")
def _intake(turn: AgentTurn) -> AgentReply:
    draft = dict(turn.draft)
    if "severity" not in draft:
        draft["severity"] = (turn.last_human_message or "").lower()
        return AgentReply("Which service?", draft=draft)
    draft["service"] = turn.last_human_message
    return AgentReply("Thanks — review and complete.", draft=draft)


class StubClient:
    """Duck-typed FlowstileClient: canned transcript + call recording."""

    def __init__(self, messages: list[dict[str, Any]], tasks: list[dict[str, Any]] | None = None):
        self._messages = list(messages)
        self._tasks = tasks or []
        self.posted: list[str] = []
        self.patched: list[dict[str, Any]] = []

    async def list_messages(self, task_id: str) -> list[dict[str, Any]]:
        return list(self._messages)

    async def post_message(self, task_id: str, content: str) -> dict[str, Any]:
        self.posted.append(content)
        self._messages.append({"role": "agent", "content": content})
        return {"id": "m", "role": "agent", "content": content}

    async def patch_submission(self, task_id: str, data: dict[str, Any]) -> Any:
        self.patched.append(data)
        return None

    async def request(self, method: str, path: str, json: Any = None) -> Any:
        return {"items": self._tasks}


def test_handler_is_registered():
    assert "test-intake" in registered_agents()


@pytest.mark.asyncio
async def test_replies_to_an_unanswered_human_message():
    client = StubClient([{"role": "agent", "content": "Hi, what's up?"},
                         {"role": "human", "content": "High"}])
    replied = await process_task_once(client, {"id": "t1", "chat": {"goal": "g"}, "submissionData": {}}, _intake)
    assert replied is True
    assert client.posted == ["Which service?"]
    assert client.patched == [{"severity": "high"}]


@pytest.mark.asyncio
async def test_does_not_reply_when_last_message_is_the_agent():
    client = StubClient([{"role": "human", "content": "High"},
                         {"role": "agent", "content": "Which service?"}])
    replied = await process_task_once(client, {"id": "t1", "chat": {"goal": "g"}, "submissionData": {}}, _intake)
    assert replied is False
    assert client.posted == []


@pytest.mark.asyncio
async def test_run_agents_once_dispatches_by_agent_name():
    task = {"id": "t1", "status": "claimed", "chat": {"agent": "test-intake", "goal": "g"},
            "submissionData": {}}
    client = StubClient(
        [{"role": "agent", "content": "Hi"}, {"role": "human", "content": "Low"}],
        tasks=[task],
    )
    await run_agents(client, once=True)
    assert client.posted == ["Which service?"]


@pytest.mark.asyncio
async def test_run_agents_skips_completed_and_unknown_agents():
    client = StubClient(
        [{"role": "human", "content": "x"}],
        tasks=[
            {"id": "done", "status": "completed", "chat": {"agent": "test-intake"}, "submissionData": {}},
            {"id": "other", "status": "claimed", "chat": {"agent": "nobody"}, "submissionData": {}},
        ],
    )
    await run_agents(client, once=True)
    assert client.posted == []
