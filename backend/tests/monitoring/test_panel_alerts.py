"""Panel alerts: the rule of a panel follows its dashboard's document (created, changed, taken
off, detached when the panel or the dashboard goes, never copied, back with a restored
version), a page rule can be attached to a panel, and deleting a panel's rule (or a contact
point it names) saves the dashboard as a new version."""

import copy
from datetime import UTC, datetime, timedelta

from omnikrux.monitoring.alerts.rule_expr import rule_expr
from omnikrux.monitoring.alerts.store import InstanceRecord
from tests.monitoring.test_rules_api import (
    as_tool,
    monitoring_records,
    refusal,
    rule_body,
)

API = "/api/monitoring"
ALERTS = f"{API}/alerts"
RULES = f"{ALERTS}/rules"
DASHBOARDS = f"{API}/dashboards"
CONTACT_POINTS = f"{ALERTS}/contact-points"
CP_GONE = "That contact point no longer exists. Pick another."

ALERT = {"name": "API latency high", "query": "A", "op": "above", "threshold": 0.3, "for": "5m"}


def panel(id: str = "p-1", title: str = "p95", *, x: int = 0, alert=None, queries=None) -> dict:
    return {
        "id": id,
        "type": "timeseries",
        "title": title,
        "layout": {"x": x, "y": 0, "w": 6, "h": 4},
        "queries": queries
        or [
            {
                "ref": "A",
                "source": {"type": "prometheus", "id": None},
                "expr": "rate(x[$__rate_interval])",
            }
        ],
        "alert": alert,
    }


def board(*panels: dict, title: str = "Latency") -> dict:
    return {"schemaVersion": 1, "title": title, "panels": list(panels) or [panel()]}


async def create(http, owner_id: str, spec: dict, kind: str = "project") -> dict:
    r = await http.post(DASHBOARDS, json={"owner_kind": kind, "owner_id": owner_id, "spec": spec})
    assert r.status_code == 201, r.text
    return r.json()


async def save(http, dashboard: dict, spec: dict) -> dict:
    r = await http.put(
        f"{DASHBOARDS}/{dashboard['id']}", json={"base_version": dashboard["version"], "spec": spec}
    )
    assert r.status_code == 200, r.text
    return r.json()


async def rules(http) -> list[dict]:
    return (await http.get(RULES)).json()


