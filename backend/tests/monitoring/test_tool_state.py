"""The state of rules that run in a tool, read back from Prometheus's rules API, the Loki ruler
and the project's Alertmanager: honest when the tool can't be read, and each target reading
only its own group, rule and project."""

import asyncio
import time
from datetime import timedelta

from omnikrux.monitoring.alerts.engine import AlertEngine
from omnikrux.monitoring.alerts.store import HistoryRecord, ToolObject
from omnikrux.monitoring.alerts.tool import state_reader
from omnikrux.monitoring.models import now
from tests.monitoring.alert_env import until
from tests.monitoring.test_loki_ruler import loki_body
from tests.monitoring.test_rules_api import add_rule, as_tool, rule_body

API = "/api/monitoring"
RULES = f"{API}/alerts/rules"
MIN = timedelta(minutes=1)


async def prometheus_target(http, app, shop, **over) -> tuple[dict, dict]:
    """A rule that runs in Prometheus, applied (as Task 10 records it) a moment ago."""
    as_tool(app)
    rule = (await add_rule(http, rule_body(shop.project_id, engine="tool", **over)))["rule"]
    [target] = rule["targets"]
    alerts = app.state.monitoring.alerts
    await alerts.set_tool(
        target["id"],
        tool_state="in_sync",
        tool_message=None,
        tool_object=ToolObject("prometheus_rule", shop.source_id, "c-1", "monitoring", "r"),
        applied_version=rule["version"],
    )
    await alerts.add_history(
        [
            HistoryRecord(
                id=None,
                target_id=target["id"],
                rule_id=rule["id"],
                project_id=shop.project_id,
                at=now(),
                kind="applied",
                message="Created PrometheusRule monitoring/r.",
            )
        ]
    )
    return rule, target


def own_labels(rule: dict, project_id: str, **extra) -> dict:
    return {
        "alertname": rule["name"],
        "severity": "warning",
        "omnikrux_rule": rule["id"],
        "omnikrux_project": project_id,
        **extra,
    }


def group(target_id: str, rule: dict, project_id: str, state: str, alerts: list, **over) -> dict:
    entry = {
        "type": "alerting",
        "name": rule["name"],
        "query": "x",
        "state": state,
        "health": "ok",
        "labels": {k: v for k, v in own_labels(rule, project_id).items() if k != "alertname"},
        "alerts": alerts,
    } | over
    return {"name": f"omnikrux-{target_id}", "file": "/etc/rules/r.yaml", "rules": [entry]}


def alert(labels: dict, state: str = "firing", value: str = "4.2e-01") -> dict:
    return {
        "labels": labels,
        "annotations": {},
        "state": state,
        "activeAt": "2026-11-19T09:50:00.123456789Z",
        "value": value,
    }


async def shown(http, rule_id: str) -> tuple[dict, dict]:
    rule = (await http.get(f"{RULES}/{rule_id}")).json()
    [target] = rule["targets"]
    return rule, target


