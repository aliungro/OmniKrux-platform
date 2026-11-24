"""The Grafana converter: layout, data sources and panels."""

import json
from pathlib import Path

import pytest

from omnikrux.monitoring.dashboards.schema import validate_dashboard
from omnikrux.monitoring.transfer.detect import detect_format
from omnikrux.monitoring.transfer.grafana.convert import convert_grafana
from omnikrux.monitoring.transfer.grafana.datasources import (
    GrafanaContext,
    GrafanaDatasource,
    Ref,
    Special,
    guess_type,
    resolve,
)
from omnikrux.monitoring.transfer.grafana.layout import place, rows_layout
from omnikrux.monitoring.transfer.grafana.panels import tone_for
from omnikrux.monitoring.transfer.types import Identity, SourceRefFound

FIXTURES = Path(__file__).parent / "grafana_fixtures"


def load(name):
    return json.loads((FIXTURES / f"{name}.json").read_text("utf-8"))


NO_CONTEXT = GrafanaContext()


def conv(name, ctx=NO_CONTEXT):
    return convert_grafana(detect_format(load(name))[1], ctx, key="d-1")


def where_what(c):
    return [(s.where, s.what) for s in c.skipped]


def stat_panel(i, **extra):
    return {
        "id": i,
        "type": "stat",
        "title": f"S{i}",
        "gridPos": {"x": 0, "y": i, "w": 4, "h": 2},
        "datasource": "Prom",
        "targets": [{"refId": "A", "expr": "up"}],
        **extra,
    }


def test_rows_layout_and_old_panels():
    c = conv("rows_v14")
    ps = c.doc["panels"]
    assert [(p["id"], p["type"], p["title"], p["layout"]) for p in ps] == [
        ("p-1", "timeseries", "CPU busy", {"x": 0, "y": 0, "w": 12, "h": 8}),
        ("p-2", "stat", "Load", {"x": 12, "y": 0, "w": 6, "h": 8}),
        ("p-3", "table", "Filesystems", {"x": 0, "y": 8, "w": 24, "h": 10}),
    ]
    assert ps[0]["options"]["style"] == "stacked" and ps[0]["options"]["unit"] == "percentunit"
    assert ps[0]["options"]["thresholds"] == [{"value": 0.9, "color": "bad"}]
    assert (
        ps[1]["options"].items()
        >= {
            "calc": "mean",
            "sparkline": True,
            "unit": "short",
            "thresholds": [{"value": 4, "color": "warn"}, {"value": 8, "color": "bad"}],
        }.items()
    )
    assert ps[0]["queries"][0]["source"] == {"type": "prometheus", "id": "grafana:name:Prometheus"}
    assert ps[0]["queries"][0]["legend"] == "{{instance}}"
    assert ('Panel "Notes"', "A text panel") in where_what(c)
    assert ("Dashboard", "Rows") in where_what(c)
    assert c.refs[0] == SourceRefFound(
        "grafana:name:Prometheus", "prometheus", True, "Prometheus", None, None
    )
    assert c.identity == Identity("grafana", None, 7)
    assert c.doc["time"] == {"from": "now-24h", "to": "now"} and c.doc["refresh"] == "1m"
    assert c.panel_sources == (("p-1", "1"), ("p-2", "2"), ("p-3", "4"))
    assert c.problems == () and c.alerts == ()


def test_gridpos_with_inputs():
    c = conv("gridpos_v22_inputs")
    assert [(p["type"], p["layout"]) for p in c.doc["panels"]] == [
        ("timeseries", {"x": 0, "y": 0, "w": 12, "h": 9}),
        ("stat", {"x": 12, "y": 0, "w": 6, "h": 4}),
        ("gauge", {"x": 18, "y": 0, "w": 6, "h": 4}),
        ("bar", {"x": 12, "y": 4, "w": 12, "h": 5}),
    ]
    stat = c.doc["panels"][1]["options"]
    assert (stat["unit"], stat["decimals"], stat["calc"], stat["thresholds"]) == (
        "reqps",
        1,
        "last",
        [{"value": 100, "color": "warn"}, {"value": 200, "color": "bad"}],
    )
    assert stat["sparkline"] is True
    gauge = c.doc["panels"][2]["options"]
    assert gauge["max"] == 1 and gauge["min"] == 0
    bar = c.doc["panels"][3]["options"]
    assert bar["orientation"] == "horizontal" and "max" not in bar
    assert c.doc["refresh"] is None
    assert {
        ("Dashboard", "Auto-refresh every 5s"),
        ("Dashboard", "Tags"),
        ('Panel "Latency heatmap"', "A heatmap panel"),
    } <= set(where_what(c))
    assert c.refs == (
        SourceRefFound("grafana:input:DS_PROM", "prometheus", False, "Prometheus", None, None),
    )
    assert c.identity == Identity("grafana", "api-lat", 3)
    assert all(p["alert"] is None for p in c.doc["panels"])


