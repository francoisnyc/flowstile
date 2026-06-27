"""End-to-end boot preflight against a live server. Self-skips unless FLOWSTILE_E2E=1."""

from __future__ import annotations

import os

import pytest
from _helpers import API_KEY, BASE

from flowstile import FlowstileClient
from flowstile.preflight import check_tasks

pytestmark = pytest.mark.skipif(
    not os.getenv("FLOWSTILE_E2E"),
    reason="requires a live Flowstile server (set FLOWSTILE_E2E=1)",
)


async def test_preflight_resolves_real_codes_and_flags_typos() -> None:
    client = FlowstileClient(BASE, api_key=API_KEY)
    try:
        good = await check_tasks(client, ["LOAN_ASSESS_RISK", "LOAN_SENIOR_REVIEW"])
        typo = await check_tasks(client, ["LOAN_ASSES_RISK"])  # dropped an S
    finally:
        await client.aclose()

    assert good == [], f"expected real seeded codes to resolve, got {good}"
    assert len(typo) == 1
    assert typo[0].code == "LOAN_ASSES_RISK"
    assert "did you mean 'LOAN_ASSESS_RISK'" in typo[0].message
