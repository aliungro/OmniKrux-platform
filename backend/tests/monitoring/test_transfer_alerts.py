"""The alert adapter: M4's panel alert in exports, imports and Grafana conversions."""

import copy
from dataclasses import replace

import pytest

from omnikrux.monitoring.dashboards.schema import DashboardInvalid, validate_dashboard
from omnikrux.monitoring.transfer.alerts import (
    alert_from_draft,
    count_alerts,
    draft_from_alert,
    export_alert,
    import_alert,
    merge_alert,
    validate_panel_alert,
)
from omnikrux.monitoring.transfer.types import AlertDraft, SkippedItem

DRAFT = AlertDraft(
    query_ref="A",
    reducer="mean",
    op="above",
    threshold=0.3,
    for_seconds=300,
    title="p95 too slow",
    message="p95 above 300 ms",
    severity=None,
    window_seconds=300,
)

RUNS_IN_THE_TOOL = SkippedItem(
    'Alert on panel "Latency"',
    "Runs in the tool",
    "Imported alerts run on OmniKrux's own engine. Switch it in the panel's Alert tab.",
)


def panel_with_queries(*refs, kind="timeseries", expr="up"):
    return {
        "id": "p-1",
        "type": kind,
        "title": "Latency",
        "layout": {"x": 0, "y": 0, "w": 12, "h": 8},
        "queries": [
            {"ref": ref, "source": {"type": "prometheus", "id": "src-1"}, "expr": expr}
            for ref in refs
        ],
    }


def m4_alert(**changes):
    alert = {
        "name": "p95 too slow",
        "query": "A",
        "of": "each",
        "op": "above",
        "threshold": 0.3,
        "for": "5m",
        "every": "1m",
        "severity": "warning",
        "message": "p95 above 300 ms",
        "notify": [],
        "engine": "omnikrux",
        "channel": None,
    }
    alert.update(changes)
    return alert


# --- Grafana drafts -> M4 alerts ------------------------------------------------------------


def test_a_mean_draft_is_skipped_in_words():
    alert, skipped = alert_from_draft(DRAFT, panel=panel_with_queries("A"))
    assert alert is None
    assert skipped == SkippedItem(
        'Alert "p95 too slow"',
        "The rule",
        "It uses mean over the values; OmniKrux alerts check the latest value.",
    )


@pytest.mark.parametrize("reducer", ["max", "min", "sum"])
def test_every_reducer_but_last_is_skipped(reducer):
    alert, skipped = alert_from_draft(
        replace(DRAFT, reducer=reducer), panel=panel_with_queries("A")
    )
    assert alert is None
    assert skipped.reason == (
        f"It uses {reducer} over the values; OmniKrux alerts check the latest value."
    )


def test_a_last_value_draft_becomes_a_valid_m4_alert():
    alert, skipped = alert_from_draft(replace(DRAFT, reducer="last"), panel=panel_with_queries("A"))
    assert skipped is None
    validate_panel_alert(alert, panel_with_queries("A"))  # does not raise
    assert alert["engine"] == "omnikrux" and alert["of"] == "each" and alert["notify"] == []
    assert alert == m4_alert()
    back = draft_from_alert(alert)
    assert (back.query_ref, back.reducer, back.op, back.threshold, back.for_seconds) == (
        "A",
        "last",
        "above",
        0.3,
        300,
    )
    assert (back.title, back.message, back.severity) == (
        "p95 too slow",
        "p95 above 300 ms",
        "warning",
    )


def test_the_alert_fits_a_whole_dashboard_unchanged():
    alert, _ = alert_from_draft(replace(DRAFT, reducer="last"), panel=panel_with_queries("A"))
    doc = {
        "schemaVersion": 1,
        "title": "API",
        "panels": [panel_with_queries("A") | {"alert": alert}],
    }
    assert validate_dashboard(doc, owner_kind="project")["panels"][0]["alert"] == alert


@pytest.mark.parametrize(
    ("seconds", "text"), [(0, "0s"), (90, "90s"), (300, "5m"), (3600, "1h"), (86400, "24h")]
)
def test_the_wait_becomes_duration_text(seconds, text):
    alert, skipped = alert_from_draft(
        replace(DRAFT, reducer="last", for_seconds=seconds), panel=panel_with_queries("A")
    )
    assert skipped is None
    assert alert["for"] == text
    assert draft_from_alert(alert).for_seconds == seconds


def test_a_wait_over_a_day_is_skipped_in_words():
    alert, skipped = alert_from_draft(
        replace(DRAFT, reducer="last", for_seconds=2 * 86400), panel=panel_with_queries("A")
    )
    assert alert is None
    assert skipped == SkippedItem(
        'Alert "p95 too slow"', "The rule", "It waits 48h; OmniKrux alerts wait at most 24h."
    )


