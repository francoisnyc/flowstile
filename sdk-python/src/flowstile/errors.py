"""Typed errors for the Flowstile Python SDK (mirror of the TypeScript SDK)."""

from __future__ import annotations


class TaskTimeoutError(Exception):
    """Raised when a task is not completed within its ``timeout_ms``."""

    def __init__(self, task_id: str, timeout_ms: int) -> None:
        self.task_id = task_id
        self.timeout_ms = timeout_ms
        super().__init__(f"Task {task_id} was not completed within {timeout_ms}ms")


class TaskCancelledError(Exception):
    """Raised when a task is cancelled (the server sent the cancelled signal)."""

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        super().__init__(f"Task {task_id} was cancelled")


class FlowstileApiError(Exception):
    """Raised when a Flowstile REST call returns a non-2xx response."""

    def __init__(self, status_code: int, path: str, message: str) -> None:
        self.status_code = status_code
        self.path = path
        super().__init__(f"Flowstile API error {status_code} on {path}: {message}")
