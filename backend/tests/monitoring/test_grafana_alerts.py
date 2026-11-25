"""Grafana alerts (old panel alerts and unified rules) in the converter."""

import copy
import json
from pathlib import Path

import pytest

from omnikrux.monitoring.dashboards.schema import validate_dashboard
from omnikrux.monitoring.transfer.alerts import alert_from_draft
from omnikrux.monitoring.transfer.detect import detect_format
from omnikrux.monitoring.transfer.grafana.alerts import PanelInfo, legacy_draft, unified_drafts
from omnikrux.monitoring.transfer.grafana.convert import convert_grafana
from omnikrux.monitoring.transfer.grafana.datasources import GrafanaContext
from omnikrux.monitoring.transfer.types import AlertDraft

FIXTURES = Path(__file__).parent / "grafana_fixtures"
CPU = (
    'sum by (namespace) (rate(container_cpu_usage_seconds_total{namespace=~"${namespace:regex}"}'
    "[$__rate_interval]))"
)
NO_UID = "no-uid"


def load(name):
    return json.loads((FIXTURES / f"{name}.json").read_text("utf-8"))


NO_CONTEXT = GrafanaContext()


def conv(name, ctx=NO_CONTEXT):
    return convert_grafana(detect_format(load(name))[1], ctx, key="d-1")


def where_what(c):
    return [(s.where, s.what) for s in c.skipped]


def dashboard_uid(name):
    d = load(name)
    return d.get("dashboard", d)["uid"]


def unified(
    title,
    *,
    panel="1",
    expr="up",
    reduce=None,
    op="gt",
    value=1.0,
    for_="5m",
    severity=None,
    summary=None,
    math=False,
    classic=None,
    dashboard=None,
):
    data = [{"refId": "A", "datasourceUid": "prom", "model": {"expr": expr, "refId": "A"}}]
    last = "A"
    if math:
        data.append({"refId": "B", "datasourceUid": "prom", "model": {"expr": "up", "refId": "B"}})
        math_model = {"type": "math", "expression": "$A + $B"}
        data.append({"refId": "C", "datasourceUid": "__expr__", "model": math_model})
        last = "C"
    elif classic is not None:
        model = {"type": "classic_conditions", "conditions": classic}
        data.append({"refId": "B", "datasourceUid": "__expr__", "model": model})
        last = "B"
    else:
        if reduce:
            model = {"type": "reduce", "expression": last, "reducer": reduce}
            data.append({"refId": "B", "datasourceUid": "__expr__", "model": model})
            last = "B"
        model = {
            "type": "threshold",
            "expression": last,
            "conditions": [{"evaluator": {"type": op, "params": [value]}}],
        }
        data.append({"refId": "T", "datasourceUid": "__expr__", "model": model})
        last = "T"
    annotations = {"__dashboardUid__": dashboard or "grid39", "__panelId__": panel}
    if summary is not None:
        annotations["summary"] = summary
    labels = {"severity": severity} if severity else {}
    return {
        "for": for_,
        "labels": labels,
        "annotations": annotations,
        "grafana_alert": {"title": title, "condition": last, "data": data},
    }


def classic(reducer="avg", op="gt", value=2, ref="A"):
    return [
        {
            "evaluator": {"type": op, "params": [value]},
            "reducer": {"type": reducer},
            "query": {"params": [ref]},
        }
    ]


def rules_ctx(*rules):
    uid = dashboard_uid("gridpos_v39_objects")
    for r in rules:
        if r["annotations"]["__dashboardUid__"] == "grid39":
            r["annotations"]["__dashboardUid__"] = uid
    return GrafanaContext(alert_rules=tuple(rules))


def test_legacy_alert_becomes_a_draft():
    c = conv("gridpos_v22_inputs")
    draft = AlertDraft(
        "A", "mean", "above", 0.3, 300, "p95 too slow", "p95 above 300 ms", None, 300
    )
    assert c.alerts == (("p-1", draft),)
    assert ('Alert "p95 too slow"', "Notification channels") in where_what(c)
    assert all(p["alert"] is None for p in c.doc["panels"])


