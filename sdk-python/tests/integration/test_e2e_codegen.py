"""End-to-end codegen: generate pydantic models from a live process's form
schemas, import them, and validate a submission. Self-skips unless FLOWSTILE_E2E=1.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any

import pytest
from _helpers import API_KEY, BASE

from flowstile import FlowstileClient
from flowstile.codegen import class_name_for, collect_process, render

pytestmark = pytest.mark.skipif(
    not os.getenv("FLOWSTILE_E2E"),
    reason="requires a live Flowstile server (set FLOWSTILE_E2E=1)",
)


def _dummy(schema: dict[str, Any]) -> dict[str, Any]:
    """A minimal submission satisfying a form schema's required fields."""
    props = schema.get("properties", {})
    out: dict[str, Any] = {}
    for key in schema.get("required", []):
        prop = props.get(key, {})
        if "enum" in prop:
            out[key] = prop["enum"][0]
        elif prop.get("type") in ("number", "integer"):
            out[key] = 0
        elif prop.get("type") == "boolean":
            out[key] = False
        elif prop.get("type") == "array":
            out[key] = []
        else:
            out[key] = "x"
    return out


async def test_codegen_against_live_process(tmp_path: Path) -> None:
    client = FlowstileClient(BASE, api_key=API_KEY)
    try:
        tasks, form_models = await collect_process(client, "Loan Origination")
    finally:
        await client.aclose()

    assert form_models, "expected at least one form for Loan Origination"
    assert tasks, "expected at least one task for Loan Origination"

    out = tmp_path / "loan_models.py"
    out.write_text(render(tasks, form_models, regenerate_cmd="flowstile-codegen --process 'Loan Origination'"))

    # The generated module imports cleanly and exposes one model per form and a
    # FlowstileTask descriptor per task.
    spec = importlib.util.spec_from_file_location("loan_models_test", out)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["loan_models_test"] = mod
    try:
        spec.loader.exec_module(mod)
        schema_by_class = dict(form_models)
        for class_name, schema in form_models:
            model = getattr(mod, class_name)
            assert model.model_validate(_dummy(schema)) is not None
        # Each task code is a descriptor bound to its form's model.
        for task_code, class_name in tasks:
            descriptor = getattr(mod, task_code)
            assert descriptor.code == task_code
            assert descriptor.output is getattr(mod, class_name)
            assert class_name in schema_by_class
    finally:
        sys.modules.pop("loan_models_test", None)

    assert any(class_name_for("LOAN_APPLICATION_REVIEW") == n for n, _ in form_models)
