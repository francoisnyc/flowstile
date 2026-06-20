"""Declarative ``context_from`` / ``persist`` variable mappings.

Pure functions — no Temporal, no I/O. A faithful port of the TypeScript SDK's
``mapping.ts``. Plumbing only: copy and rename; never transform.
"""

from __future__ import annotations

from typing import Any

from .types import JsonPatchOperation, VariableMapping


def normalize_mapping(mapping: VariableMapping) -> list[tuple[str, str]]:
    """Normalize either form to ``[(source_key, dest_key), ...]``."""
    if isinstance(mapping, dict):
        return list(mapping.items())
    return [(key, key) for key in mapping]


def project_context(
    entity: dict[str, Any] | None,
    context_from: VariableMapping,
) -> dict[str, Any]:
    """``context_from`` — project case-entity variables into a contextData subset.

    A null/absent entity or a missing source key is skipped (so the first task of
    a case, before the entity exists, projects nothing rather than failing).
    """
    out: dict[str, Any] = {}
    if not entity:
        return out
    for src, dest in normalize_mapping(context_from):
        if src in entity:
            out[dest] = entity[src]
    return out


def build_persist_patch(
    submission: dict[str, Any],
    persist: VariableMapping,
) -> list[JsonPatchOperation]:
    """``persist`` — build a JSON Patch promoting an allowlist of submission fields.

    Missing submission keys are skipped. Uses disjoint-field ``add`` ops, so no
    ``expected_version`` is needed.
    """
    ops: list[JsonPatchOperation] = []
    for src, dest in normalize_mapping(persist):
        if src in submission:
            ops.append({"op": "add", "path": "/" + _escape_pointer(dest), "value": submission[src]})
    return ops


def _escape_pointer(key: str) -> str:
    """RFC 6901 JSON Pointer escaping for a destination key path segment."""
    return key.replace("~", "~0").replace("/", "~1")
