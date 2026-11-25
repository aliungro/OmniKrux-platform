"""The Grafana dashboard the live kind check seeds converts cleanly, alert included."""

import json
from pathlib import Path

from omnikrux.monitoring.transfer.detect import detect_format
from omnikrux.monitoring.transfer.grafana.convert import convert_grafana
from omnikrux.monitoring.transfer.grafana.datasources import GrafanaContext
from omnikrux.monitoring.transfer.types import AlertDraft

FIXTURE = Path(__file__).parents[1] / "e2e" / "fixtures" / "grafana_live_check.json"

# The rule Grafana's ruler serves for the provisioned alert on the stat panel (id 2).
RULE = {
    "for": "5m",
    "labels": {},
    "annotations": {"__dashboardUid__": "omnikrux-live", "__panelId__": "2"},
    "grafana_alert": {
        "title": "Targets down",
        "condition": "C",
        "no_data_state": "NoData",
        "exec_err_state": "Error",
        "data": [
            {"refId": "A", "datasourceUid": "prom", "model": {"expr": "sum(up)", "refId": "A"}},
            {
                "refId": "B",
                "datasourceUid": "__expr__",
                "model": {"type": "reduce", "expression": "A", "reducer": "last"},
            },
            {
                "refId": "C",
                "datasourceUid": "__expr__",
                "model": {
                    "type": "threshold",
                    "expression": "B",
                    "conditions": [{"evaluator": {"type": "lt", "params": [1]}}],
                },
            },
        ],
    },
}


def convert(ctx):
    value = json.loads(FIXTURE.read_text("utf-8"))
    return convert_grafana(detect_format(value)[1], ctx, key="live")


def test_live_check_dashboard_converts_without_problems():
    c = convert(GrafanaContext())
    assert c.problems == ()
    assert c.title == "OmniKrux live check"
    assert [(p["type"], p["title"]) for p in c.doc["panels"]] == [
        ("timeseries", "Prometheus requests"),
        ("stat", "Targets up"),
        ("logs", "Check logs"),
    ]
    assert [v["name"] for v in c.doc["variables"]] == ["job"]
    assert c.alerts == ()


def test_live_check_stat_panel_carries_the_provisioned_alert():
    c = convert(GrafanaContext(alert_rules=(RULE,)))
    assert c.problems == ()
    assert len(c.alerts) == 1
    panel_id, draft = c.alerts[0]
    assert panel_id == c.doc["panels"][1]["id"]
    assert (draft.reducer, draft.op, draft.threshold, draft.for_seconds) == (
        "last",
        "below",
        1.0,
        300,
    )
    assert isinstance(draft, AlertDraft)