async def test_prometheus_state_comes_from_the_rules_api(
    monitoring_app, linked_project, fake_prometheus
):
    http, app = monitoring_app
    reader = app.state.monitoring.tool_state
    rule, target = await prometheus_target(http, app, linked_project)
    pid = linked_project.project_id
    firing = alert(own_labels(rule, pid, route="/a"))
    stranger = dict(rule, id="other-rule")
    fake_prometheus.rule_groups = [
        group(target["id"], rule, pid, "firing", [firing]),
        # Another project's group (or another rule in it) never leaks in.
        group("another-target", stranger, "another-project", "firing", [alert({"x": "1"})]),
    ]
    moment = now()
    await reader.refresh(moment)
    [read] = [r for r in fake_prometheus.requests if r.path == "/api/v1/rules"]
    assert read.params == {"type": ["alert"]}
    out, shown_target = await shown(http, rule["id"])
    assert shown_target["state"] == "firing" and out["state"] == "firing"
    assert shown_target["last_eval_at"] is not None
    [instance] = shown_target["instances"]
    assert instance["labels"] == firing["labels"]
    assert instance["state"] == "firing" and instance["value"] == 0.42
    assert instance["active_since"].startswith("2026-11-19T09:50:00.123456")
    history = (await http.get(f"{RULES}/{rule['id']}/history")).json()
    assert [h["kind"] for h in history][:1] == ["firing"]

    # The same again: nothing new in the history. Then it stops: resolved.
    await reader.refresh(moment + MIN)
    fake_prometheus.rule_groups = [group(target["id"], rule, pid, "inactive", [])]
    await reader.refresh(moment + 2 * MIN)
    _, shown_target = await shown(http, rule["id"])
    assert shown_target["state"] == "ok" and shown_target["instances"] == []
    history = (await http.get(f"{RULES}/{rule['id']}/history")).json()
    assert [h["kind"] for h in history] == ["resolved", "firing", "applied"]

    # A rule the tool can't evaluate is an error in the tool's words.
    fake_prometheus.rule_groups = [
        group(target["id"], rule, pid, "inactive", [], health="err", lastError="bad expr")
    ]
    await reader.refresh(moment + 3 * MIN)
    _, shown_target = await shown(http, rule["id"])
    assert (shown_target["state"], shown_target["message"]) == ("error", "bad expr")

    # Loaded but never evaluated: still waiting, never "OK".
    fake_prometheus.rule_groups = [
        group(target["id"], rule, pid, "inactive", [], health="unknown", lastError="")
    ]
    await reader.refresh(moment + 4 * MIN)
    _, shown_target = await shown(http, rule["id"])
    assert (shown_target["state"], shown_target["message"]) == (
        "waiting",
        "Loading in Prometheus…",
    )


async def test_a_tool_that_has_not_run_the_rule_yet_keeps_its_firing_alerts(
    monitoring_app, linked_project, fake_prometheus
):
    http, app = monitoring_app
    reader = app.state.monitoring.tool_state
    rule, target = await prometheus_target(http, app, linked_project)
    pid = linked_project.project_id
    firing = alert(own_labels(rule, pid, route="/a"))
    fake_prometheus.rule_groups = [group(target["id"], rule, pid, "firing", [firing])]
    moment = now()
    await reader.refresh(moment)
    _, before = await shown(http, rule["id"])
    [was] = before["instances"]

    # Prometheus restarted: the rule is loaded but not evaluated yet, with no alerts.
    fake_prometheus.rule_groups = [
        group(target["id"], rule, pid, "inactive", [], health="unknown", lastError="")
    ]
    await reader.refresh(moment + MIN)
    _, during = await shown(http, rule["id"])
    assert (during["state"], during["message"]) == ("waiting", "Loading in Prometheus…")
    assert during["instances"] == [was]  # unknown, not resolved
    history = (await http.get(f"{RULES}/{rule['id']}/history")).json()
    assert [h["kind"] for h in history] == ["firing", "applied"]

    # Its first evaluation finds it still firing: it carries on, told once, since unchanged.
    fake_prometheus.rule_groups = [group(target["id"], rule, pid, "firing", [firing])]
    await reader.refresh(moment + 2 * MIN)
    _, after = await shown(http, rule["id"])
    assert after["state"] == "firing"
    assert [i["fired_at"] for i in after["instances"]] == [was["fired_at"]]
    history = (await http.get(f"{RULES}/{rule['id']}/history")).json()
    assert [h["kind"] for h in history] == ["firing", "applied"]
    fake_prometheus.rule_groups = [group(target["id"], rule, pid, "inactive", [])]
    await reader.refresh(moment + 3 * MIN)
    history = (await http.get(f"{RULES}/{rule['id']}/history")).json()
    assert [h["kind"] for h in history] == ["resolved", "firing", "applied"]


async def test_loading_then_not_loaded(monitoring_app, linked_project, fake_prometheus):
    http, app = monitoring_app
    reader = app.state.monitoring.tool_state
    rule, target = await prometheus_target(http, app, linked_project)
    [applied] = await app.state.monitoring.alerts.history(rule_id=rule["id"])
    assert applied.kind == "applied" and applied.target_id == target["id"]
    applied_at = applied.at

    await reader.refresh(applied_at + 2 * MIN)
    _, shown_target = await shown(http, rule["id"])
    assert (shown_target["state"], shown_target["message"]) == (
        "waiting",
        "Loading in Prometheus…",
    )
    await reader.refresh(applied_at + 11 * MIN)
    _, shown_target = await shown(http, rule["id"])
    assert (shown_target["state"], shown_target["message"]) == (
        "error",
        "Prometheus hasn't loaded this rule. Check that its ruleSelector matches.",
    )