def test_a_draft_on_a_missing_query_is_skipped():
    _, skipped = alert_from_draft(replace(DRAFT, query_ref="B"), panel=panel_with_queries("A"))
    assert skipped == SkippedItem(
        'Alert "p95 too slow"', "The rule", "Its query isn't one of the panel's queries."
    )


def test_a_last_draft_on_a_missing_query_is_skipped():
    alert, skipped = alert_from_draft(
        replace(DRAFT, reducer="last", query_ref="B"), panel=panel_with_queries("A")
    )
    assert alert is None
    assert skipped.reason == "Its query isn't one of the panel's queries."


@pytest.mark.parametrize(("given", "kept"), [("critical", "critical"), ("Info", "info")])
def test_a_known_severity_is_kept(given, kept):
    alert, skipped = alert_from_draft(
        replace(DRAFT, reducer="last", severity=given), panel=panel_with_queries("A")
    )
    assert skipped is None
    assert alert["severity"] == kept


def test_an_unknown_severity_becomes_warning_in_words():
    alert, skipped = alert_from_draft(
        replace(DRAFT, reducer="last", severity="page"), panel=panel_with_queries("A")
    )
    assert alert is not None and alert["severity"] == "warning"
    assert skipped == SkippedItem(
        'Alert "p95 too slow"',
        "Severity page",
        "OmniKrux uses critical, warning or info; it is warning here.",
    )


def test_a_draft_that_does_not_fit_is_skipped_in_words():
    alert, skipped = alert_from_draft(
        replace(DRAFT, reducer="last", title="x" * 121), panel=panel_with_queries("A")
    )
    assert alert is None
    assert skipped == SkippedItem(
        'Alert "' + "x" * 121 + '"',
        "The rule",
        "It doesn't fit OmniKrux alerts: name: Use 1 to 120 characters, without line breaks.",
    )


def test_a_draft_on_a_table_panel_is_skipped_in_words():
    alert, skipped = alert_from_draft(
        replace(DRAFT, reducer="last"), panel=panel_with_queries("A", kind="table")
    )
    assert alert is None
    assert skipped.reason == (
        "It doesn't fit OmniKrux alerts: A table panel can't have an alert. "
        "Use a time series, stat, gauge or bar panel."
    )


def test_a_draft_reads_the_dashboard_variables():
    panel = panel_with_queries("A", expr='up{job="$job"}')
    variables = [
        {
            "name": "job",
            "type": "labelValues",
            "source": {"type": "prometheus", "id": None},
            "labelName": "job",
        }
    ]
    alert, skipped = alert_from_draft(replace(DRAFT, reducer="last"), panel=panel)
    assert skipped is None  # a $name that isn't a variable stays as written
    alert, skipped = alert_from_draft(
        replace(DRAFT, reducer="last"), panel=panel, variables=variables
    )
    assert alert is None
    assert skipped.reason == (
        "It doesn't fit OmniKrux alerts: query: Uses $job, which has no default value. "
        "Alerts use each variable's default, so give it one."
    )
    alert, skipped = alert_from_draft(
        replace(DRAFT, reducer="last"),
        panel=panel,
        variables=[variables[0] | {"default": ["api"]}],
    )
    assert skipped is None and alert is not None


def test_draft_from_alert_refuses_what_a_draft_cannot_hold():
    assert draft_from_alert(m4_alert(of="total")) is None
    assert draft_from_alert(m4_alert(**{"for": "soon"})) is None
    assert draft_from_alert(m4_alert(threshold="high")) is None
    assert draft_from_alert({"name": "x"}) is None
    assert draft_from_alert("not an alert") is None


# --- the alert check ------------------------------------------------------------------------


def test_validate_panel_alert_reports_under_the_alert():
    with pytest.raises(DashboardInvalid) as e:
        validate_panel_alert(
            {"name": "x", "query": "A", "op": "sideways", "threshold": 1}, panel_with_queries("A")
        )
    assert [p.path for p in e.value.problems] == ["panels[0].alert.op"]


def test_validate_panel_alert_ignores_problems_elsewhere():
    panel = panel_with_queries("A", expr="up{job=$nope}") | {
        "title": "x" * 500,
        "layout": {"x": 40},
        "options": {"sparkle": True},
    }
    validate_panel_alert(m4_alert(), panel)  # does not raise
    with pytest.raises(DashboardInvalid) as e:
        validate_panel_alert(m4_alert(threshold="high"), panel)
    assert [p.path for p in e.value.problems] == ["panels[0].alert.threshold"]


def test_validate_panel_alert_does_not_change_its_inputs():
    alert, panel = m4_alert(), panel_with_queries("A")
    before = (copy.deepcopy(alert), copy.deepcopy(panel))
    validate_panel_alert(alert, panel)
    assert (alert, panel) == before


# --- exports and imports --------------------------------------------------------------------


