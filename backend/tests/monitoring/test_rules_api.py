"""The rules API: rules on projects and groups, one target per project with that project's
filter, conflicts in words, every change audited first, and the overview."""

from datetime import UTC, datetime, timedelta

from omnikrux.audit.store import AuditUnavailable
from omnikrux.monitoring.alerts.api import NOT_CHECKED_OFF
from omnikrux.monitoring.alerts.engine import no_source_copy
from omnikrux.monitoring.alerts.store import InstanceRecord, RuleSpec, ToolObject
from omnikrux.monitoring.alerts.types import Condition
from omnikrux.monitoring.sources.connector import NO_OPERATOR, AlertingCapability
from tests.fakekube import prometheus_operator
from tests.monitoring.conftest import new_source

API = "/api/monitoring"
ALERTS = f"{API}/alerts"
RULES = f"{ALERTS}/rules"
CONTACT_POINTS = f"{ALERTS}/contact-points"
RULE_CHANGED = (
    "This rule was changed somewhere else since you opened it (version {}). Open it again."
)


def rule_body(scope_id: str, **over) -> dict:
    body = {
        "name": "API latency high",
        "scope": {"kind": "project", "id": scope_id},
        "source": {"type": "prometheus", "id": None},
        "expr": "rate(x[5m])",
        "condition": {"op": "above", "threshold": 0.3, "for": "5m", "every": "1m"},
    }
    return body | over