async def test_loki_state_comes_from_the_ruler(monitoring_app, linked_project_with_loki, fake_loki):
    http, app = monitoring_app
    reader = app.state.monitoring.tool_state
    shop = linked_project_with_loki
    rule = (await add_rule(http, loki_body(shop.project_id)))["rule"]
    [target] = rule["targets"]
    assert target["state"] == "waiting"
    applied_at = (await app.state.monitoring.alerts.history(rule_id=rule["id"]))[0].at

    await reader.refresh(applied_at + 11 * MIN)
    _, shown_target = await shown(http, rule["id"])
    assert (shown_target["state"], shown_target["message"]) == (
        "error",
        "Loki hasn't loaded this rule. Check the ruler's configuration.",
    )
    pending = alert(own_labels(rule, shop.project_id, app="api"), state="pending", value="12")
    fake_loki.rule_states = [group(target["id"], rule, shop.project_id, "pending", [pending])]
    await reader.refresh(applied_at + 12 * MIN)
    _, shown_target = await shown(http, rule["id"])
    assert shown_target["state"] == "pending" and shown_target["message"] is None
    [instance] = shown_target["instances"]
    assert instance["state"] == "pending" and instance["value"] == 12.0
    assert any(r.path == "/prometheus/api/v1/rules" for r in fake_loki.requests)

    # Inside the target's own group, a rule or an alert labelled for another rule or project is
    # never read as this target's.
    own = group(target["id"], rule, shop.project_id, "inactive", [])
    foreign_rule = dict(rule, id="another-rule")
    stranger = group(target["id"], foreign_rule, shop.project_id, "firing", [])["rules"][0]
    stranger["alerts"] = [alert(own_labels(foreign_rule, shop.project_id))]
    own["rules"][0]["alerts"] = [alert(own_labels(rule, "another-project", app="api"))]
    own["rules"].append(stranger)
    fake_loki.rule_states = [own]
    await reader.refresh(applied_at + 13 * MIN)
    _, shown_target = await shown(http, rule["id"])
    assert shown_target["state"] == "ok" and shown_target["instances"] == []


async def test_unreadable_tool_is_cant_check(monitoring_app, linked_project, fake_prometheus):
    http, app = monitoring_app
    reader = app.state.monitoring.tool_state
    rule, target = await prometheus_target(http, app, linked_project)
    pid = linked_project.project_id
    firing = alert(own_labels(rule, pid, route="/a"))
    fake_prometheus.rule_groups = [group(target["id"], rule, pid, "firing", [firing])]
    moment = now()
    await reader.refresh(moment)

    fake_prometheus.mode = "error500"
    await reader.refresh(moment + MIN)
    out, shown_target = await shown(http, rule["id"])
    assert shown_target["state"] == "unreachable" and out["state"] == "unreachable"
    assert shown_target["message"] == "Shop answered HTTP 500. Try again, or check the tool."
    # Can't check: the firing instance stays as it was, never resolved by the failure.
    [instance] = shown_target["instances"]
    assert instance["state"] == "firing"
    history = (await http.get(f"{RULES}/{rule['id']}/history")).json()
    assert "resolved" not in [h["kind"] for h in history]
    overview = (await http.get(f"{API}/alerts/overview")).json()
    assert overview["counts"]["cant_check"] == 1 and overview["counts"]["firing"] == 0

    fake_prometheus.mode = "ok"
    await reader.refresh(moment + 2 * MIN)
    _, shown_target = await shown(http, rule["id"])
    assert shown_target["state"] == "firing" and shown_target["message"] is None