def test_modern_objects_rows_mixed_and_logs():
    c = conv("gridpos_v39_objects")
    assert [(p["title"], p["layout"]) for p in c.doc["panels"]] == [
        ("CPU by namespace", {"x": 0, "y": 0, "w": 12, "h": 8}),
        ("API logs", {"x": 12, "y": 0, "w": 12, "h": 8}),
        ("Mixed", {"x": 6, "y": 8, "w": 18, "h": 6}),
        ("Restarts", {"x": 16, "y": 14, "w": 8, "h": 8}),
    ]
    logs = c.doc["panels"][1]
    assert logs["options"] == {"limit": 500, "wrap": False, "order": "oldest"}
    assert logs["queries"][0]["source"] == {"type": "loki", "id": "grafana:uid:loki-main"}
    assert [q["ref"] for q in c.doc["panels"][2]["queries"]] == ["A"]
    cpu = c.doc["panels"][0]["options"]
    assert cpu["legend"] == "hidden" and cpu["style"] == "stacked"
    assert c.doc["panels"][0]["queries"][0]["legend"] == ""
    assert c.doc["panels"][3]["options"]["orientation"] == "horizontal"
    assert c.doc["panels"][0]["queries"][0]["source"]["id"] == "grafana:var:ds"
    assert {
        ('Panel "Mixed"', "Query B"),
        ('Panel "Mixed"', "Query C"),
        ('Panel "Mixed"', "Repeat by $namespace"),
        ('Panel "Share"', "A piechart panel"),
        ("Untitled panel 7", 'Library panel "Shared CPU"'),
        ('Panel "CPU by namespace"', "Per-series overrides"),
        ('Panel "Env pods"', "Query A"),
        ("Dashboard", "Annotations"),
        ("Dashboard", "Links"),
        ("Dashboard", "Time zone utc"),
        ("Dashboard", "Rows"),
    } <= set(where_what(c))
    assert ("Dashboard", "Annotations") in where_what(c)
    assert where_what(c).count(("Dashboard", "Annotations")) == 1


def test_wrapper_and_uid_only_datasources():
    c = conv("api_wrapper_v38")
    assert {(r.key, r.type, r.type_guessed) for r in c.refs} == {
        ("grafana:uid:P1809F7CD0C75ACF3", "prometheus", True),
        ("grafana:name:P8E80F9AEF21F6940", "loki", True),
    }
    ctx = GrafanaContext(
        datasources=(
            GrafanaDatasource(
                "P1809F7CD0C75ACF3", "Prometheus", "prometheus", "http://prom:9090", True
            ),
            GrafanaDatasource("P8E80F9AEF21F6940", "Loki", "loki", "http://loki:3100", False),
        )
    )
    c2 = conv("api_wrapper_v38", ctx)
    assert {(r.key, r.name, r.type_guessed, r.url) for r in c2.refs} == {
        ("grafana:uid:P1809F7CD0C75ACF3", "Prometheus", False, "http://prom:9090"),
        ("grafana:uid:P8E80F9AEF21F6940", "Loki", False, "http://loki:3100"),
    }
    assert c.identity == Identity("grafana", "plat-1", 4)


def test_overlaps_and_off_grid_are_placed():
    c = conv("layout_edges")
    assert [p["layout"] for p in c.doc["panels"]] == [
        {"x": 0, "y": 0, "w": 12, "h": 8},
        {"x": 20, "y": 0, "w": 4, "h": 2},
        {"x": 0, "y": 8, "w": 2, "h": 40},
        {"x": 6, "y": 8, "w": 12, "h": 8},
    ]


