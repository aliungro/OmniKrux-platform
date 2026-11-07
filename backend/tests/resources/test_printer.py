from datetime import UTC, datetime

from omnikrux.kube.discovery import ApiResource
from omnikrux.resources.kinds import generic_spec
from omnikrux.resources.printer import json_path, printer_columns, printer_row_builder

WIDGET = {
    "kind": "Widget",
    "metadata": {
        "uid": "w1",
        "name": "w",
        "namespace": "demo",
        "creationTimestamp": "2026-11-06T10:00:00Z",
    },
    "spec": {"size": 3, "ports": [{"n": 80}, {"n": 443}]},
    "status": {
        "conditions": [
            {"type": "Progressing", "status": "True"},
            {"type": "Ready", "status": "False", "reason": "Pending"},
        ],
        "phase": "Waiting",
    },
}


def test_printer_columns_jsonpath_subset():
    assert json_path(WIDGET, ".spec.size") == [3]
    assert json_path(WIDGET, ".spec.ports[0].n") == [80]
    assert json_path(WIDGET, ".spec.ports[*].n") == [80, 443]
    assert json_path(WIDGET, '.status.conditions[?(@.type=="Ready")].status') == ["False"]
    assert json_path(WIDGET, ".status.conditions[?(@.type=='Ready')].reason") == ["Pending"]
    assert json_path(WIDGET, ".spec.missing") == []
    assert json_path(WIDGET, ".spec.ports[9].n") == []
    for unsupported in ("", ".", "spec.size", ".spec..size", ".a[?(@.k>1)]", ".a[1:2]", "{.spec}"):
        assert json_path(WIDGET, unsupported) is None, unsupported

    crd = [
        {"name": "Size", "type": "integer", "jsonPath": ".spec.size"},
        {"name": "Hidden", "type": "string", "jsonPath": ".spec.x", "priority": 1},
        {
            "name": "Ready",
            "type": "string",
            "jsonPath": '.status.conditions[?(@.type=="Ready")].status',
        },
        {"name": "Age", "type": "date", "jsonPath": ".metadata.creationTimestamp"},
        {"name": "Size", "type": "integer", "jsonPath": ".spec.size"},
    ]
    columns = printer_columns(crd)
    assert [c.name for c in columns] == ["Size", "Ready", "Age"]
    assert [c.key for c in columns] == ["pc_size", "pc_ready", "pc_age"]

    row = printer_row_builder(columns)(WIDGET, "c1")
    assert row.kind == "Widget" and row.name == "w" and row.namespace == "demo"
    assert row.columns["pc_size"] == 3
    assert row.columns["pc_ready"] == "False"
    assert row.columns["status"] == "False" and row.columns["status_class"] == "bad"
    assert row.columns["pc_age"] == datetime(2026, 11, 6, 10, 0, tzinfo=UTC)


def test_printer_row_cells_are_dashes_when_unreadable():
    columns = printer_columns(
        [
            {"name": "Odd", "type": "string", "jsonPath": ".a[1:2]"},
            {"name": "Obj", "type": "string", "jsonPath": ".status"},
            {"name": "Status", "type": "string", "jsonPath": ".status.phase"},
        ]
    )
    row = printer_row_builder(columns, kind="Widget")({"metadata": {"name": "w"}}, "c1")
    assert row.columns["pc_odd"] is None and row.columns["pc_obj"] is None
    assert row.columns["status_class"] == "warn"
    full = printer_row_builder(columns, kind="Widget")(WIDGET, "c1")
    assert full.columns["pc_obj"] is None and full.columns["status_class"] == "warn"


def test_generic_spec_uses_printer_columns_between_namespace_and_age():
    res = ApiResource("example.dev", "v1", "widgets", "Widget", True, frozenset(), ())
    spec = generic_spec(
        res,
        [
            {"name": "Size", "type": "integer", "jsonPath": ".spec.size"},
            {"name": "Ready", "type": "string", "jsonPath": ".status.phase"},
            {"name": "Name", "type": "string", "jsonPath": ".metadata.name"},
            {"name": "Age", "type": "date", "jsonPath": ".metadata.creationTimestamp"},
        ],
    )
    assert [(c.key, c.type) for c in spec.columns] == [
        ("name", "text"),
        ("namespace", "text"),
        ("pc_size", "number"),
        ("pc_ready", "status"),
        ("age", "age"),
    ]
    assert spec.to_row(WIDGET, "c1").columns["pc_size"] == 3