async def test_alertmanager_marks_silenced(
    monitoring_app, linked_project, fake_prometheus, fake_alertmanager
):
    http, app = monitoring_app
    reader = app.state.monitoring.tool_state
    pid = linked_project.project_id
    am = await http.post(
        f"{API}/sources",
        json={"type": "alertmanager", "reach": "url", "url": fake_alertmanager.url, "name": "AM"},
    )
    assert am.status_code == 201, am.text
    linked = await http.put(f"{API}/projects/{pid}/sources/{am.json()['id']}", json={"filter": ""})
    assert linked.status_code == 200, linked.text
    rule, target = await prometheus_target(http, app, linked_project)
    quiet = own_labels(rule, pid, route="/a")
    loud = own_labels(rule, pid, route="/b")
    fake_prometheus.rule_groups = [
        group(target["id"], rule, pid, "firing", [alert(quiet), alert(loud)])
    ]
    # Alertmanager adds labels of its own (an external label here).
    fake_alertmanager.alerts = [
        {
            "labels": quiet | {"prometheus": "monitoring/k8s"},
            "status": {"state": "suppressed", "silencedBy": ["s-1"], "inhibitedBy": []},
        },
        {"labels": loud, "status": {"state": "active", "silencedBy": [], "inhibitedBy": []}},
    ]
    await reader.refresh(now())
    _, shown_target = await shown(http, rule["id"])
    silenced = {i["labels"]["route"]: i["silenced"] for i in shown_target["instances"]}
    assert silenced == {"/a": True, "/b": False}
    [asked] = [r for r in fake_alertmanager.requests if r.path == "/api/v2/alerts"]
    # One read for the project's rules; each target keeps only its own rule's alerts.
    assert sorted(asked.params["filter"]) == sorted(
        ['omnikrux_rule=~".+"', f'omnikrux_project=~"{pid}"']
    )

    # An Alertmanager that can't be read leaves the marks as they were.
    fake_alertmanager.mode = "error500"
    await reader.refresh(now())
    _, shown_target = await shown(http, rule["id"])
    assert {i["labels"]["route"]: i["silenced"] for i in shown_target["instances"]} == silenced


async def test_the_engine_reads_the_tools_only_when_it_runs(monitoring_app):
    _, app = monitoring_app
    services = app.state.monitoring
    asked: list = []

    async def refresh(moment):
        asked.append(moment)

    services.tool_state.refresh = refresh
    off = AlertEngine(services, enabled=False)
    off.start()
    await asyncio.sleep(0.05)
    assert asked == []
    await off.stop()

    on = AlertEngine(services, enabled=True)
    on._tick_seconds = 0.01
    on.start()
    try:
        await until(lambda: len(asked) == 1)
        await asyncio.sleep(0.05)
        assert len(asked) == 1  # every 30 s, not every tick
    finally:
        await on.stop()


async def test_one_dead_alertmanager_costs_one_timeout_per_refresh(
    monitoring_app, linked_project, fake_prometheus, fake_alertmanager, monkeypatch
):
    http, app = monitoring_app
    reader = app.state.monitoring.tool_state
    pid = linked_project.project_id
    am = await http.post(
        f"{API}/sources",
        json={"type": "alertmanager", "reach": "url", "url": fake_alertmanager.url, "name": "AM"},
    )
    assert am.status_code == 201, am.text
    linked = await http.put(f"{API}/projects/{pid}/sources/{am.json()['id']}", json={"filter": ""})
    assert linked.status_code == 200, linked.text
    made = [await prometheus_target(http, app, linked_project, name=f"Rule {n}") for n in range(5)]
    fake_prometheus.rule_groups = [
        group(target["id"], rule, pid, "firing", [alert(own_labels(rule, pid, route="/a"))])
        for rule, target in made
    ]
    monkeypatch.setattr(state_reader, "READ_SECONDS", 0.5)
    fake_alertmanager.mode = "hang"  # never answers
    started = time.monotonic()
    await reader.refresh(now())
    # One read of the Alertmanager for all five rules, bounded by one timeout.
    assert time.monotonic() - started < 2.0
    assert len([r for r in fake_alertmanager.requests if r.path == "/api/v2/alerts"]) == 1
    for rule, _ in made:
        _, shown_target = await shown(http, rule["id"])
        assert shown_target["state"] == "firing"
        assert [i["silenced"] for i in shown_target["instances"]] == [False]
    fake_alertmanager.release.set()