async def test_saving_a_panel_alert_creates_its_rule(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    made = await create(http, pid, board())
    assert made["alert_changes"] == [] and await rules(http) == []

    saved = await save(http, made, board(panel(alert=ALERT)))
    assert saved["version"] == 2 and saved["alert_changes"] == []
    [rule] = await rules(http)
    assert rule["origin"] == "panel" and rule["name"] == "API latency high"
    assert rule["panel"] == {
        "dashboard_id": made["id"],
        "dashboard_title": "Latency",
        "panel_id": "p-1",
        "panel_title": "p95",
    }
    assert rule["scope"] == {"kind": "project", "id": pid, "name": "Shop"}
    # The panel's query with its built-ins placed at the alert's interval.
    assert rule["expr"] == rule_expr(saved["spec"], saved["spec"]["panels"][0]) == "rate(x[4m])"
    assert rule["condition"] == {
        "of": "each",
        "op": "above",
        "threshold": 0.3,
        "for": "5m",
        "every": "1m",
    }
    [target] = rule["targets"]
    assert target["project_id"] == pid and target["engine"] == "omnikrux"
    assert target["rule_text"] == '(rate(x{cluster="a"}[4m])\n) > 0.3'
    # The dashboard's save is the record: M2's details, nothing more.
    saves = [r for r in await monitoring_records(http) if r["action"] == "dashboard_save"]
    assert [r["details"] for r in saves] == [
        {"owner": "project", "owner_name": "Shop", "version": 2, "previous_version": 1, "panels": 1}
    ]


async def test_changing_the_panel_alert_changes_the_rule(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    made = await create(http, pid, board(panel(alert=ALERT)))
    [first] = await rules(http)
    assert first["version"] == 1

    changed = await save(http, made, board(panel(alert=ALERT | {"threshold": 0.5})))
    [rule] = await rules(http)
    assert rule["id"] == first["id"] and rule["version"] == 2
    assert rule["condition"]["threshold"] == 0.5
    assert rule["targets"][0]["rule_text"] == '(rate(x{cluster="a"}[4m])\n) > 0.5'

    # Saving the same alert again changes nothing about the rule.
    await save(http, changed, changed["spec"] | {"title": "Latency now"})
    [same] = await rules(http)
    assert same["id"] == first["id"] and same["version"] == 2
    assert same["panel"]["dashboard_title"] == "Latency now"


async def test_removing_the_alert_deletes_its_rule(monitoring_app, linked_project):
    http, app = monitoring_app
    made = await create(http, linked_project.project_id, board(panel(alert=ALERT)))
    [rule] = await rules(http)

    saved = await save(http, made, board(panel()))
    # The rule went as a DELETE /alerts/rules/{id} would take it: its target is removed at once.
    assert [(c["rule_id"], c["kind"]) for c in saved["alert_changes"]] == [(rule["id"], "removed")]
    assert await rules(http) == []
    assert (await http.get(f"{RULES}/{rule['id']}")).status_code == 404
    assert await app.state.monitoring.alerts.targets() == []


async def test_deleting_a_panel_rule_clears_the_panel(monitoring_app, linked_project):
    http, _ = monitoring_app
    made = await create(http, linked_project.project_id, board(panel()))
    saved = await save(http, made, board(panel(alert=ALERT), panel("p-2", "errors", x=6)))
    [rule] = await rules(http)

    review = (await http.get(f"{RULES}/{rule['id']}/delete-review")).json()
    assert review["panel"]["panel_title"] == "p95"
    gone = await http.delete(f"{RULES}/{rule['id']}", params={"token": review["token"]})
    assert gone.status_code == 200, gone.text
    assert gone.json() == {
        "rule": None,
        "changes": [
            {
                "target_id": rule["targets"][0]["id"],
                "rule_id": rule["id"],
                "rule_name": "API latency high",
                "project_id": linked_project.project_id,
                "project_name": "Shop",
                "kind": "removed",
                "message": None,
            }
        ],
    }
    now = (await http.get(f"{DASHBOARDS}/{made['id']}")).json()
    assert now["version"] == saved["version"] + 1
    assert [p["alert"] for p in now["spec"]["panels"]] == [None, None]
    assert now["spec"]["panels"][0]["queries"] == saved["spec"]["panels"][0]["queries"]
    assert await rules(http) == []

    records = await monitoring_records(http)
    tail = [(r["action"], r["name"], r["outcome"]) for r in records][-2:]
    assert tail == [
        ("alert_rule_remove", "API latency high", "succeeded"),
        ("dashboard_save", "Latency", "succeeded"),
    ]
    assert records[-1]["details"] == {
        "owner": "project",
        "owner_name": "Shop",
        "version": 3,
        "previous_version": 2,
        "panels": 2,
    }


async def test_deleting_a_panel_rule_needs_its_review(monitoring_app, linked_project):
    http, _ = monitoring_app
    made = await create(http, linked_project.project_id, board(panel(alert=ALERT)))
    [rule] = await rules(http)
    review = (await http.get(f"{RULES}/{rule['id']}/delete-review")).json()
    # The alert changes on the dashboard after the review: the rule moved on.
    await save(http, made, board(panel(alert=ALERT | {"threshold": 0.4})))
    stale = await http.delete(f"{RULES}/{rule['id']}", params={"token": review["token"]})
    assert refusal(stale) == (
        409,
        "rule_changed",
        "Something changed since the review. Review it again.",
    )
    assert len(await rules(http)) == 1
    assert (await http.get(f"{DASHBOARDS}/{made['id']}")).json()["version"] == 2


async def test_removed_panel_detaches_its_rule(monitoring_app, linked_project):
    http, _ = monitoring_app
    made = await create(http, linked_project.project_id, board(panel(alert=ALERT)))
    [rule] = await rules(http)

    await save(http, made, board(panel("p-2", "errors")))
    [kept] = await rules(http)
    assert kept["id"] == rule["id"] and kept["version"] == 2
    assert kept["origin"] == "page" and kept["panel"] is None
    assert kept["expr"] == rule["expr"]
    [target] = kept["targets"]
    assert target["id"] == rule["targets"][0]["id"] and target["leaving"] is False


async def test_deleting_a_dashboard_detaches_its_rules(monitoring_app, linked_project):
    http, _ = monitoring_app
    made = await create(
        http,
        linked_project.project_id,
        board(panel(alert=ALERT), panel("p-2", "errors", x=6, alert=ALERT | {"name": "Errors"})),
    )
    assert len(await rules(http)) == 2
    gone = await http.delete(f"{DASHBOARDS}/{made['id']}", params={"version": "1"})
    assert gone.status_code == 204
    kept = await rules(http)
    assert [(r["name"], r["origin"], r["panel"]) for r in kept] == [
        ("API latency high", "page", None),
        ("Errors", "page", None),
    ]
    assert all(len(r["targets"]) == 1 for r in kept)


async def test_copy_drops_alerts(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    made = await create(http, pid, board(panel(alert=ALERT)))
    copied = await http.post(
        f"{DASHBOARDS}/copy", json={"from_id": made["id"], "owner_kind": "project", "owner_id": pid}
    )
    assert copied.status_code == 201, copied.text
    body = copied.json()
    assert body["title"] == "Latency (copy)" and body["alert_changes"] == []
    assert [p["alert"] for p in body["spec"]["panels"]] == [None]
    assert body["spec"]["panels"][0]["queries"] == made["spec"]["panels"][0]["queries"]
    [rule] = await rules(http)
    assert rule["panel"]["dashboard_id"] == made["id"]


async def test_restore_brings_back_that_versions_alert(monitoring_app, linked_project):
    http, _ = monitoring_app
    made = await create(http, linked_project.project_id, board(panel(alert=ALERT)))
    [old] = await rules(http)
    without = await save(http, made, board(panel()))
    assert await rules(http) == []

    restored = await http.post(
        f"{DASHBOARDS}/{made['id']}/versions/1/restore", json={"base_version": without["version"]}
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["version"] == 3 and restored.json()["alert_changes"] == []
    assert restored.json()["spec"]["panels"][0]["alert"]["name"] == "API latency high"
    [rule] = await rules(http)
    assert rule["id"] != old["id"] and rule["origin"] == "panel"
    assert rule["panel"]["panel_id"] == "p-1" and rule["condition"]["threshold"] == 0.3


async def test_tool_run_panel_alert_saves_and_asks_for_review(monitoring_app, linked_project):
    http, app = monitoring_app
    pid = linked_project.project_id
    as_tool(app)  # Shop's Prometheus has the Operator
    made = await create(http, pid, board())
    saved = await save(http, made, board(panel(alert=ALERT | {"engine": "tool"})))
    assert saved["version"] == 2
    [rule] = await rules(http)
    [target] = rule["targets"]
    assert target["engine"] == "tool" and target["tool_state"] == "needs_review"
    assert saved["alert_changes"] == [
        {
            "target_id": target["id"],
            "rule_id": rule["id"],
            "rule_name": "API latency high",
            "project_id": pid,
            "project_name": "Shop",
            "kind": "review",
            "message": None,
        }
    ]
    # Reading it again says nothing new happened in the tool.
    assert (await http.get(f"{DASHBOARDS}/{made['id']}")).json()["alert_changes"] == []


async def test_unknown_contact_point_in_a_panel_alert(monitoring_app, linked_project, fake_webhook):
    http, _ = monitoring_app
    pid = linked_project.project_id
    spec = board(panel(alert=ALERT | {"notify": ["cp-gone"]}))
    for r in (
        await http.post(DASHBOARDS, json={"owner_kind": "project", "owner_id": pid, "spec": spec}),
        await http.put(
            f"{DASHBOARDS}/{(await create(http, pid, board(title='Other')))['id']}",
            json={"base_version": 1, "spec": spec | {"title": "Other"}},
        ),
    ):
        assert r.status_code == 422, r.text
        detail = r.json()["detail"]
        assert detail["code"] == "invalid_dashboard"
        assert detail["problems"] == [{"path": "panels[0].alert.notify[0]", "message": CP_GONE}]
    assert await rules(http) == []

    cp = await http.post(
        CONTACT_POINTS,
        json={"name": "Ops hook", "type": "webhook", "secrets": {"url": f"{fake_webhook.url}/h"}},
    )
    assert cp.status_code == 201, cp.text
    await create(http, pid, board(panel(alert=ALERT | {"notify": [cp.json()["id"]]})))
    [rule] = await rules(http)
    assert [c["name"] for c in rule["contact_points"]] == ["Ops hook"]


async def test_deleting_a_contact_point_saves_the_dashboards_that_name_it(
    monitoring_app, linked_project, fake_webhook
):
    http, _ = monitoring_app
    cp = await http.post(
        CONTACT_POINTS,
        json={"name": "Ops hook", "type": "webhook", "secrets": {"url": f"{fake_webhook.url}/h"}},
    )
    cp_id = cp.json()["id"]
    made = await create(
        http, linked_project.project_id, board(panel(alert=ALERT | {"notify": [cp_id]}))
    )
    [rule] = await rules(http)
    review = (await http.get(f"{CONTACT_POINTS}/{cp_id}/delete-review")).json()
    assert [r["name"] for r in review["used_by"]] == ["API latency high"]

    gone = await http.delete(f"{CONTACT_POINTS}/{cp_id}", params={"token": review["token"]})
    assert gone.status_code == 204, gone.text
    now = (await http.get(f"{DASHBOARDS}/{made['id']}")).json()
    assert now["version"] == 2
    assert now["spec"]["panels"][0]["alert"]["notify"] == []
    [after] = await rules(http)
    assert after["id"] == rule["id"] and after["contact_points"] == []

    records = await monitoring_records(http)
    tail = [(r["action"], r["name"], r["outcome"]) for r in records][-2:]
    assert tail == [
        ("contact_point_remove", "Ops hook", "succeeded"),
        ("dashboard_save", "Latency", "succeeded"),
    ]
    assert records[-1]["details"] == {
        "owner": "project",
        "owner_name": "Shop",
        "version": 2,
        "previous_version": 1,
        "panels": 1,
        "removed_contact_point": "Ops hook",
    }
    # The next save of what the editor holds now goes through.
    await save(http, now, now["spec"])


async def test_attach_a_page_rule_to_a_panel(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    up = [{"ref": "A", "source": {"type": "prometheus", "id": None}, "expr": "up"}]
    made = await create(
        http, pid, board(panel(), panel("p-2", "Up", x=6, queries=up), panel("p-3", "Logs", x=12))
    )
    # Written as the panel's query is once its built-ins are placed.
    latency = (await http.post(RULES, json=rule_body(pid, expr="rate(x[4m])"))).json()["rule"]
    errors = (
        await http.post(RULES, json=rule_body(pid, name="Errors", expr="rate(errors[5m])"))
    ).json()["rule"]

    attached = await http.post(
        f"{RULES}/{latency['id']}/attach",
        json={"dashboard_id": made["id"], "panel_id": "p-1", "base_version": 1},
    )
    assert attached.status_code == 200, attached.text
    body = attached.json()
    first = body["dashboard"]["spec"]["panels"][0]
    assert body["dashboard"]["version"] == 2 and body["dashboard"]["alert_changes"] == []
    assert first["queries"] == made["spec"]["panels"][0]["queries"]  # its query A is reused
    assert first["alert"] == {
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
    rule = body["rule"]
    assert rule["id"] == latency["id"] and rule["origin"] == "panel"
    assert rule["panel"]["panel_title"] == "p95" and rule["version"] == 2
    assert rule["targets"][0]["id"] == latency["targets"][0]["id"]

    other = await http.post(
        f"{RULES}/{errors['id']}/attach",
        json={"dashboard_id": made["id"], "panel_id": "p-2", "base_version": 2},
    )
    assert other.status_code == 200, other.text
    second = other.json()["dashboard"]["spec"]["panels"][1]
    assert [(q["ref"], q["expr"]) for q in second["queries"]] == [
        ("A", "up"),
        ("B", "rate(errors[5m])"),
    ]
    assert second["alert"]["query"] == "B"
    assert len(await rules(http)) == 2

    third = (await http.post(RULES, json=rule_body(pid, name="Third"))).json()["rule"]
    taken = await http.post(
        f"{RULES}/{third['id']}/attach",
        json={"dashboard_id": made["id"], "panel_id": "p-1", "base_version": 3},
    )
    assert refusal(taken) == (422, "invalid_rule", "That panel already has an alert.")
    stale = await http.post(
        f"{RULES}/{third['id']}/attach",
        json={"dashboard_id": made["id"], "panel_id": "p-3", "base_version": 2},
    )
    assert stale.status_code == 409 and stale.json()["detail"]["code"] == "version_conflict"
    assert stale.json()["detail"]["current_version"] == 3
    again = await http.post(
        f"{RULES}/{latency['id']}/attach",
        json={"dashboard_id": made["id"], "panel_id": "p-3", "base_version": 3},
    )
    assert refusal(again) == (
        409,
        "panel_rule",
        'This rule belongs to the panel "p95" on "Latency". Change it there.',
    )
    actions = [r["action"] for r in await monitoring_records(http)]
    assert actions.count("dashboard_save") == 2 and actions.count("alert_rule_change") == 2


async def test_attach_refusals(monitoring_app, two_projects_on_one_source):
    http, _ = monitoring_app
    pair = two_projects_on_one_source
    full = [
        {"ref": chr(65 + i), "source": {"type": "prometheus", "id": None}, "expr": f"m{i}"}
        for i in range(10)
    ]
    made = await create(http, pair.a, board(panel(queries=full)))
    mine = (await http.post(RULES, json=rule_body(pair.a))).json()["rule"]
    theirs = (await http.post(RULES, json=rule_body(pair.b))).json()["rule"]

    def attach(rule: dict, panel_id: str = "p-1"):
        return http.post(
            f"{RULES}/{rule['id']}/attach",
            json={"dashboard_id": made["id"], "panel_id": panel_id, "base_version": 1},
        )

    assert refusal(await attach(theirs)) == (
        422,
        "invalid_rule",
        "That panel is on a dashboard of another project or group.",
    )
    assert refusal(await attach(mine)) == (
        422,
        "invalid_rule",
        "That panel already has 10 queries.",
    )
    assert refusal(await attach(mine, "p-9")) == (
        422,
        "invalid_rule",
        "That panel no longer exists.",
    )
    gone = await http.post(
        f"{RULES}/{mine['id']}/attach",
        json={"dashboard_id": "nope", "panel_id": "p-1", "base_version": 1},
    )
    assert refusal(gone) == (404, "not_found", "That dashboard no longer exists.")
    assert (await http.get(f"{DASHBOARDS}/{made['id']}")).json()["version"] == 1
    assert {r["origin"] for r in await rules(http)} == {"page"}


async def test_panel_states_report_the_worst_target(monitoring_app, two_projects_on_one_source):
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    pair = two_projects_on_one_source
    group = await http.post(f"{API}/groups", json={"name": "Both", "project_ids": [pair.a, pair.b]})
    gid = group.json()["id"]
    spec = board(panel(alert=ALERT), panel("p-2", "quiet", x=6))
    made = await create(http, gid, spec, kind="group")
    assert (await http.get(f"{ALERTS}/panel-states", params={"dashboard_id": "nope"})).json() == {}

    [rule] = await rules(http)
    a, b = (t["id"] for t in rule["targets"])
    at = datetime.now(UTC)
    fired = at - timedelta(minutes=3)
    for target_id, state in ((a, "firing"), (b, "ok")):
        await alerts.set_eval(
            target_id, state=state, message=None, at=at, next_eval_at=None, failures=0
        )
    await alerts.replace_instances(
        a,
        [
            InstanceRecord(
                target_id=a,
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
    states = (await http.get(f"{ALERTS}/panel-states", params={"dashboard_id": made["id"]})).json()
    assert list(states) == ["p-1"]
    assert states["p-1"]["rule_id"] == rule["id"] and states["p-1"]["name"] == "API latency high"
    assert states["p-1"]["state"] == "firing"
    assert datetime.fromisoformat(states["p-1"]["since"]) == fired

    await alerts.replace_instances(a, [])
    await alerts.set_eval(a, state="ok", message=None, at=at, next_eval_at=None, failures=0)
    await alerts.set_eval(
        b, state="unreachable", message="down", at=at, next_eval_at=None, failures=3
    )
    states = (await http.get(f"{ALERTS}/panel-states", params={"dashboard_id": made["id"]})).json()
    assert states["p-1"]["state"] == "unreachable"
    assert datetime.fromisoformat(states["p-1"]["since"]) == at


async def test_a_crash_between_the_save_and_the_rules_converges_at_start(
    monitoring_app, linked_project
):
    http, app = monitoring_app
    services = app.state.monitoring
    pid = linked_project.project_id
    made = await create(http, pid, board())
    # The dashboard is written, then OmniKrux stops before its rules are.
    spec = copy.deepcopy(made["spec"])
    spec["panels"][0]["alert"] = (await create(http, pid, board(panel(alert=ALERT), title="B")))[
        "spec"
    ]["panels"][0]["alert"]
    await services.dashboards.save(made["id"], 1, spec)
    assert [r["panel"]["dashboard_title"] for r in await rules(http)] == ["B"]

    await services.alert_sync.reconcile_all()
    by_board = sorted(r["panel"]["dashboard_title"] for r in await rules(http))
    assert by_board == ["B", "Latency"]

    # Deleted while stopped: its rule is detached at the next start.
    await services.dashboards.delete(made["id"], 2)
    await services.alert_sync.reconcile_all()
    assert sorted(
        (r["origin"], (r["panel"] or {}).get("dashboard_title")) for r in await rules(http)
    ) == [
        ("page", None),
        ("panel", "B"),
    ]
