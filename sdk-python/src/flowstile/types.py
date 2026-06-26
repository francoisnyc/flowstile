"""Shared types for the Flowstile Python SDK.

Response models use pydantic with camelCase aliases so callers work in idiomatic
snake_case while the wire format matches the server. The free-form ``data`` /
``entity`` / ``input_data`` dictionaries are opaque passthroughs — their keys are
user form fields and are never transformed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Generic, Literal, Optional, TypeVar, Union

from pydantic import BaseModel, ConfigDict, Field

# The form-output payload type of a completed task: a plain dict, or a pydantic
# model when create_task_and_wait is given an ``output`` model.
TData = TypeVar("TData")

Priority = Literal["low", "normal", "high", "urgent"]
TaskStatus = Literal["created", "claimed", "completed", "cancelled"]
CaseStatus = Literal["pending", "in_progress", "completed", "cancelled"]

# A declarative variable mapping between a task and the case entity. List form
# maps each key to the same name; dict form renames (source -> destination).
# Plumbing only — no expressions or transforms.
VariableMapping = Union[list[str], dict[str, str]]

# An RFC 6902 JSON Patch operation used to mutate a case entity.
JsonPatchOperation = dict[str, Any]


class _Model(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")


class CompletedBy(_Model):
    id: str
    email: str
    display_name: str = Field(alias="displayName")


class Task(_Model):
    # Lenient on purpose: the only field the workflow helper relies on is ``id``.
    # The server's task response shape varies by endpoint, so everything else is
    # optional and unknown fields are ignored (extra="ignore").
    id: str
    status: Optional[TaskStatus] = None
    task_definition_id: Optional[str] = Field(default=None, alias="taskDefinitionId")
    workflow_id: Optional[str] = Field(default=None, alias="workflowId")
    process_instance_id: Optional[str] = Field(default=None, alias="processInstanceId")
    priority: Optional[Priority] = None
    input_data: dict[str, Any] = Field(default_factory=dict, alias="inputData")
    context_data: dict[str, Any] = Field(default_factory=dict, alias="contextData")
    submission_data: dict[str, Any] = Field(default_factory=dict, alias="submissionData")
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    completed_at: Optional[str] = Field(default=None, alias="completedAt")


class CaseEntityResult(_Model):
    entity: Optional[dict[str, Any]] = None
    entity_version: int = Field(alias="entityVersion")


class TaskCompletedSignalPayload(_Model):
    """Payload the server sends on ``flowstile:task:completed:<taskId>``."""

    data: dict[str, Any] = Field(default_factory=dict)
    completed_by: CompletedBy = Field(alias="completedBy")
    completed_at: str = Field(alias="completedAt")
    form_version: int = Field(alias="formVersion")


@dataclass
class TaskResult(Generic[TData]):
    """The result of a completed human task.

    ``data`` is a plain dict by default, or — when ``create_task_and_wait`` is
    given an ``output`` model — a validated instance of that pydantic model, so
    ``result.data.DECISION`` is typed without any code generation step.
    """

    task_id: str
    data: TData
    completed_by: CompletedBy
    completed_at: str
    form_version: int


def task_completed_signal_name(task_id: str) -> str:
    """Signal name convention: ``flowstile:task:completed:<taskId>``."""
    return f"flowstile:task:completed:{task_id}"


def task_cancelled_signal_name(task_id: str) -> str:
    """Signal name convention: ``flowstile:task:cancelled:<taskId>``."""
    return f"flowstile:task:cancelled:{task_id}"
