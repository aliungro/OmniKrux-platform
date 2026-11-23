"""The dashboard document: one validator, pinned by a case file the browser validator also runs."""

import copy
import json
from dataclasses import asdict
from pathlib import Path

import pytest

from omnikrux.monitoring.dashboards.schema import (
    DashboardInvalid,
    Problem,
    adapt_sources,
    empty_dashboard,
    panel_count,
    validate_dashboard,
    variables_used,
)

CASES_PATH = Path(__file__).parent / "dashboard_schema_cases.json"
CASES = json.loads(CASES_PATH.read_text("utf-8"))
OK_CASES = [c for c in CASES if not c["problems"]]

REQUIRED_CASES = {
    "minimal",
    "full_every_type",
    "defaults_filled",
    "wrong_schema_version",
    "unknown_top_field",
    "unknown_option_for_type",
    "duplicate_panel_id",
    "overlap",
    "off_grid",
    "logs_needs_one_loki_query",
    "too_many_queries",
    "undefined_variable",
    "builtin_variables_allowed",
    "variable_order",
    "all_without_include_all",
    "group_with_source_id",
    "alert_not_an_object",
    "alert_full",
    "alert_defaults",
    "alert_on_logs_panel",
    "alert_on_table_panel",
    "alert_unknown_query_ref",
    "alert_channel_without_tool",
    "alert_bad_fields",
    "alert_loki_log_query",
    "alert_uses_range",
    "bad_time",
    "time_backwards",
    "wrong_types_everywhere",
    "too_many_panels",
}


def _stat_panel(**over):
    panel = {
        "id": "p-1",
        "type": "stat",
        "title": "",
        "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
        "queries": [{"ref": "A", "source": {"type": "prometheus", "id": None}, "expr": "up"}],
    }
    panel.update(over)
    return panel


def _doc(*panels, **over):
    doc = {"schemaVersion": 1, "title": "A", "panels": list(panels)}
    doc.update(over)
    return doc


def test_case_file_is_strict_json_and_complete():
    # The browser reads this file with JSON.parse: no NaN/Infinity literals.
    json.loads(
        CASES_PATH.read_text("utf-8"),
        parse_constant=lambda c: pytest.fail(f"non-JSON literal {c}"),
    )
    names = [c["name"] for c in CASES]
    assert len(names) == len(set(names))
    assert REQUIRED_CASES <= set(names)
    for c in CASES:
        assert set(c) == {"name", "owner", "input", "normalized", "problems"}
        assert (c["normalized"] is None) == bool(c["problems"])


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_cases(case):
    if case["problems"]:
        with pytest.raises(DashboardInvalid) as e:
            validate_dashboard(case["input"], owner_kind=case["owner"])
        assert [asdict(p) for p in e.value.problems] == case["problems"]
    else:
        assert validate_dashboard(case["input"], owner_kind=case["owner"]) == case["normalized"]


@pytest.mark.parametrize("case", OK_CASES, ids=[c["name"] for c in OK_CASES])
def test_normalised_documents_keep_the_table_order_and_validate_to_themselves(case):
    first = validate_dashboard(case["input"], owner_kind=case["owner"])
    assert json.dumps(first) == json.dumps(case["normalized"])
    assert validate_dashboard(first, owner_kind=case["owner"]) == first


def test_defaults_fill_a_minimal_panel():
    doc = validate_dashboard(_doc(_stat_panel()), owner_kind="project")
    assert doc["panels"][0]["options"] == {
        "unit": "none",
        "decimals": None,
        "thresholds": [],
        "calc": "last",
        "sparkline": True,
    }
    assert doc["panels"][0]["alert"] is None and doc["time"] == {"from": "now-6h", "to": "now"}


def test_validation_does_not_change_its_input():
    thresholds = [{"value": 2, "color": "ok"}, {"value": 1, "color": "bad"}]
    raw = _doc(_stat_panel(options={"thresholds": thresholds}), title=" A ")
    before = copy.deepcopy(raw)
    validate_dashboard(raw, owner_kind="project")
    assert raw == before


def test_variables_used():
    assert variables_used(
        'rate(x{ns=~"$namespace",p=~"${pod}"}[$__rate_interval]) and y{a=~"^b$|c"}'
    ) == ["namespace", "pod", "__rate_interval"]


@pytest.mark.parametrize(
    "text, expected",
    [
        ("", []),
        ("$a $a ${a} $b", ["a", "b"]),
        ("cost $5 and $ and $-x and ${ and ${1x}", []),
        ("$_x ${_y} $a1", ["_x", "_y", "a1"]),
        ("$ab-cd", ["ab"]),
    ],
)
def test_variables_used_edges(text, expected):
    assert variables_used(text) == expected


def test_adapt_sources_nulls_what_the_owner_cannot_use():
    def source(i):
        return {"type": "prometheus", "id": i}

    doc = {
        "variables": [{"name": "a", "source": source("s1")}, {"name": "b", "source": source("s2")}],
        "panels": [
            {
                "queries": [
                    {"source": source("s1")},
                    {"source": source("s2")},
                    {"source": source(None)},
                ]
            }
        ],
    }
    before = copy.deepcopy(doc)

    mine = adapt_sources(doc, owner_kind="project", linked_source_ids=frozenset({"s1"}))
    assert [v["source"]["id"] for v in mine["variables"]] == ["s1", None]
    assert [q["source"]["id"] for q in mine["panels"][0]["queries"]] == ["s1", None, None]

    shared = adapt_sources(doc, owner_kind="group", linked_source_ids=frozenset({"s1"}))
    assert [v["source"]["id"] for v in shared["variables"]] == [None, None]
    assert [q["source"]["id"] for q in shared["panels"][0]["queries"]] == [None, None, None]
    assert doc == before and mine is not doc