def test_legacy_last_reducer_alert_passes_the_alert_adapter():
    c = conv("gridpos_v22_inputs")
    draft = c.alerts[0][1]
    last = AlertDraft(draft.query_ref, "last", "above", 0.3, 300, "p95", None, None, None)
    panel = next(p for p in c.doc["panels"] if p["id"] == "p-1")
    alert, item = alert_from_draft(last, panel=panel, variables=c.doc["variables"])
    assert item is None and alert["severity"] == "warning" and alert["message"] == ""
    doc = copy.deepcopy(c.doc)
    doc["panels"][0]["alert"] = alert
    validate_dashboard(doc, owner_kind="project")


def test_unified_rules_linked_to_panels():
    ctx = rules_ctx(
        unified(
            "High CPU", expr=CPU, reduce="mean", op="gt", value=0.8, for_="10m", severity="warning"
        ),
        unified("Math rule", math=True),
        unified("Pie rule", panel="6", expr="sum(up)"),
        unified("Other dashboard", dashboard="other", expr=CPU),
    )
    c = conv("gridpos_v39_objects", ctx)
    expected = AlertDraft("A", "mean", "above", 0.8, 600, "High CPU", None, "warning", None)
    assert c.alerts == (("p-1", expected),)
    reasons = {(s.where, s.what, s.reason) for s in c.skipped}
    assert ('Alert "Pie rule"', "The rule", "Its panel wasn't copied.") in reasons
    assert ('Alert "Math rule"', "The rule", "It combines 2 queries.") in reasons
    assert not any("Other dashboard" in s.where for s in c.skipped)


def test_unified_message_and_severity_stay_unset_when_the_rule_sets_none():
    c = conv(
        "gridpos_v39_objects",
        rules_ctx(unified("R", expr=CPU, summary="CPU is high", severity="Page")),
    )
    assert c.alerts[0][1].message == "CPU is high" and c.alerts[0][1].severity == "Page"
    rule = unified("R", expr=CPU)
    rule["annotations"]["description"] = "From the description"
    c = conv("gridpos_v39_objects", rules_ctx(rule))
    assert c.alerts[0][1].message == "From the description"
    c = conv("gridpos_v39_objects", rules_ctx(unified("R", expr=CPU)))
    assert (c.alerts[0][1].message, c.alerts[0][1].severity) == (None, None)


def test_unified_classic_conditions_and_whitespace():
    rule = unified("Classic", expr="  sum(  up )  ", classic=classic("max", "lt", 3))
    info = PanelInfo("p-1", "T", {"A": "A"}, {"A": "sum(\n up )"})
    drafts, skipped = unified_drafts([rule], {"1": info})
    assert skipped == []
    assert drafts == [
        ("p-1", AlertDraft("A", "max", "below", 3.0, 300, "Classic", None, None, None))
    ]


@pytest.mark.parametrize(
    "rule, reason",
    [
        (
            unified("R", classic=classic("avg") + classic("max")),
            "It has 2 conditions; OmniKrux alerts have one.",
        ),
        (
            unified("R", op="within_range"),
            "It checks within_range; OmniKrux alerts check above or below a value.",
        ),
        (
            unified("R", reduce="count"),
            "It uses count; OmniKrux alerts use last, mean, max, min or sum.",
        ),
        (unified("R", expr="something_else"), "Its query isn't one of the panel's queries."),
    ],
)
def test_unified_rules_that_do_not_fit(rule, reason):
    info = PanelInfo("p-1", "T", {"A": "A"}, {"A": "up"})
    drafts, skipped = unified_drafts([rule], {"1": info})
    assert drafts == []
    assert [(s.where, s.what, s.reason) for s in skipped] == [('Alert "R"', "The rule", reason)]


def test_unified_state_and_pause_words():
    rule = unified("R")
    rule["grafana_alert"].update(
        {"no_data_state": "OK", "exec_err_state": "KeepLast", "is_paused": True}
    )
    info = PanelInfo("p-1", "T", {"A": "A"}, {"A": "up"})
    drafts, skipped = unified_drafts([rule], {"1": info})
    assert len(drafts) == 1
    assert [s.what for s in skipped] == [
        "No data state OK",
        "Error state KeepLast",
        "It is paused in Grafana",
    ]