async def add_rule(http, body: dict) -> dict:
    r = await http.post(RULES, json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def add_group(http, name: str, project_ids: list[str]) -> str:
    r = await http.post(f"{API}/groups", json={"name": name, "project_ids": project_ids})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def monitoring_records(http) -> list[dict]:
    records = (await http.get("/api/audit")).json()["records"]
    return [r for r in reversed(records) if r["app"] == "monitoring"]


def refusal(r) -> tuple[int, str, str]:
    detail = r.json()["detail"]
    return r.status_code, detail["code"], detail["message"]


def as_tool(app, tool: str = "prometheus_rule") -> None:
    """Every source's tool can run rules (no cluster needed for the test)."""

    async def get(source, *, refresh=False):
        return AlertingCapability(True, tool, None)

    app.state.monitoring.capabilities.get = get


async def test_create_a_project_rule_and_read_it_back(monitoring_app, linked_project, fake_webhook):
    http, _ = monitoring_app
    pid = linked_project.project_id
    cp = await http.post(
        CONTACT_POINTS,
        json={"name": "Ops hook", "type": "webhook", "secrets": {"url": f"{fake_webhook.url}/h"}},
    )
    assert cp.status_code == 201, cp.text
    cp_id = cp.json()["id"]

    out = await add_rule(http, rule_body(pid, contact_point_ids=[cp_id]))
    assert out["changes"] == []
    rule = out["rule"]
    assert rule["name"] == "API latency high" and rule["version"] == 1
    assert rule["scope"] == {"kind": "project", "id": pid, "name": "Shop"}
    assert rule["condition"] == {
        "of": "each",
        "op": "above",
        "threshold": 0.3,
        "for": "5m",
        "every": "1m",
    }
    assert rule["contact_points"] == [{"id": cp_id, "name": "Ops hook", "type": "webhook"}]
    # Not checked yet (never "OK" before a first check).
    assert rule["state"] == "waiting" and rule["removing"] is False and rule["origin"] == "page"
    [target] = rule["targets"]
    assert target["project_id"] == pid and target["project_name"] == "Shop"
    assert target["engine"] == "omnikrux" and target["tool"] is None
    assert target["where"] == "checked by OmniKrux"
    assert target["eval_expr"] == "rate(x[5m])"
    # The condition is wrapped first, then the project's filter goes into every selector.
    assert target["rule_text"] == '(rate(x{cluster="a"}[5m])\n) > 0.3'
    assert target["state"] == "waiting" and target["leaving"] is False
    assert target["message"] == NOT_CHECKED_OFF  # this app's checks are off

    read = await http.get(f"{RULES}/{rule['id']}")
    assert read.status_code == 200 and read.json() == rule
    assert (await http.get(RULES)).json() == [rule]
    assert (await http.get(RULES, params={"scope_kind": "group"})).json() == []
    assert (await http.get(f"{RULES}/{rule['id']}/history")).json() == []

    [record] = [r for r in await monitoring_records(http) if r["action"] == "alert_rule_add"]
    assert record["kind"] == "alert_rule" and record["name"] == "API latency high"
    assert record["outcome"] == "succeeded"
    assert record["details"] == {
        "scope": "project",
        "scope_name": "Shop",
        "engine": "omnikrux",
        "severity": "warning",
        "condition": "above 0.3 for 5m every 1m",
        "contact_points": ["Ops hook"],
    }
    assert "rate(x" not in (await http.get("/api/audit")).text


async def test_builtins_are_placed_and_other_names_refused(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    out = await add_rule(http, rule_body(pid, expr="rate(x[$__rate_interval])"))
    assert out["rule"]["expr"] == "rate(x[4m])"

    r = await http.post(RULES, json=rule_body(pid, expr="rate(x{job=$job}[5m])"))
    assert r.status_code == 422
    assert r.json()["detail"] == {
        "code": "invalid_rule",
        "message": "Uses $job, which isn't a variable here. Write the value into the query.",
        "field": "query",
    }
    r = await http.post(RULES, json=rule_body(pid, expr="rate(x[$__range])"))
    assert r.json()["detail"]["field"] == "query"


async def test_rule_validation_copy(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id

    gone = await http.post(RULES, json=rule_body("nope"))
    assert refusal(gone) == (404, "unknown_scope", "That project or group no longer exists.")
    cp = await http.post(RULES, json=rule_body(pid, contact_point_ids=["cp-gone"]))
    assert refusal(cp) == (
        422,
        "invalid_rule",
        "That contact point no longer exists. Pick another.",
    )
    assert cp.json()["detail"]["field"] == "contact_point_ids"
    channel = await http.post(RULES, json=rule_body(pid, channel={"receiver": "ops"}))
    assert refusal(channel) == (
        422,
        "invalid_rule",
        "A channel is only for alerts that run in the tool.",
    )
    name = await http.post(RULES, json=rule_body(pid, name="two\nlines"))
    assert refusal(name)[2] == "Use 1 to 120 characters, without line breaks."
    for_ = await http.post(
        RULES, json=rule_body(pid, condition={"op": "above", "threshold": 1, "for": "2d"})
    )
    assert refusal(for_)[2] == "Use a duration from 0s to 24h, like 5m."
    assert for_.json()["detail"]["field"] == "for"
    assert (await http.get(RULES)).json() == []
    assert [r for r in await monitoring_records(http) if r["action"] == "alert_rule_add"] == []


async def test_a_rule_is_not_checked_yet_until_its_first_check(monitoring_app, linked_project):
    """A new OmniKrux target reads "waiting" with when its first check runs, never "ok"; its
    first check's answer is what it shows after that."""
    http, app = monitoring_app
    services = app.state.monitoring
    services.engine.enabled = True  # the words with checks on (nothing runs: no loop started)
    rule = (await add_rule(http, rule_body(linked_project.project_id)))["rule"]
    [target] = rule["targets"]
    assert (rule["state"], target["state"]) == ("waiting", "waiting")
    assert target["message"] == "Not checked yet: the first check runs within 1 min."
    overview = (await http.get(f"{ALERTS}/overview")).json()
    assert overview["counts"]["firing"] == 0 and overview["counts"]["cant_check"] == 0

    await services.alerts.set_eval(
        target["id"], state="ok", message=None, at=datetime.now(UTC), next_eval_at=None, failures=0
    )
    [target] = (await http.get(f"{RULES}/{rule['id']}")).json()["targets"]
    assert (target["state"], target["message"]) == ("ok", None)

    # A paused rule says paused, not "not checked yet".
    paused = (await add_rule(http, rule_body(linked_project.project_id, name="Other")))["rule"]
    r = await http.post(f"{RULES}/{paused['id']}/pause")
    assert r.status_code == 200, r.text
    [target] = r.json()["targets"]
    assert (target["state"], target["message"]) == ("paused", None)


async def test_group_rule_fans_out_per_project(monitoring_app, linked_project):
    http, app = monitoring_app
    services = app.state.monitoring
    billing = await services.projects.create("Billing", "custom", None)
    group = await add_group(http, "Ops", [linked_project.project_id, billing.id])

    out = await add_rule(http, rule_body(group, scope={"kind": "group", "id": group}))
    rule = out["rule"]
    assert rule["scope"] == {"kind": "group", "id": group, "name": "Ops"}
    b, a = rule["targets"]
    assert (b["project_name"], a["project_name"]) == ("Billing", "Shop")
    assert a["state"] == "waiting" and a["rule_text"] == '(rate(x{cluster="a"}[5m])\n) > 0.3'
    # Billing has no Prometheus: an error in words, never OK, and no other project's filter.
    assert b["state"] == "error" and b["message"] == no_source_copy("Billing", "prometheus")
    assert b["rule_text"] == "" and "cluster" not in b["eval_expr"]
    assert rule["state"] == "error"

    overview = (await http.get(f"{ALERTS}/overview")).json()
    assert overview["counts"] == {
        "rules": 1,
        "firing": 0,
        "firing_unsilenced": 0,
        "pending": 0,
        "cant_check": 1,
        "not_applied": 0,
    }
    assert overview["firing"] == [] and overview["by_project"] == {} and overview["by_group"] == {}
    assert overview["engine"]["enabled"] is False


async def test_tool_engine_where_possible(
    monitoring_app, fake_api, kube_cluster, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    prometheus_operator(fake_api)
    fake_api.service_backends[("monitoring", "kps-prometheus:9090")] = fake_prometheus.url
    source = await http.post(
        f"{API}/sources",
        json={
            "type": "prometheus",
            "reach": "cluster",
            "cluster_id": kube_cluster,
            "namespace": "monitoring",
            "service": "kps-prometheus",
            "port": "9090",
            "name": "In cluster",
        },
    )
    assert source.status_code == 201, source.text
    project = await http.post(
        f"{API}/setup",
        json={
            "name": "Apps",
            "kind": "custom",
            "sources": [{"source_id": source.json()["id"], "filter": 'cluster="c"'}],
        },
    )
    assert project.status_code == 201, project.text
    apps = project.json()["id"]
    group = await add_group(http, "Ops", [apps, linked_project.project_id])

    out = await add_rule(
        http, rule_body(group, scope={"kind": "group", "id": group}, engine="tool")
    )
    a, b = out["rule"]["targets"]
    assert a["project_id"] == apps and a["engine"] == "tool" and a["tool"] == "prometheus_rule"
    assert a["where"] == "in Prometheus" and a["tool_state"] == "needs_review"
    assert a["state"] == "not_applied" and a["engine_note"] is None
    assert a["rule_text"] == '(rate(x{cluster="c"}[5m])\n) > 0.3'
    assert b["engine"] == "omnikrux" and b["tool"] is None and b["engine_note"] == NO_OPERATOR
    assert b["where"] == "checked by OmniKrux" and b["tool_state"] is None
    assert out["changes"] == [
        {
            "target_id": a["id"],
            "rule_id": out["rule"]["id"],
            "rule_name": "API latency high",
            "project_id": apps,
            "project_name": "Apps",
            "kind": "review",
            "message": None,
            "tool": "prometheus_rule",
        }
    ]
    assert out["rule"]["state"] == "not_applied"

    caps = await http.get(
        f"{ALERTS}/capabilities",
        params={"scope_kind": "group", "scope_id": group, "source_type": "prometheus"},
    )
    assert caps.status_code == 200, caps.text
    assert [(c["project_name"], c["tool"], c["reason"]) for c in caps.json()] == [
        ("Apps", "prometheus_rule", None),
        ("Shop", None, NO_OPERATOR),
    ]


async def test_rule_state_is_the_worst_target(monitoring_app, two_projects_on_one_source):
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    pair = two_projects_on_one_source
    group = await add_group(http, "Both", [pair.a, pair.b])
    rule = (await add_rule(http, rule_body(group, scope={"kind": "group", "id": group})))["rule"]
    a, b = (t["id"] for t in rule["targets"])
    at = datetime.now(UTC)

    async def set_state(target_id: str, state: str, firing: bool = False) -> None:
        await alerts.set_eval(
            target_id, state=state, message=None, at=at, next_eval_at=None, failures=0
        )
        items = []
        if firing:
            items = [
                InstanceRecord(
                    target_id=target_id,
                    fingerprint="f1",
                    labels={"route": "/a"},
                    state="firing",
                    active_since=at - timedelta(minutes=10),
                    fired_at=at - timedelta(minutes=5),
                    value=0.4,
                    last_notified_at=None,
                )
            ]
        await alerts.replace_instances(target_id, items)

    await set_state(a, "firing", firing=True)
    await set_state(b, "unreachable")
    got = (await http.get(f"{RULES}/{rule['id']}")).json()
    assert got["state"] == "firing"
    assert got["firing_since"] is not None
    overview = (await http.get(f"{ALERTS}/overview")).json()
    assert overview["counts"]["firing"] == 1 and overview["by_project"] == {pair.a: 1}
    assert overview["by_group"] == {group: 1}

    await set_state(a, "ok")
    await set_state(b, "unreachable")
    got = (await http.get(f"{RULES}/{rule['id']}")).json()
    assert got["state"] == "unreachable" and got["firing_since"] is None
    assert (await http.get(f"{ALERTS}/overview")).json()["counts"]["cant_check"] == 1


async def test_stale_rule_save_is_refused(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    rule = (await add_rule(http, rule_body(pid)))["rule"]
    changed = rule_body(pid, condition={"op": "above", "threshold": 0.5}) | {"base_version": 1}
    saved = await http.put(f"{RULES}/{rule['id']}", json=changed)
    assert saved.status_code == 200, saved.text
    assert saved.json()["rule"]["version"] == 2
    [target] = saved.json()["rule"]["targets"]
    assert target["rule_text"] == '(rate(x{cluster="a"}[5m])\n) > 0.5'

    stale = await http.put(
        f"{RULES}/{rule['id']}", json=rule_body(pid, name="Other") | {"base_version": 1}
    )
    assert stale.status_code == 409
    assert stale.json()["detail"] == {
        "code": "rule_changed",
        "message": RULE_CHANGED.format(2),
        "current_version": 2,
    }
    assert (await http.get(f"{RULES}/{rule['id']}")).json()["name"] == "API latency high"
    actions = [r["action"] for r in await monitoring_records(http)]
    assert actions.count("alert_rule_change") == 1


async def test_panel_rules_are_changed_on_their_panel(monitoring_app, linked_project):
    http, app = monitoring_app
    services = app.state.monitoring
    pid = linked_project.project_id
    spec = {
        "schemaVersion": 1,
        "title": "Latency",
        "panels": [
            {
                "id": "p-1",
                "type": "stat",
                "title": "p95",
                "layout": {"x": 0, "y": 0, "w": 6, "h": 4},
                "queries": [
                    {"ref": "A", "source": {"type": "prometheus", "id": None}, "expr": "up"}
                ],
            }
        ],
    }
    dashboard = await http.post(
        f"{API}/dashboards", json={"owner_kind": "project", "owner_id": pid, "spec": spec}
    )
    assert dashboard.status_code == 201, dashboard.text
    rule = await services.alerts.create_rule(
        RuleSpec(
            name="p95 high",
            scope_kind="project",
            scope_id=pid,
            source_type="prometheus",
            source_id=None,
            expr="up",
            condition=Condition("each", "above", 1, 0, 60),
            origin="panel",
            dashboard_id=dashboard.json()["id"],
            panel_id="p-1",
        )
    )
    await services.alert_sync.reconcile_rule(rule.id)
    got = (await http.get(f"{RULES}/{rule.id}")).json()
    assert got["panel"] == {
        "dashboard_id": dashboard.json()["id"],
        "dashboard_title": "Latency",
        "panel_id": "p-1",
        "panel_title": "p95",
    }
    words = 'This rule belongs to the panel "p95" on "Latency". Change it there.'
    put = await http.put(f"{RULES}/{rule.id}", json=rule_body(pid) | {"base_version": 1})
    assert refusal(put) == (409, "panel_rule", words)
    review = (await http.get(f"{RULES}/{rule.id}/delete-review")).json()
    assert review["panel"]["panel_title"] == "p95"
    # Deleting it goes through its dashboard (Task 9, test_panel_alerts.py); this panel's
    # document carries no alert, so only the rule goes.
    gone = await http.delete(f"{RULES}/{rule.id}", params={"token": review["token"]})
    assert gone.status_code == 200, gone.text
    assert gone.json()["rule"] is None
    assert (await http.get(f"{RULES}/{rule.id}")).status_code == 404


async def test_pause_is_for_omnikrux_rules_only(monitoring_app, linked_project):
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    pid = linked_project.project_id
    rule = (await add_rule(http, rule_body(pid)))["rule"]

    paused = await http.post(f"{RULES}/{rule['id']}/pause")
    assert paused.status_code == 200, paused.text
    assert paused.json()["paused"] is True and paused.json()["state"] == "paused"
    assert paused.json()["targets"][0]["state"] == "paused"
    assert await alerts.due_targets(datetime.now(UTC) + timedelta(days=1)) == []

    resumed = await http.post(f"{RULES}/{rule['id']}/resume")
    assert resumed.status_code == 200 and resumed.json()["paused"] is False
    # The rule is written after its targets, so the engine sees the pause.
    stored = await alerts.get_rule(rule["id"])
    [target] = await alerts.targets(rule_id=rule["id"])
    assert stored.updated_at > target.updated_at
    records = [r for r in await monitoring_records(http) if r["action"] == "alert_rule_change"]
    assert [r["details"]["paused"] for r in records] == [True, False]

    as_tool(app)
    tool = (await add_rule(http, rule_body(pid, name="In the tool", engine="tool")))["rule"]
    assert tool["targets"][0]["engine"] == "tool"
    refused = await http.post(f"{RULES}/{tool['id']}/pause")
    assert refusal(refused) == (
        409,
        "tool_rule",
        "This rule runs in the tool, which keeps checking it. Silence it instead.",
    )


async def test_delete_review_lists_cluster_removals(monitoring_app, two_projects_on_one_source):
    http, app = monitoring_app
    services = app.state.monitoring
    pair = two_projects_on_one_source
    group = await add_group(http, "Both", [pair.a, pair.b])
    as_tool(app)
    rule = (
        await add_rule(http, rule_body(group, scope={"kind": "group", "id": group}, engine="tool"))
    )["rule"]
    a, _ = rule["targets"]
    # Team A's rule is applied in a cluster; Team B's never reached its tool.
    await services.alerts.set_tool(
        a["id"],
        tool_state="in_sync",
        tool_message=None,
        tool_object=ToolObject("prometheus_rule", pair.source_id, "c-gone", "monitoring", "r"),
        applied_version=1,
    )
    review = await http.get(f"{RULES}/{rule['id']}/delete-review")
    assert review.status_code == 200, review.text
    body = review.json()
    assert body["cluster_removals"] == [
        {"target_id": a["id"], "project_name": "Team A", "cluster_name": None}
    ]
    assert body["loki_removals"] == [] and body["panel"] is None

    stale = await http.delete(f"{RULES}/{rule['id']}", params={"token": "x"})
    assert refusal(stale) == (
        409,
        "rule_changed",
        "Something changed since the review. Review it again.",
    )

    gone = await http.delete(f"{RULES}/{rule['id']}", params={"token": body["token"]})
    assert gone.status_code == 200, gone.text
    out = gone.json()
    assert [(c["project_name"], c["kind"]) for c in out["changes"]] == [
        ("Team A", "review"),
        ("Team B", "removed"),
    ]
    assert out["rule"]["removing"] is True
    [left] = out["rule"]["targets"]
    assert left["id"] == a["id"] and left["leaving"] is True
    assert left["tool_state"] == "needs_review"
    listed = (await http.get(RULES)).json()
    assert [(r["id"], r["removing"]) for r in listed] == [(rule["id"], True)]
    assert (await http.get(f"{ALERTS}/overview")).json()["counts"]["rules"] == 0
    [record] = [r for r in await monitoring_records(http) if r["action"] == "alert_rule_remove"]
    assert record["details"]["cluster_removals"] == ["Team A"]

    # Once the cluster's rule is removed (Task 10), the rule goes too.
    await services.alerts.delete_target(a["id"])
    await services.alert_sync.reconcile_rule(rule["id"])
    assert (await http.get(f"{RULES}/{rule['id']}")).status_code == 404
    assert (await http.get(RULES)).json() == []


async def test_overview_lists_firing_with_summary(monitoring_app, linked_project):
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    pid = linked_project.project_id
    rule = (await add_rule(http, rule_body(pid, message="p95 for {{route}} is {{value}}")))["rule"]
    [target] = rule["targets"]
    at = datetime.now(UTC)
    fired = at - timedelta(minutes=12, seconds=5)
    await alerts.set_eval(
        target["id"], state="firing", message=None, at=at, next_eval_at=None, failures=0
    )
    await alerts.replace_instances(
        target["id"],
        [
            InstanceRecord(
                target_id=target["id"],
                fingerprint="f1",
                labels={"route": "/a"},
                state="firing",
                active_since=fired - timedelta(minutes=5),
                fired_at=fired,
                value=0.4,
                last_notified_at=None,
            )
        ],
    )
    overview = (await http.get(f"{ALERTS}/overview")).json()
    [firing] = overview["firing"]
    assert firing["summary"] == "p95 for /a is 0.4 · for 12 min · warning"
    assert firing["rule_id"] == rule["id"] and firing["target_id"] == target["id"]
    assert firing["project_name"] == "Shop" and firing["instances"] == 1
    assert firing["where"] == "checked by OmniKrux" and firing["severity"] == "warning"
    assert overview["counts"]["firing"] == 1 and overview["by_project"] == {pid: 1}
    got = (await http.get(f"{RULES}/{rule['id']}")).json()
    [instance] = got["targets"][0]["instances"]
    assert instance["message"] == "p95 for /a is 0.4" and instance["value"] == 0.4


async def test_overview_counts_silenced_firing_instances(monitoring_app, linked_project):
    """A silence mutes notifications only: the rule still fires (and is counted), and the
    overview says how many of its firing instances are silenced."""
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    pid = linked_project.project_id
    rule = (await add_rule(http, rule_body(pid)))["rule"]
    [target] = rule["targets"]
    at = datetime.now(UTC)
    await alerts.set_eval(
        target["id"], state="firing", message=None, at=at, next_eval_at=None, failures=0
    )

    def instance(fingerprint: str, silenced: bool) -> InstanceRecord:
        return InstanceRecord(
            target_id=target["id"],
            fingerprint=fingerprint,
            labels={"route": fingerprint},
            state="firing",
            active_since=at - timedelta(minutes=5),
            fired_at=at - timedelta(minutes=4),
            value=0.4,
            last_notified_at=None,
            silenced=silenced,
        )

    await alerts.replace_instances(target["id"], [instance("/a", True), instance("/b", False)])
    overview = (await http.get(f"{ALERTS}/overview")).json()
    [firing] = overview["firing"]
    assert (firing["instances"], firing["silenced"]) == (2, 1)
    assert overview["counts"]["firing"] == 1 and overview["by_project"] == {pid: 1}

    await alerts.replace_instances(target["id"], [instance("/a", True), instance("/b", True)])
    [firing] = (await http.get(f"{ALERTS}/overview")).json()["firing"]
    assert (firing["instances"], firing["silenced"]) == (2, 2)
    got = (await http.get(f"{RULES}/{rule['id']}")).json()
    assert got["state"] == "firing"
    assert [i["silenced"] for i in got["targets"][0]["instances"]] == [True, True]


async def test_channels_without_alertmanager_say_where_notifications_go(
    monitoring_app, linked_project
):
    http, _ = monitoring_app
    r = await http.get(f"{ALERTS}/channels", params={"project_id": linked_project.project_id})
    assert r.status_code == 200, r.text
    assert r.json() == {
        "alertmanager": None,
        "channels": [],
        "message": (
            "Notifications go wherever this Prometheus's Alertmanager sends them. "
            "Link its Alertmanager to pick a channel."
        ),
    }
    gone = await http.get(f"{ALERTS}/channels", params={"project_id": "nope"})
    assert refusal(gone)[:2] == (404, "unknown_scope")


async def test_rules_routes_refuse_cross_origin(monitoring_app):
    http, _ = monitoring_app
    evil = {"Origin": "http://evil.example"}
    for method, path in (
        ("GET", RULES),
        ("GET", f"{RULES}/x"),
        ("GET", f"{RULES}/x/history"),
        ("GET", f"{RULES}/x/delete-review"),
        ("GET", f"{ALERTS}/overview"),
        ("GET", f"{ALERTS}/capabilities"),
        ("GET", f"{ALERTS}/channels?project_id=x"),
        ("POST", RULES),
        ("PUT", f"{RULES}/x"),
        ("POST", f"{RULES}/x/pause"),
        ("POST", f"{RULES}/x/resume"),
        ("DELETE", f"{RULES}/x?token=t"),
    ):
        response = await http.request(method, path, headers=evil, json={})
        assert response.status_code == 403, (method, path)
        assert response.json() == {"detail": "Cross-origin request refused"}


async def test_no_audit_no_rule(monitoring_app, linked_project, monkeypatch):
    http, app = monitoring_app

    async def broken(entry):
        raise AuditUnavailable("disk I/O error")

    monkeypatch.setattr(app.state.audit, "begin_app", broken)
    r = await http.post(RULES, json=rule_body(linked_project.project_id))
    assert r.status_code == 503
    assert (await http.get(RULES)).json() == []
    assert await app.state.monitoring.alerts.targets() == []


async def test_fix_round_refusals_and_empty_rules(monitoring_app, linked_project):
    http, app = monitoring_app
    pid = linked_project.project_id
    long = await http.post(RULES, json=rule_body(pid, expr="x" * 10001))
    assert long.status_code == 422
    assert long.json()["detail"] == {
        "code": "invalid_rule",
        "message": "Write a query of 1 to 10000 characters.",
        "field": "query",
    }
    empty = await http.post(RULES, json=rule_body(pid, expr=""))
    assert empty.json()["detail"]["message"] == "Write a query of 1 to 10000 characters."

    # A group without projects is checked nowhere: never "ok".
    group = await add_group(http, "Empty", [])
    rule = (await add_rule(http, rule_body(group, scope={"kind": "group", "id": group})))["rule"]
    assert rule["targets"] == [] and rule["state"] == "no_data"

    other = await app.state.monitoring.sources.create(new_source(name="Not linked"))
    caps = await http.get(
        f"{ALERTS}/capabilities",
        params={
            "scope_kind": "project",
            "scope_id": pid,
            "source_type": "prometheus",
            "source_id": other.id,
        },
    )
    assert refusal(caps) == (404, "not_found", "This source isn't linked to that project.")
    linked = await http.get(
        f"{ALERTS}/capabilities",
        params={
            "scope_kind": "project",
            "scope_id": pid,
            "source_type": "prometheus",
            "source_id": linked_project.source_id,
        },
    )
    assert [c["source_id"] for c in linked.json()] == [linked_project.source_id]
    # A linked source of another type is refused, never answered about.
    other_type = await http.get(
        f"{ALERTS}/capabilities",
        params={
            "scope_kind": "project",
            "scope_id": pid,
            "source_type": "loki",
            "source_id": linked_project.source_id,
        },
    )
    assert refusal(other_type) == (
        422,
        "invalid_rule",
        "That source isn't a Loki source. Pick one that is.",
    )
