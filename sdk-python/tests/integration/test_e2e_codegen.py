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
from flowstile.codegen import class_name_for, collect_forms, render_models

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
        forms = await collect_forms(client, "Loan Origination")
    finally:
        await client.aclose()

    assert forms, "expected at least one form for Loan Origination"

    out = tmp_path / "loan_models.py"
    out.write_text(render_models(forms, regenerate_cmd="flowstile-codegen --process 'Loan Origination'"))

    # The generated module imports cleanly and exposes one model per form.
    spec = importlib.util.spec_from_file_location("loan_models_test", out)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["loan_models_test"] = mod
    try:
        spec.loader.exec_module(mod)
        for class_name, schema in forms:
            model = getattr(mod, class_name)
            # Runtime validation works against a real schema.
            instance = model.model_validate(_dummy(schema))
            assert instance is not None
    finally:
        sys.modules.pop("loan_models_test", None)

    # The codegen-derived names match the convention the workflow author uses.
    assert any(class_name_for("LOAN_APPLICATION_REVIEW") == n for n, _ in forms)