def test_exported_alert_round_trips_contact_points():
    alert = m4_alert(notify=["cp-1"])
    exported = export_alert(alert, contact_point_names={"cp-1": "Ops Slack"})
    assert exported == m4_alert(notify=[{"name": "Ops Slack"}])
    assert alert == m4_alert(notify=["cp-1"])  # the stored alert is untouched

    imported, skipped = import_alert(
        exported,
        panel=panel_with_queries("A"),
        panel_title="Latency",
        contact_points_by_name={"Ops Slack": "cp-9"},
    )
    assert skipped == []
    assert imported == m4_alert(notify=["cp-9"])

    imported, skipped = import_alert(
        exported, panel=panel_with_queries("A"), panel_title="Latency", contact_points_by_name={}
    )
    assert imported == m4_alert(notify=[])
    assert skipped == [
        SkippedItem(
            'Alert on panel "Latency"',
            'Contact point "Ops Slack"',
            "It doesn't exist here. Pick contact points in the panel's Alert tab.",
        )
    ]


def test_an_export_drops_a_contact_point_that_is_gone():
    exported = export_alert(
        m4_alert(notify=["cp-1", "cp-2"]), contact_point_names={"cp-2": "Pager"}
    )
    assert exported["notify"] == [{"name": "Pager"}]


def test_an_export_of_no_alert_is_none():
    assert export_alert(None, contact_point_names={}) is None


def test_an_export_carries_the_tool_channel_as_it_is():
    alert = m4_alert(engine="tool", channel={"receiver": "team-api", "labels": {"team": "api"}})
    assert export_alert(alert, contact_point_names={}) == alert


def test_imported_alerts_run_on_omnikrux():
    exported = m4_alert(
        engine="tool",
        channel={"receiver": "team-api", "labels": {"team": "api"}},
        notify=[{"name": "Ops Slack"}],
    )
    before = copy.deepcopy(exported)
    imported, skipped = import_alert(
        exported,
        panel=panel_with_queries("A"),
        panel_title="Latency",
        contact_points_by_name={"Ops Slack": "cp-9"},
    )
    assert exported == before
    assert imported == m4_alert(notify=["cp-9"])
    assert imported["engine"] == "omnikrux" and imported["channel"] is None
    assert skipped == [RUNS_IN_THE_TOOL]


def test_an_omnikrux_alert_imports_without_items():
    imported, skipped = import_alert(
        m4_alert(), panel=panel_with_queries("A"), panel_title="Latency", contact_points_by_name={}
    )
    assert (imported, skipped) == (m4_alert(), [])


def test_an_import_fills_m4_defaults():
    imported, skipped = import_alert(
        {"name": "Down", "query": "A", "op": "below", "threshold": 1},
        panel=panel_with_queries("A"),
        panel_title="Latency",
        contact_points_by_name={},
    )
    assert skipped == []
    assert imported == m4_alert(
        name="Down", op="below", threshold=1, message="", severity="warning"
    )


def test_an_import_names_a_contact_point_once():
    imported, skipped = import_alert(
        m4_alert(notify=[{"name": "Ops Slack"}, {"name": "Ops Slack"}]),
        panel=panel_with_queries("A"),
        panel_title="Latency",
        contact_points_by_name={"Ops Slack": "cp-9"},
    )
    assert skipped == []
    assert imported["notify"] == ["cp-9"]


def test_an_unnamed_contact_point_in_a_file_is_dropped_in_words():
    imported, skipped = import_alert(
        m4_alert(notify=["cp-1", {"id": "cp-2"}, {"name": 3}]),
        panel=panel_with_queries("A"),
        panel_title="Latency",
        contact_points_by_name={"cp-1": "cp-1"},
    )
    assert imported["notify"] == []
    assert (
        skipped
        == [
            SkippedItem(
                'Alert on panel "Latency"',
                "A contact point",
                "The file doesn't name it. Pick contact points in the panel's Alert tab.",
            )
        ]
        * 3
    )


def test_an_alert_that_does_not_fit_is_skipped_in_words():
    imported, skipped = import_alert(
        m4_alert(op="sideways", notify=[{"name": "Ops Slack"}]),
        panel=panel_with_queries("A"),
        panel_title="Latency",
        contact_points_by_name={"Ops Slack": "cp-9"},
    )
    assert imported is None
    assert skipped == [
        SkippedItem(
            'Alert on panel "Latency"',
            "The alert",
            "It doesn't fit OmniKrux alerts: op: Use one of: above, below.",
        )
    ]


@pytest.mark.parametrize(
    "alert",
    [
        "loud",
        ["a"],
        m4_alert(engine="grafana"),
        m4_alert(channel={"receiver": "x"}),
        m4_alert(query="B"),
    ],
)
def test_a_hostile_alert_never_raises(alert):
    imported, skipped = import_alert(
        alert, panel=panel_with_queries("A"), panel_title="Latency", contact_points_by_name={}
    )
    assert imported is None
    assert skipped[-1].what == "The alert"
    assert skipped[-1].reason.startswith("It doesn't fit OmniKrux alerts: ")


