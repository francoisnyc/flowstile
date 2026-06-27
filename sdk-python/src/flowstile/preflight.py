"""Worker-boot preflight: validate task codes resolve to published forms.

A typo'd task code or an unpublished form otherwise fails *mid-workflow* — a 422
on task creation, ten minutes in. This catches it at worker startup instead. Pass
``preflight=`` to ``create_flowstile_worker``, or call ``check_tasks`` directly.

Existence only — model/form *drift* is caught by ``flowstile-codegen --check``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from .client import FlowstileClient
from .errors import FlowstileApiError


@dataclass
class PreflightFinding:
    code: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


async def check_tasks(client: FlowstileClient, task_codes: list[str]) -> list[PreflightFinding]:
    """Check each task code resolves to a task definition with a published form.

    Returns a finding per problem (unknown code, or its form has no published
    version). An empty list means everything resolves.
    """
    procs = await client.request("GET", "/processes?limit=200")
    code_to_form: dict[str, str] = {}
    for proc in procs["items"]:
        task_defs = await client.request("GET", f"/processes/{proc['id']}/tasks")
        for task in task_defs["items"]:
            form_code = task.get("formDefinitionCode")
            if form_code:
                code_to_form[task["code"]] = form_code

    known = list(code_to_form)
    findings: list[PreflightFinding] = []
    for code in task_codes:
        if code not in code_to_form:
            hint = _closest(code, known)
            suffix = f" (did you mean {hint!r}?)" if hint else ""
            findings.append(PreflightFinding(code, f"unknown task code{suffix}"))
            continue
        form_code = code_to_form[code]
        try:
            await client.request("GET", f"/forms/{form_code}")
        except FlowstileApiError as err:
            if err.status_code == 404:
                findings.append(
                    PreflightFinding(code, f"form {form_code!r} has no published version")
                )
            else:
                raise
    return findings


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _closest(target: str, candidates: list[str]) -> Optional[str]:
    """The nearest candidate by edit distance, if reasonably close."""
    best: Optional[str] = None
    best_distance: Optional[int] = None
    for candidate in candidates:
        distance = _levenshtein(target, candidate)
        if best_distance is None or distance < best_distance:
            best, best_distance = candidate, distance
    threshold = max(2, len(target) // 3)
    if best is not None and best_distance is not None and best_distance <= threshold:
        return best
    return None