def test_empty_dashboard_is_valid_and_normalised():
    doc = empty_dashboard("Overview")
    assert doc["panels"] == [] and doc["variables"] == []
    assert doc["time"] == {"from": "now-6h", "to": "now"} and doc["refresh"] is None
    assert validate_dashboard(doc, owner_kind="project") == doc
    assert validate_dashboard(doc, owner_kind="group") == doc
    assert panel_count(doc) == 0


def test_panel_count():
    second = _stat_panel(id="p-2", layout={"x": 6, "y": 0, "w": 6, "h": 4})
    doc = validate_dashboard(_doc(_stat_panel(), second), owner_kind="project")
    assert panel_count(doc) == 2


def test_dashboard_invalid_str_is_the_first_problem():
    with pytest.raises(DashboardInvalid) as e:
        validate_dashboard(
            {"schemaVersion": 1, "title": "", "description": 1}, owner_kind="project"
        )
    assert str(e.value) == "title: Use 1 to 120 characters, without line breaks."
    assert isinstance(e.value, ValueError)
    assert len(e.value.problems) == 2


def test_document_over_one_megabyte_is_refused():
    with pytest.raises(DashboardInvalid) as e:
        validate_dashboard(_doc(description="x" * 1_000_001), owner_kind="project")
    assert e.value.problems[0] == Problem("", "The dashboard is larger than 1 MB.")
    assert str(e.value) == ": The dashboard is larger than 1 MB."


def test_size_is_utf8_bytes_of_compact_json():
    # 1.2 MB of UTF-8 in 600k characters: refused. The default json.dumps would escape these
    # to \uXXXX (and add spaces), so only the compact UTF-8 measure agrees with the browser.
    with pytest.raises(DashboardInvalid) as e:
        validate_dashboard(_doc(description="é" * 600_000), owner_kind="project")
    assert e.value.problems == (Problem("", "The dashboard is larger than 1 MB."),)
    # Right under the limit in bytes but over it as escaped JSON: accepted by the size rule.
    just_under = "é" * 499_900  # ~1 MB of UTF-8 bytes would be 999_800 + the envelope
    with pytest.raises(DashboardInvalid) as e:
        validate_dashboard(_doc(description=just_under), owner_kind="project")
    # ... and refused for the real reason (the 2000-character description rule), not for size.
    assert e.value.problems == (Problem("description", "Use at most 2000 characters."),)


def test_size_is_checked_before_anything_else():
    with pytest.raises(DashboardInvalid) as e:
        validate_dashboard({"nonsense": "x" * 1_000_000}, owner_kind="project")
    assert e.value.problems == (Problem("", "The dashboard is larger than 1 MB."),)


def test_problems_stop_at_fifty():
    panels = [
        _stat_panel(id=f"BAD_{i}", layout={"x": 0, "y": i * 2, "w": 6, "h": 2}) for i in range(100)
    ]
    with pytest.raises(DashboardInvalid) as e:
        validate_dashboard(_doc(*panels), owner_kind="project")
    assert len(e.value.problems) == 50
    assert [p.path for p in e.value.problems[:2]] == ["panels[0].id", "panels[1].id"]


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_threshold_is_refused(bad):
    # Python-only: a NaN literal is not JSON, so it can't live in the shared case file.
    panel = _stat_panel(options={"thresholds": [{"value": bad, "color": "ok"}]})
    with pytest.raises(DashboardInvalid) as e:
        validate_dashboard(_doc(panel), owner_kind="project")
    assert e.value.problems == (
        Problem("panels[0].options.thresholds[0].value", "Expected a finite number."),
    )


def test_non_finite_numbers_elsewhere_are_refused():
    panel = _stat_panel(
        layout={"x": float("nan"), "y": 0, "w": 6, "h": 4}, options={"decimals": float("inf")}
    )
    with pytest.raises(DashboardInvalid) as e:
        validate_dashboard(_doc(panel), owner_kind="project")
    assert [(p.path, p.message) for p in e.value.problems] == [
        ("panels[0].layout.x", "Expected a finite number."),
        ("panels[0].options.decimals", "Expected a finite number."),
    ]


def test_a_lone_surrogate_does_not_break_the_size_check():
    lone = chr(0xD800)
    doc = validate_dashboard(_doc(description=lone), owner_kind="project")
    assert doc["description"] == lone


def test_alert_object_is_normalised():
    alert = {"name": " API latency high ", "query": "A", "op": "above", "threshold": 0.3}
    doc = validate_dashboard(_doc(_stat_panel(alert=alert)), owner_kind="project")
    assert json.dumps(doc["panels"][0]["alert"]) == json.dumps(
        {
            "name": "API latency high",
            "query": "A",
            "of": "each",
            "op": "above",
            "threshold": 0.3,
            "for": "5m",
            "every": "1m",
            "severity": "warning",
            "message": "",
            "notify": [],
            "engine": "omnikrux",
            "channel": None,
        }
    )


def test_documents_without_alerts_are_unchanged():
    for case in OK_CASES:
        if "alert" in json.dumps(case["input"]):
            continue
        out = validate_dashboard(case["input"], owner_kind=case["owner"])
        assert all(p["alert"] is None for p in out["panels"])