def test_unreadable_rules_are_listed():
    note = (
        "Couldn't read Grafana · kind's alert rules (HTTP 403), so no Grafana alert was copied. "
        "A sign-in that can read alert rules fixes this."
    )
    c = conv("gridpos_v39_objects", GrafanaContext(alert_rules=None, alert_rules_note=note))
    listed = [(s.where, s.what, s.reason) for s in c.skipped if s.what == "Grafana alert rules"]
    assert listed == [("Dashboard", "Grafana alert rules", note)]


def legacy(reducer="avg", op="gt", value=0.5, **extra):
    return {
        "name": "A",
        "for": "0m",
        "conditions": [
            {
                "type": "query",
                "query": {"params": ["A", "10m", "now"]},
                "reducer": {"type": reducer},
                "evaluator": {"type": op, "params": [value]},
            }
        ],
        **extra,
    }


def test_legacy_alert_edges():
    refs = {"A": "A"}
    draft, items = legacy_draft(legacy("last", "lt", 2), refs)
    assert draft == AlertDraft("A", "last", "below", 2.0, 0, "A", None, None, 600) and items == []
    assert legacy_draft(legacy(noDataState="alerting"), refs)[1][0].what == "No data state alerting"
    quiet = legacy(noDataState="no_data", executionErrorState="alerting")
    # Grafana's own default states alert too, so every state the source sets is listed
    assert [i.what for i in legacy_draft(quiet, refs)[1]] == [
        "No data state no_data",
        "Error state alerting",
    ]


@pytest.mark.parametrize(
    "alert, reason",
    [
        (
            {"name": "x", "conditions": legacy()["conditions"] * 2},
            "It has 2 conditions; OmniKrux alerts have one.",
        ),
        (
            legacy(op="within_range"),
            "It checks within_range; OmniKrux alerts check above or below a value.",
        ),
        (
            legacy(reducer="count"),
            "It uses count; OmniKrux alerts use last, mean, max, min or sum.",
        ),
        (legacy(value=float("inf")), "Its threshold isn't a number."),
    ],
)
def test_legacy_alerts_that_do_not_fit(alert, reason):
    draft, items = legacy_draft(alert, {"A": "A"})
    assert draft is None
    assert [(i.what, i.reason) for i in items] == [("The rule", reason)]


def test_legacy_alert_on_a_query_that_was_not_kept():
    draft, items = legacy_draft(legacy(), {"B": "A"})
    assert draft is None
    assert items[0].reason == "Its query isn't one of the panel's queries."


@pytest.mark.parametrize("raw", ["500ms", "5m30", "soon", -5, True])
def test_a_wait_that_cant_be_read_waits_0s_and_says_so(raw):
    c = conv("gridpos_v39_objects", rules_ctx(unified("High CPU", expr=CPU, for_=raw)))
    [(_, draft)] = c.alerts
    assert draft.for_seconds == 0
    shown = raw if isinstance(raw, str) else str(raw)
    assert (
        'Alert "High CPU"',
        "The wait",
        f'Its wait "{shown}" couldn\'t be read, so it waits 0s.',
    ) in [(s.where, s.what, s.reason) for s in c.skipped]


def test_a_missing_or_readable_wait_says_nothing():
    for raw in (None, "", "0s", "1h30m", 90):
        c = conv("gridpos_v39_objects", rules_ctx(unified("High CPU", expr=CPU, for_=raw)))
        assert not any(s.what == "The wait" for s in c.skipped), raw
    legacy = load("gridpos_v22_inputs")
    legacy["panels"][0]["alert"]["for"] = "5m30"
    draft, items = legacy_draft(legacy["panels"][0]["alert"], {"A": "A"})
    assert draft is not None and draft.for_seconds == 0
    assert ('Alert "p95 too slow"', "The wait") in [(s.where, s.what) for s in items]