HOSTILE = [
    "x",
    None,
    3,
    [],
    {},
    {"panels": "x"},
    {"panels": [None, 3, "a", {"type": 5}]},
    {"panels": [{"type": "stat", "gridPos": "x", "targets": [{"expr": "up"}]}]},
    {"panels": [{"type": "stat", "targets": None, "datasource": 7}]},
    {"panels": [{"type": "stat", "targets": [None, 3, {"expr": "up", "datasource": 7}]}]},
    {"rows": {"a": 1}},
    {"rows": [{"panels": [{"type": "stat", "targets": [{"expr": "up"}], "span": "x"}]}]},
    {"title": ["x"], "panels": []},
    {"panels": [{"type": "stat", "title": ["x"], "targets": [{"expr": 5}]}]},
    {
        "panels": [
            {"type": "stat", "targets": [{"expr": "up"}], "gridPos": {"x": 3.7, "y": -4, "w": "a"}}
        ]
    },
    {
        "panels": [
            {
                "type": "stat",
                "targets": [{"expr": "up"}],
                "fieldConfig": {
                    "defaults": {
                        "thresholds": {"steps": [{"value": "abc"}, {"value": 1, "color": 5}]}
                    }
                },
            }
        ]
    },
    {"panels": [{"type": "row", "panels": [{"type": "row", "panels": [stat_panel(1)]}]}]},
    {"panels": [stat_panel(i) for i in range(500)]},
    {"title": "T" * 500, "description": "d" * 5000, "refresh": 7, "time": {"from": 5, "to": []}},
    {
        "panels": [
            {
                "type": "stat",
                "targets": [{"expr": "up", "legendFormat": "l" * 400}],
                "description": "d" * 5000,
            }
        ]
    },
    {
        "panels": [
            {"type": "stat", "targets": [{"expr": "up"}], "gridPos": {"x": 10**400, "w": 10**400}}
        ]
    },
    {
        "rows": [
            {
                "height": 9e307,
                "panels": [{"type": "stat", "targets": [{"expr": "up"}], "span": 9e307}],
            }
        ]
    },
    {"time": {"from": "1700000000000", "to": "2024-01-01T10:00:00.123Z"}, "panels": []},
]


@pytest.mark.parametrize("value", HOSTILE)
def test_converter_survives_hostile_shapes(value):
    c = convert_grafana(value, GrafanaContext(), key="d-1")
    assert c.doc is not None and c.problems == ()
    assert validate_dashboard(c.doc, owner_kind="project") == c.doc


def test_rows_inside_rows_flatten_in_order():
    inner = {"type": "row", "panels": [stat_panel(2, gridPos={"x": 0, "y": 5, "w": 4, "h": 2})]}
    outer = {
        "type": "row",
        "panels": [stat_panel(1, gridPos={"x": 0, "y": 1, "w": 4, "h": 2}), inner],
    }
    c = convert_grafana({"panels": [outer]}, GrafanaContext(), key="d-1")
    assert [p["title"] for p in c.doc["panels"]] == ["S1", "S2"]
    assert ("Dashboard", "Rows") in where_what(c)


def test_five_hundred_panels_keep_one_hundred():
    c = convert_grafana(
        {"title": "Big", "panels": [stat_panel(i) for i in range(500)]},
        GrafanaContext(),
        key="d-1",
    )
    assert len(c.doc["panels"]) == 100
    assert ("Dashboard", "Panels after the 100th") in where_what(c)


def test_time_refresh_and_title_are_read_carefully():
    c = convert_grafana(
        {
            "title": "  A\nB " + "x" * 200,
            "time": {"from": "1700000000000", "to": "2024-01-01T10:00:00.123+02:00"},
            "refresh": "1h",
            "panels": [],
        },
        GrafanaContext(),
        key="k",
    )
    assert c.doc["time"] == {"from": "2023-11-14T22:13:20Z", "to": "2024-01-01T08:00:00Z"}
    assert c.doc["refresh"] == "1h" and len(c.doc["title"]) <= 120
    assert ("Dashboard", "Title") in where_what(c)
    odd = convert_grafana(
        {"time": {"from": "now-1d/d", "to": "now"}, "title": " "}, GrafanaContext(), key="k"
    )
    assert (
        odd.doc["time"] == {"from": "now-6h", "to": "now"}
        and odd.doc["title"] == "Imported dashboard"
    )
    assert ("Dashboard", "Time range now-1d/d to now") in where_what(odd)


