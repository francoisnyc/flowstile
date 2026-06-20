"""Unit tests for the pure context_from / persist mapping helpers."""

from __future__ import annotations

from flowstile.mapping import build_persist_patch, normalize_mapping, project_context


def test_normalize_list_form_maps_same_name() -> None:
    assert normalize_mapping(["A", "B"]) == [("A", "A"), ("B", "B")]


def test_normalize_dict_form_renames() -> None:
    assert normalize_mapping({"A": "x", "B": "y"}) == [("A", "x"), ("B", "y")]


def test_project_context_none_entity_is_empty() -> None:
    assert project_context(None, ["A"]) == {}


def test_project_context_renames_present_keys() -> None:
    assert project_context({"a": 1, "b": 2}, {"a": "x"}) == {"x": 1}


def test_project_context_skips_missing_keys() -> None:
    assert project_context({"b": 2}, ["a"]) == {}


def test_build_persist_patch_add_op_with_rename() -> None:
    assert build_persist_patch({"DECISION": "approved"}, {"DECISION": "decision"}) == [
        {"op": "add", "path": "/decision", "value": "approved"}
    ]


def test_build_persist_patch_list_form_same_name() -> None:
    assert build_persist_patch({"A": 1}, ["A"]) == [{"op": "add", "path": "/A", "value": 1}]


def test_build_persist_patch_skips_missing_submission_keys() -> None:
    assert build_persist_patch({}, ["A"]) == []


def test_build_persist_patch_escapes_json_pointer() -> None:
    assert build_persist_patch({"x": 1}, {"x": "a/b~c"}) == [
        {"op": "add", "path": "/a~1b~0c", "value": 1}
    ]
