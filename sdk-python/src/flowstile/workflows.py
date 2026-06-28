"""``create_task_and_wait`` for Temporal *workflow* code.

Why a base class (the one real divergence from the TypeScript SDK): Python's
Temporal SDK registers signal handlers on the workflow *class*, and Flowstile
completion signals are dynamically named (``flowstile:task:completed:<taskId>``).
The TypeScript SDK can register a handler imperatively inside a free function;
Python cannot. So the Python equivalent is a base class that owns a single
*dynamic* signal handler and exposes ``create_task_and_wait`` as a method.
Inherit from it:

    from temporalio import workflow
    from flowstile.workflows import FlowstileWorkflowBase

    @workflow.defn
    class ApprovalWorkflow(FlowstileWorkflowBase):
        @workflow.run
        async def run(self, payload: dict) -> dict:
            result = await self.create_task_and_wait(
                task_definition_code="REVIEW_LOAN",
                process_instance_id=payload["processInstanceId"],
                input_data={"AMOUNT": payload["data"]["AMOUNT"]},
                persist={"DECISION": "decision"},
            )
            return {"decision": result.data["DECISION"]}

Activities are referenced by their registered names so this module never imports
the (non-deterministic) activity implementations into the workflow sandbox. The
worker must register ``flowstile.activities.FLOWSTILE_ACTIVITIES``.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any, Optional, Sequence, TypeVar, overload

from pydantic import BaseModel
from temporalio import workflow
from temporalio.common import RawValue, RetryPolicy

from .errors import TaskCancelledError, TaskTimeoutError
from .mapping import build_persist_patch, project_context
from .types import CompletedBy, FlowstileTask, TaskResult, VariableMapping

# An optional pydantic model the caller passes to type the task's submission data.
TModel = TypeVar("TModel", bound=BaseModel)

_COMPLETED_PREFIX = "flowstile:task:completed:"
_CANCELLED_PREFIX = "flowstile:task:cancelled:"

# Activity names (defaults of the @activity.defn functions in activities.py).
_CREATE_TASK = "create_flowstile_task"
_CANCEL_TASK = "cancel_flowstile_task"
_GET_ENTITY = "get_flowstile_case_entity"
_PATCH_ENTITY = "patch_flowstile_case_entity"
_RECORD_EVENT = "record_flowstile_case_event"

_ACTIVITY_TIMEOUT = timedelta(minutes=10)
_ACTIVITY_RETRY = RetryPolicy(maximum_attempts=3)


class FlowstileWorkflowBase:
    """Mixin/base for workflows that create and await Flowstile human tasks."""

    def __init__(self) -> None:
        self._ft_completed: dict[str, dict[str, Any]] = {}
        self._ft_cancelled: set[str] = set()

    @workflow.signal(dynamic=True)
    async def _flowstile_dynamic_signal(self, name: str, args: Sequence[RawValue]) -> None:
        if name.startswith(_COMPLETED_PREFIX):
            task_id = name[len(_COMPLETED_PREFIX) :]
            payload: dict[str, Any] = (
                workflow.payload_converter().from_payload(args[0].payload, dict) if args else {}
            )
            self._ft_completed[task_id] = payload
        elif name.startswith(_CANCELLED_PREFIX):
            self._ft_cancelled.add(name[len(_CANCELLED_PREFIX) :])
        # Non-Flowstile signals are ignored by this handler.

    # Overloads so `result.data` is typed: from the descriptor's model when a
    # FlowstileTask is passed positionally, from `output=` otherwise, else a
    # plain dict. (Python can't express this in one signature the way
    # TypeScript's generic can, hence the duplication.)
    @overload
    async def create_task_and_wait(
        self,
        task: FlowstileTask[TModel],
        /,
        *,
        input_data: Optional[dict[str, Any]] = ...,
        context_data: Optional[dict[str, Any]] = ...,
        process_instance_id: Optional[str] = ...,
        priority: Optional[str] = ...,
        due_date: Optional[str] = ...,
        follow_up_date: Optional[str] = ...,
        candidate_users: Optional[list[str]] = ...,
        candidate_groups: Optional[list[str]] = ...,
        timeout_ms: Optional[int] = ...,
        context_from: Optional[VariableMapping] = ...,
        persist: Optional[VariableMapping] = ...,
    ) -> TaskResult[TModel]: ...

    @overload
    async def create_task_and_wait(
        self,
        *,
        output: type[TModel],
        task_definition_id: Optional[str] = ...,
        task_definition_code: Optional[str] = ...,
        process_instance_id: Optional[str] = ...,
        input_data: Optional[dict[str, Any]] = ...,
        context_data: Optional[dict[str, Any]] = ...,
        priority: Optional[str] = ...,
        due_date: Optional[str] = ...,
        follow_up_date: Optional[str] = ...,
        candidate_users: Optional[list[str]] = ...,
        candidate_groups: Optional[list[str]] = ...,
        timeout_ms: Optional[int] = ...,
        context_from: Optional[VariableMapping] = ...,
        persist: Optional[VariableMapping] = ...,
    ) -> TaskResult[TModel]: ...

    @overload
    async def create_task_and_wait(
        self,
        *,
        output: None = ...,
        task_definition_id: Optional[str] = ...,
        task_definition_code: Optional[str] = ...,
        process_instance_id: Optional[str] = ...,
        input_data: Optional[dict[str, Any]] = ...,
        context_data: Optional[dict[str, Any]] = ...,
        priority: Optional[str] = ...,
        due_date: Optional[str] = ...,
        follow_up_date: Optional[str] = ...,
        candidate_users: Optional[list[str]] = ...,
        candidate_groups: Optional[list[str]] = ...,
        timeout_ms: Optional[int] = ...,
        context_from: Optional[VariableMapping] = ...,
        persist: Optional[VariableMapping] = ...,
    ) -> TaskResult[dict[str, Any]]: ...

    async def create_task_and_wait(
        self,
        task: Optional[FlowstileTask[Any]] = None,
        *,
        output: Optional[type[BaseModel]] = None,
        task_definition_id: Optional[str] = None,
        task_definition_code: Optional[str] = None,
        process_instance_id: Optional[str] = None,
        input_data: Optional[dict[str, Any]] = None,
        context_data: Optional[dict[str, Any]] = None,
        priority: Optional[str] = None,
        due_date: Optional[str] = None,
        follow_up_date: Optional[str] = None,
        candidate_users: Optional[list[str]] = None,
        candidate_groups: Optional[list[str]] = None,
        timeout_ms: Optional[int] = None,
        context_from: Optional[VariableMapping] = None,
        persist: Optional[VariableMapping] = None,
    ) -> TaskResult[Any]:
        """Create a Flowstile task and durably wait for a human to complete it.

        Pass a ``FlowstileTask`` descriptor (usually generated) so the code and
        model can't mismatch, or ``output=MyModel`` for an ad-hoc typed result,
        or neither for a plain-dict ``result.data``.
        """
        # A descriptor supplies the code, model, and default mappings; explicit
        # keyword arguments still win.
        if task is not None:
            task_definition_code = task_definition_code or task.code
            output = output or task.output
            persist = persist if persist is not None else task.persist
            context_from = context_from if context_from is not None else task.context_from
            priority = priority if priority is not None else task.priority

        # context_from (input mapping): project case-entity variables into
        # contextData before creating the task. Explicit context_data wins per
        # key. The activity returns entity=None for a case with no entity yet.
        merged_context = dict(context_data) if context_data else None
        if context_from and process_instance_id:
            entity_result = await workflow.execute_activity(
                _GET_ENTITY,
                process_instance_id,
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_ACTIVITY_RETRY,
            )
            projected = project_context(entity_result.get("entity"), context_from)
            merged_context = {**projected, **(context_data or {})}

        body = _create_body(
            task_definition_id=task_definition_id,
            task_definition_code=task_definition_code,
            process_instance_id=process_instance_id,
            input_data=input_data,
            context_data=merged_context,
            priority=priority,
            due_date=due_date,
            follow_up_date=follow_up_date,
            candidate_users=candidate_users,
            candidate_groups=candidate_groups,
            workflow_id=workflow.info().workflow_id,
        )
        created = await workflow.execute_activity(
            _CREATE_TASK,
            body,
            start_to_close_timeout=_ACTIVITY_TIMEOUT,
            retry_policy=_ACTIVITY_RETRY,
        )
        task_id: str = created["id"]

        def _resolved() -> bool:
            return task_id in self._ft_completed or task_id in self._ft_cancelled

        timeout = timedelta(milliseconds=timeout_ms) if timeout_ms is not None else None
        try:
            await workflow.wait_condition(_resolved, timeout=timeout)
        except asyncio.TimeoutError:
            await self._best_effort_cancel(task_id)
            raise TaskTimeoutError(task_id, timeout_ms or 0) from None
        except asyncio.CancelledError:
            # Workflow itself was cancelled — best-effort cleanup so the task does
            # not rot in the inbox. NOTE: cleanup-after-cancel semantics differ
            # from the TS nonCancellable scope and should be validated against a
            # Temporal test environment before relying on them in production.
            await self._best_effort_cancel(task_id)
            raise

        if task_id in self._ft_cancelled:
            raise TaskCancelledError(task_id)

        payload = self._ft_completed[task_id]

        # persist (output mapping): promote allowlisted submission fields to the
        # case entity after a successful completion (never on timeout/cancel).
        if persist and process_instance_id:
            patch = build_persist_patch(payload.get("data", {}), persist)
            if patch:
                await workflow.execute_activity(
                    _PATCH_ENTITY,
                    args=[process_instance_id, patch],
                    start_to_close_timeout=_ACTIVITY_TIMEOUT,
                    retry_policy=_ACTIVITY_RETRY,
                )

        raw_data: dict[str, Any] = payload.get("data", {})
        data: Any = output.model_validate(raw_data) if output is not None else raw_data
        return TaskResult(
            task_id=task_id,
            data=data,
            completed_by=CompletedBy.model_validate(payload["completedBy"]),
            completed_at=payload["completedAt"],
            form_version=payload["formVersion"],
        )

    async def record_case_event(
        self,
        process_instance_id: str,
        actor: str,
        label: str,
        *,
        payload: Optional[dict[str, Any]] = None,
        phase: Optional[str] = None,
    ) -> None:
        """Append a display-only event to the case timeline (``actor`` =
        ``"human"`` | ``"system"`` | ``"agent"``).

        Display-only: never read back to drive workflow logic — values the
        workflow needs go in the case entity (``persist`` / patch). Use this to
        surface automated/agent work a human reviewing the case should see.
        """
        await workflow.execute_activity(
            _RECORD_EVENT,
            args=[process_instance_id, actor, label, payload, phase],
            start_to_close_timeout=_ACTIVITY_TIMEOUT,
            retry_policy=_ACTIVITY_RETRY,
        )

    async def _best_effort_cancel(self, task_id: str) -> None:
        try:
            await workflow.execute_activity(
                _CANCEL_TASK,
                task_id,
                start_to_close_timeout=_ACTIVITY_TIMEOUT,
                retry_policy=_ACTIVITY_RETRY,
            )
        except Exception:
            # The task may already be claimed/completed — cancellation is best effort.
            pass


def _create_body(
    *,
    task_definition_id: Optional[str],
    task_definition_code: Optional[str],
    process_instance_id: Optional[str],
    input_data: Optional[dict[str, Any]],
    context_data: Optional[dict[str, Any]],
    priority: Optional[str],
    due_date: Optional[str],
    follow_up_date: Optional[str],
    candidate_users: Optional[list[str]],
    candidate_groups: Optional[list[str]],
    workflow_id: str,
) -> dict[str, Any]:
    """Build the POST /tasks body, omitting unset fields (camelCase wire keys)."""
    body: dict[str, Any] = {"workflowId": workflow_id}
    optional = {
        "taskDefinitionId": task_definition_id,
        "taskDefinitionCode": task_definition_code,
        "processInstanceId": process_instance_id,
        "inputData": input_data,
        "contextData": context_data,
        "priority": priority,
        "dueDate": due_date,
        "followUpDate": follow_up_date,
        "candidateUsers": candidate_users,
        "candidateGroups": candidate_groups,
    }
    for key, value in optional.items():
        if value is not None:
            body[key] = value
    return body