def test_units_calcs_thresholds_and_skips_are_said():
    panel = {
        "id": 9,
        "type": "stat",
        "title": "Odd",
        "datasource": "P",
        "targets": [{"expr": "up"}],
        "fieldConfig": {
            "defaults": {
                "unit": "watt",
                "thresholds": {
                    "mode": "absolute",
                    "steps": [
                        {"color": "orange", "value": None},
                        {"color": "blue", "value": 5},
                        {"color": "red", "value": 9},
                    ],
                },
            },
            "overrides": [],
        },
        "options": {"reduceOptions": {"calcs": ["median"]}},
        "timeFrom": "1h",
        "links": [{"title": "x"}],
        "transformations": [{"id": "x"}],
    }
    c = convert_grafana({"panels": [panel]}, GrafanaContext(), key="k")
    p = c.doc["panels"][0]
    assert p["options"]["unit"] == "none" and p["options"]["calc"] == "last"
    assert p["options"]["thresholds"] == [{"value": 9, "color": "bad"}]
    got = {(s.what, s.reason) for s in c.skipped}
    assert ("Unit watt", "OmniKrux has no such unit, so values show without one.") in got
    assert (
        "Calculation median",
        "OmniKrux shows last, mean, max, min or sum; it shows the last value.",
    ) in got
    assert ("Threshold 5", "Its colour blue isn't good, warning or bad.") in got
    assert ("Colour below 9", "OmniKrux doesn't colour values below the first threshold.") in got
    assert ("Its own time range", "Panels follow the dashboard's time range in OmniKrux.") in got
    assert ("Links", "Panel links aren't in OmniKrux.") in got
    assert (
        "Transformations",
        "They aren't in OmniKrux; the panel shows the query results as they are.",
    ) in got


def test_old_graph_thresholds_and_counter_units():
    panel = {
        "type": "graph",
        "title": "G",
        "datasource": "P",
        "yaxes": [{"format": "ops"}],
        "targets": [{"expr": "up"}],
        "thresholds": [
            {"value": 5, "op": "lt", "colorMode": "critical"},
            {"value": 7, "op": "gt", "colorMode": "custom", "lineColor": "#299c46"},
        ],
    }
    c = convert_grafana({"panels": [panel]}, GrafanaContext(), key="k")
    o = c.doc["panels"][0]["options"]
    assert o["unit"] == "short" and o["thresholds"] == [{"value": 7, "color": "ok"}]
    got = {(s.what, s.reason) for s in c.skipped}
    assert ("Unit ops", "Shown as a plain number.") in got
    assert ("Threshold 5", "OmniKrux thresholds mark values above them.") in got


def test_targets_are_kept_renamed_and_capped():
    targets = [{"refId": "A", "expr": "a"}, {"refId": "A", "expr": "b", "hide": True}]
    targets += [{"expr": f"m{i}"} for i in range(11)]
    targets.append({"refId": "Z", "expr": ""})
    c = convert_grafana(
        {"panels": [{"type": "table", "title": "T", "datasource": "P", "targets": targets}]},
        GrafanaContext(),
        key="k",
    )
    qs = c.doc["panels"][0]["queries"]
    assert [q["ref"] for q in qs] == list("ABCDEFGHIJ")
    assert qs[1]["hidden"] is True
    got = {(s.what, s.reason) for s in c.skipped}
    assert ("Query Z", "It has no query text.") in got
    assert any(
        w.startswith("Queries ") and r == "A panel keeps at most 10 queries." for w, r in got
    )


def test_logs_panel_needs_a_loki_query():
    loki = {"type": "loki", "uid": "l"}
    ok = {
        "type": "logs",
        "title": "L",
        "datasource": loki,
        "targets": [{"refId": "A", "expr": '{a="b"}'}, {"refId": "B", "expr": '{a="c"}'}],
    }
    bad = {"type": "logs", "title": "M", "datasource": "Prom", "targets": [{"expr": "up"}]}
    c = convert_grafana({"panels": [ok, bad]}, GrafanaContext(), key="k")
    assert [p["title"] for p in c.doc["panels"]] == ["L"]
    got = {(s.where, s.what, s.reason) for s in c.skipped}
    assert (
        'Panel "L"',
        "Query B",
        "A logs panel shows one Loki query; the first was kept.",
    ) in got
    assert ('Panel "M"', "The whole panel", "A logs panel needs a Loki query.") in got


