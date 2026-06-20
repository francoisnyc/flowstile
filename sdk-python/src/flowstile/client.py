"""Async REST client for the Flowstile server (mirror of ``client.ts``).

Auth is either a service API key (``Authorization: Bearer <key>``, preferred for
workers) or a human email/password login that yields a JWT cookie. A 401 under
password auth triggers one re-login + retry; API-key 401s surface directly.
"""

from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import quote

import httpx

from .errors import FlowstileApiError
from .types import CaseEntityResult, JsonPatchOperation, Task

_TOKEN_RE = re.compile(r"flowstile_token=([^;]+)")


class FlowstileClient:
    def __init__(
        self,
        base_url: str,
        *,
        api_key: Optional[str] = None,
        auth: Optional[dict[str, str]] = None,
        http: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._auth = auth  # {"email": ..., "password": ...}
        self._jwt: Optional[str] = None
        self._http = http or httpx.AsyncClient()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "FlowstileClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    def _auth_header(self) -> Optional[str]:
        if self._api_key:
            return f"Bearer {self._api_key}"
        if self._jwt:
            return f"Bearer {self._jwt}"
        return None

    async def _ensure_auth(self) -> None:
        # API-key auth needs no login round-trip; password auth logs in once.
        if self._api_key or self._jwt or not self._auth:
            return
        resp = await self._http.post(f"{self._base_url}/auth/login", json=self._auth)
        if resp.status_code >= 400:
            raise FlowstileApiError(resp.status_code, "/auth/login", resp.text)
        match = _TOKEN_RE.search(resp.headers.get("set-cookie", ""))
        if not match:
            raise RuntimeError("Flowstile auth: no token in Set-Cookie header")
        self._jwt = match.group(1)

    async def request(self, method: str, path: str, json: Any = None) -> Any:
        """Authenticated request returning parsed JSON (or None for empty bodies)."""
        await self._ensure_auth()

        async def do() -> httpx.Response:
            headers: dict[str, str] = {}
            auth_header = self._auth_header()
            if auth_header:
                headers["Authorization"] = auth_header
            # httpx omits Content-Type when json is None, matching the server's
            # rejection of an empty body carrying application/json.
            return await self._http.request(
                method, f"{self._base_url}{path}", json=json, headers=headers
            )

        resp = await do()
        if resp.status_code == 401 and self._auth and not self._api_key:
            self._jwt = None
            await self._ensure_auth()
            resp = await do()

        if resp.status_code >= 400:
            raise FlowstileApiError(resp.status_code, path, resp.text)
        if not resp.content:
            return None
        return resp.json()

    # ── Tasks ────────────────────────────────────────────────────────────────

    async def create_task(self, body: dict[str, Any]) -> Task:
        return Task.model_validate(await self.request("POST", "/tasks", json=body))

    async def get_task(self, task_id: str) -> Task:
        return Task.model_validate(await self.request("GET", f"/tasks/{task_id}"))

    async def cancel_task(self, task_id: str) -> Task:
        return Task.model_validate(await self.request("POST", f"/tasks/{task_id}/cancel"))

    # ── Case entity ──────────────────────────────────────────────────────────

    def _entity_path(self, process_instance_id: str) -> str:
        return f"/cases/by-process-instance/{quote(process_instance_id, safe='')}/entity"

    async def get_case_entity(self, process_instance_id: str) -> CaseEntityResult:
        return CaseEntityResult.model_validate(
            await self.request("GET", self._entity_path(process_instance_id))
        )

    async def patch_case_entity(
        self,
        process_instance_id: str,
        patch: list[JsonPatchOperation],
        expected_version: Optional[int] = None,
    ) -> CaseEntityResult:
        return CaseEntityResult.model_validate(
            await self.request(
                "PATCH",
                self._entity_path(process_instance_id),
                json={"patch": patch, "expectedVersion": expected_version},
            )
        )

    async def set_case_entity(
        self,
        process_instance_id: str,
        entity: dict[str, Any],
        expected_version: Optional[int] = None,
    ) -> CaseEntityResult:
        return CaseEntityResult.model_validate(
            await self.request(
                "PUT",
                self._entity_path(process_instance_id),
                json={"entity": entity, "expectedVersion": expected_version},
            )
        )

    # ── Cases ────────────────────────────────────────────────────────────────

    async def get_case(self, case_id: str) -> dict[str, Any]:
        return await self.request("GET", f"/cases/{case_id}")

    async def get_case_by_process_instance(self, process_instance_id: str) -> dict[str, Any]:
        return await self.request(
            "GET", f"/cases/by-process-instance/{quote(process_instance_id, safe='')}"
        )