# --- update from source ---------------------------------------------------------------------


def test_an_update_keeps_where_the_alert_runs_and_who_it_tells():
    current = m4_alert(
        notify=["cp-1"],
        engine="tool",
        channel={"receiver": "team-api", "labels": {}},
        every="5m",
        threshold=0.5,
    )
    incoming = m4_alert(threshold=0.8, op="below", name="Renamed", severity="critical")
    merged = merge_alert(current, incoming)
    assert merged == m4_alert(
        notify=["cp-1"],
        engine="tool",
        channel={"receiver": "team-api", "labels": {}},
        every="5m",
        threshold=0.8,
        op="below",
        name="Renamed",
        severity="critical",
    )
    assert current["threshold"] == 0.5 and incoming["engine"] == "omnikrux"
    validate_panel_alert(merged, panel_with_queries("A"))  # does not raise


def test_a_non_list_notify_is_dropped_in_words():
    imported, skipped = import_alert(
        m4_alert(notify="Ops Slack"),
        panel=panel_with_queries("A"),
        panel_title="Latency",
        contact_points_by_name={"Ops Slack": "cp-9"},
    )
    assert imported == m4_alert(notify=[])
    assert skipped == [
        SkippedItem(
            'Alert on panel "Latency"',
            "A contact point",
            "The file doesn't name it. Pick contact points in the panel's Alert tab.",
        )
    ]
    imported, again = import_alert(
        m4_alert(notify=None),
        panel=panel_with_queries("A"),
        panel_title="Latency",
        contact_points_by_name={},
    )
    assert (imported, again) == (m4_alert(notify=[]), skipped)


def test_a_refusal_names_the_field_when_there_is_one():
    imported, skipped = import_alert(
        m4_alert(notify=[], threshold="high"),
        panel=panel_with_queries("A"),
        panel_title="Latency",
        contact_points_by_name={},
    )
    assert imported is None
    assert skipped[-1].reason.startswith("It doesn't fit OmniKrux alerts: threshold: ")


def test_an_update_keeps_a_local_severity_and_message_the_source_does_not_set():
    silent = replace(DRAFT, reducer="last", severity=None, message=None)
    incoming, skipped = alert_from_draft(silent, panel=panel_with_queries("A"))
    assert skipped is None
    assert (incoming["severity"], incoming["message"]) == ("warning", "")
    current = m4_alert(severity="critical", message="Call the API team", threshold=0.5)
    merged = merge_alert(current, incoming, draft=silent)
    assert merged == m4_alert(severity="critical", message="Call the API team", threshold=0.3)
    blank = replace(silent, severity="  ", message="")
    assert merge_alert(current, incoming, draft=blank) == merged


def test_an_update_takes_a_severity_and_message_the_source_sets():
    loud = replace(DRAFT, reducer="last", severity="info", message="Slow again")
    incoming, _ = alert_from_draft(loud, panel=panel_with_queries("A"))
    current = m4_alert(severity="critical", message="Call the API team")
    merged = merge_alert(current, incoming, draft=loud)
    assert (merged["severity"], merged["message"]) == ("info", "Slow again")
    # without a draft (an OmniKrux file sets every field), everything comes from the source
    silent = replace(loud, severity=None, message=None)
    incoming, _ = alert_from_draft(silent, panel=panel_with_queries("A"))
    merged = merge_alert(current, incoming)
    assert (merged["severity"], merged["message"]) == ("warning", "")


def test_a_new_alert_from_a_silent_source_gets_the_defaults():
    silent = replace(DRAFT, reducer="last", severity=None, message=None)
    incoming, skipped = alert_from_draft(silent, panel=panel_with_queries("A"))
    assert skipped is None
    assert merge_alert(None, incoming, draft=silent) == m4_alert(message="")


def test_an_update_without_a_current_alert_takes_the_source():
    incoming = m4_alert()
    assert merge_alert(None, incoming) == incoming
    assert merge_alert(None, incoming) is not incoming


def test_an_update_whose_source_dropped_the_alert_drops_it():
    assert merge_alert(m4_alert(notify=["cp-1"]), None) is None


# --- counting -------------------------------------------------------------------------------


def test_count_alerts():
    doc = {
        "panels": [
            panel_with_queries("A") | {"alert": m4_alert()},
            panel_with_queries("A") | {"alert": None},
            panel_with_queries("A"),
            panel_with_queries("A") | {"alert": m4_alert()},
        ]
    }
    assert count_alerts(doc) == 2
    assert count_alerts({"panels": []}) == 0
    assert count_alerts({}) == 0