def test_a_panel_the_validator_refuses_is_dropped_with_its_words():
    long_legend = {
        "type": "stat",
        "title": "Bad",
        "datasource": "P",
        "targets": [{"expr": "up", "legendFormat": "l" * 400}],
    }
    c = convert_grafana({"panels": [long_legend, stat_panel(2)]}, GrafanaContext(), key="k")
    assert [p["title"] for p in c.doc["panels"]] == ["S2"]
    item = next(s for s in c.skipped if s.where == 'Panel "Bad"')
    assert item.what == "The whole panel"
    assert item.reason.startswith("It couldn't be converted: panels[0].queries[0].legend: ")


def test_layout_helpers():
    placed = place([(0, {"x": 0, "y": 0, "w": 12, "h": 8}), (1, {"x": 6, "y": 0, "w": 12, "h": 8})])
    assert placed[1] == (1, {"x": 6, "y": 8, "w": 12, "h": 8})
    assert place([(0, {"x": 0, "y": 5, "w": 4, "h": 2})]) == [(0, {"x": 0, "y": 0, "w": 4, "h": 2})]
    rows = rows_layout(
        [{"height": "bad", "panels": [{"span": 8}, {"span": 8}, {"span": 8, "height": "90"}]}]
    )
    assert [lay for _, lay in rows] == [
        {"x": 0, "y": 0, "w": 16, "h": 8},
        {"x": 0, "y": 8, "w": 16, "h": 8},
        {"x": 0, "y": 16, "w": 16, "h": 3},
    ]


def test_datasource_resolution():
    ctx = GrafanaContext(datasources=(GrafanaDatasource("u1", "Main", "prometheus", None, True),))
    args = {
        "ctx": ctx,
        "inputs": {"IN": {"label": "Prom", "pluginId": "prometheus"}},
        "ds_vars": {"ds": "loki"},
        "default_key": "grafana:default",
    }
    assert resolve("Main", **args) == Ref("grafana:uid:u1", "prometheus", "Main")
    assert resolve(None, **args) == Ref("grafana:uid:u1", "prometheus", "Main")
    assert resolve("${IN}", **args) == Ref("grafana:input:IN", "prometheus", "Prom")
    assert resolve({"uid": "$ds"}, **args) == Ref("grafana:var:ds", "loki", "ds")
    assert resolve({"uid": "-- Mixed --"}, **args) == Special("mixed")
    assert resolve("-- Grafana --", **args) == Special("grafana")
    assert resolve({"uid": "zz", "type": "mysql"}, **args) == Ref("grafana:uid:zz", "mysql", "zz")
    assert resolve(7, **{**args, "ctx": GrafanaContext()}) == Ref(
        "grafana:default", None, "Default data source"
    )
    assert (
        guess_type(['{a="b"}']) == "loki"
        and guess_type(['sum(count_over_time({a="b"}[1m]))']) == "loki"
    )
    assert guess_type(["up", "rate(x[5m])"]) == "prometheus"


def test_tones():
    assert [
        tone_for(c)
        for c in [
            "green",
            "semi-dark-red",
            "#EAB839",
            "rgba(237, 129, 40, 0.89)",
            "#299c46",
            "blue",
            "text",
        ]
    ] == ["ok", "bad", "warn", "warn", "ok", None, None]
    assert tone_for("#ffffff") is None and tone_for("#d44a3a") == "bad"


def test_singlestat_shown_as_gauge_keeps_its_string_thresholds():
    panel = {
        "type": "singlestat",
        "title": "G",
        "datasource": "P",
        "gauge": {"show": True, "minValue": 0, "maxValue": 10},
        "thresholds": "4,8",
        "colors": ["#299c46", "#d44a3a", "blue"],
        "targets": [{"expr": "up"}],
    }
    c = convert_grafana({"panels": [panel]}, GrafanaContext(), key="k")
    p = c.doc["panels"][0]
    assert p["type"] == "gauge" and p["options"]["thresholds"] == [{"value": 4, "color": "bad"}]
    assert ("Threshold 8", "Its colour blue isn't good, warning or bad.") in {
        (s.what, s.reason) for s in c.skipped
    }
