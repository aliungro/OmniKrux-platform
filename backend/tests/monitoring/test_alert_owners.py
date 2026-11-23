"""Owners that change or go away: targets follow a group's members and a project's links (and a
deleted source), a project or group delete takes its alert rules with it (one audit record
each, Loki ruler rules removed first), and a rule still applied in a cluster blocks the delete
until it is removed there."""

from omnikrux.monitoring.alerts.api import NOT_CHECKED_OFF
from omnikrux.monitoring.alerts.engine import no_source_copy
from omnikrux.monitoring.alerts.store import ToolObject
from omnikrux.monitoring.alerts.sync import AlertChange
from omnikrux.monitoring.projects.types import ReviewChanged
from tests.monitoring.test_rules_api import (
    add_group,
    add_rule,
    as_tool,
    monitoring_records,
    rule_body,
)

API = "/api/monitoring"
RULES = f"{API}/alerts/rules"
REVIEW_CHANGED = "Something changed since the review. Review it again."


def group_rule(group_id: str, **over) -> dict:
    return rule_body(group_id, scope={"kind": "group", "id": group_id}, **over)


async def targets_by_project(http, rule_id: str) -> dict[str, dict]:
    rule = (await http.get(f"{RULES}/{rule_id}")).json()
    return {t["project_name"]: t for t in rule["targets"]}


async def applied_in_cluster(alerts, target_id: str, source_id: str, cluster_id: str) -> None:
    """The target's PrometheusRule is applied in the cluster (as Task 10 records it)."""
    await alerts.set_tool(
        target_id,
        tool_state="in_sync",
        tool_message=None,
        tool_object=ToolObject("prometheus_rule", source_id, cluster_id, "monitoring", "r"),
        applied_version=1,
    )


async def test_group_membership_moves_targets(monitoring_app, two_projects_on_one_source):
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    pair = two_projects_on_one_source
    c = await http.post(
        f"{API}/setup",
        json={
            "name": "Team C",
            "kind": "custom",
            "sources": [{"source_id": pair.source_id, "filter": 'cluster="c"'}],
        },
    )
    assert c.status_code == 201, c.text
    c_id = c.json()["id"]
    group = await add_group(http, "Ops", [pair.a, pair.b])
    checked = (await add_rule(http, group_rule(group, name="Checked here")))["rule"]
    as_tool(app)
    in_tool = (await add_rule(http, group_rule(group, name="In the tool", engine="tool")))["rule"]

    joined = await http.patch(f"{API}/groups/{group}", json={"project_ids": [pair.a, pair.b, c_id]})
    assert joined.status_code == 200, joined.text
    for rule in (checked, in_tool):
        found = await targets_by_project(http, rule["id"])
        assert sorted(found) == ["Team A", "Team B", "Team C"]
        assert found["Team C"]["rule_text"] == '(rate(x{cluster="c"}[5m])\n) > 0.3'
        assert found["Team C"]["leaving"] is False

    tool_a = (await targets_by_project(http, in_tool["id"]))["Team A"]
    await applied_in_cluster(alerts, tool_a["id"], pair.source_id, "c-1")
    checked_a = (await targets_by_project(http, checked["id"]))["Team A"]

    left = await http.patch(f"{API}/groups/{group}", json={"project_ids": [pair.b, c_id]})
    assert left.status_code == 200, left.text
    # Checked by OmniKrux: gone at once.
    found = await targets_by_project(http, checked["id"])
    assert sorted(found) == ["Team B", "Team C"]
    assert all(t.id != checked_a["id"] for t in await alerts.targets())
    # Applied in a cluster: it stays, leaving, until its removal is reviewed.
    found = await targets_by_project(http, in_tool["id"])
    assert found["Team A"]["id"] == tool_a["id"]
    assert found["Team A"]["leaving"] is True
    assert found["Team A"]["tool_state"] == "needs_review"
    assert found["Team B"]["leaving"] is False and found["Team C"]["leaving"] is False


async def test_project_delete_waits_for_cluster_rules(
    monitoring_app, fake_api, kube_cluster, linked_project
):
    http, app = monitoring_app
    services = app.state.monitoring
    pid = linked_project.project_id
    cluster = (await app.state.registry.get(kube_cluster)).name
    as_tool(app)
    rule = (await add_rule(http, rule_body(pid, engine="tool")))["rule"]
    plain = (await add_rule(http, rule_body(pid, name="Disk full")))["rule"]
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
                "alert": {"name": "Panel says", "query": "A", "op": "below", "threshold": 1},
            }
        ],
    }
    board = await http.post(
        f"{API}/dashboards", json={"owner_kind": "project", "owner_id": pid, "spec": spec}
    )
    assert board.status_code == 201, board.text
    [target] = rule["targets"]
    await applied_in_cluster(services.alerts, target["id"], linked_project.source_id, kube_cluster)

    review = (await http.get(f"{API}/projects/{pid}/delete-review")).json()
    assert [r["name"] for r in review["alert_rules"]] == [
        "API latency high",
        "Disk full",
        "Panel says",
    ]
    assert review["cluster_rules"] == [{"id": rule["id"], "name": "API latency high"}]
    refused = await http.delete(f"{API}/projects/{pid}", params={"token": review["token"]})
    assert refused.status_code == 409
    assert refused.json() == {
        "detail": (
            f"Remove its rules that run in {cluster} first: API latency high. "
            "Each opens its own review."
        )
    }
    assert (await http.get(f"{API}/projects/{pid}")).status_code == 200
    assert len((await http.get(RULES)).json()) == 3
    assert not [r for r in await monitoring_records(http) if r["action"] == "project_remove"]

    # Removed from the cluster (Task 10's review): the delete review is a new one.
    await services.alerts.delete_target(target["id"])
    stale = await http.delete(f"{API}/projects/{pid}", params={"token": review["token"]})
    assert stale.status_code == 409 and stale.json() == {"detail": REVIEW_CHANGED}
    fresh = (await http.get(f"{API}/projects/{pid}/delete-review")).json()
    assert "cluster_rules" not in fresh and len(fresh["alert_rules"]) == 3
    gone = await http.delete(f"{API}/projects/{pid}", params={"token": fresh["token"]})
    assert gone.status_code == 204, gone.text
    assert (await http.get(RULES)).json() == []
    assert await services.alerts.targets() == []
    assert (await http.get(f"{RULES}/{plain['id']}")).status_code == 404

    records = await monitoring_records(http)
    removes = [
        (r["action"], r["name"], r["outcome"], r["details"])
        for r in records
        if r["action"] in ("project_remove", "dashboard_remove", "alert_rule_remove")
    ]
    with_project = {"scope": "project", "scope_name": "Shop", "with": "project"}
    assert removes[-5:] == [
        ("project_remove", "Shop", "succeeded", {"sources_removed": [], "groups_left": []}),
        (
            "dashboard_remove",
            "Latency",
            "succeeded",
            {"owner": "project", "owner_name": "Shop", "versions": 1, "with": "project"},
        ),
        ("alert_rule_remove", "API latency high", "succeeded", with_project),
        ("alert_rule_remove", "Disk full", "succeeded", with_project),
        ("alert_rule_remove", "Panel says", "succeeded", with_project),
    ]


async def test_project_delete_takes_its_targets_in_group_rules(
    monitoring_app, two_projects_on_one_source
):
    http, _ = monitoring_app
    pair = two_projects_on_one_source
    group = await add_group(http, "Both", [pair.a, pair.b])
    rule = (await add_rule(http, group_rule(group)))["rule"]
    review = (await http.get(f"{API}/projects/{pair.a}/delete-review")).json()
    # The group's rule stays with the group: only Team A's target goes.
    assert "alert_rules" not in review and "cluster_rules" not in review
    gone = await http.delete(f"{API}/projects/{pair.a}", params={"token": review["token"]})
    assert gone.status_code == 204, gone.text
    assert list(await targets_by_project(http, rule["id"])) == ["Team B"]


async def test_group_delete_takes_its_rules(monitoring_app, two_projects_on_one_source):
    http, _ = monitoring_app
    pair = two_projects_on_one_source
    group = await add_group(http, "Both", [pair.a, pair.b])
    rule = (await add_rule(http, group_rule(group)))["rule"]
    own = (await add_rule(http, rule_body(pair.a, name="Team A only")))["rule"]

    review = (await http.get(f"{API}/groups/{group}/delete-review")).json()
    assert review["alert_rules"] == [{"id": rule["id"], "name": "API latency high"}]
    assert "cluster_rules" not in review
    tokenless = await http.delete(f"{API}/groups/{group}")
    assert tokenless.status_code == 409 and tokenless.json() == {"detail": REVIEW_CHANGED}
    assert len((await http.get(RULES)).json()) == 2

    gone = await http.delete(f"{API}/groups/{group}", params={"token": review["token"]})
    assert gone.status_code == 204, gone.text
    assert [r["id"] for r in (await http.get(RULES)).json()] == [own["id"]]
    [record] = [r for r in await monitoring_records(http) if r["action"] == "alert_rule_remove"]
    assert record["details"] == {"scope": "group", "scope_name": "Both", "with": "group"}


async def test_group_delete_waits_for_cluster_rules(monitoring_app, two_projects_on_one_source):
    http, app = monitoring_app
    pair = two_projects_on_one_source
    group = await add_group(http, "Both", [pair.a, pair.b])
    as_tool(app)
    rule = (await add_rule(http, group_rule(group, engine="tool")))["rule"]
    await applied_in_cluster(
        app.state.monitoring.alerts, rule["targets"][0]["id"], pair.source_id, "c-unknown"
    )
    review = (await http.get(f"{API}/groups/{group}/delete-review")).json()
    assert review["cluster_rules"] == [{"id": rule["id"], "name": "API latency high"}]
    refused = await http.delete(f"{API}/groups/{group}", params={"token": review["token"]})
    assert refused.status_code == 409
    assert refused.json() == {
        "detail": (
            "Remove its rules that run in a cluster first: API latency high. "
            "Each opens its own review."
        )
    }
    assert [g["id"] for g in (await http.get(f"{API}/groups")).json()] == [group]


class _Loki:
    """A ToolSync whose Loki ruler answers as told: removals (leaving copies) fail from the
    `fail_from`-th on (counting from 1) with `fail`; writes always succeed."""

    def __init__(self, fail: str | None, fail_from: int = 1) -> None:
        self.fail = fail
        self.fail_from = fail_from
        self.asked: list[str] = []
        self.written: list[str] = []

    async def after_change(self, target, rule):
        if not target.leaving:
            self.written.append(target.id)
            kind, message = "written", None
        else:
            self.asked.append(target.id)
            failing = self.fail is not None and len(self.asked) >= self.fail_from
            kind, message = ("failed", self.fail) if failing else ("removed", None)
        return AlertChange(
            target_id=target.id,
            rule_id=rule.id,
            rule_name=rule.name,
            project_id=target.project_id,
            project_name="Shop",
            kind=kind,
            message=message,
        )


async def loki_rule(http, services, shop, name: str) -> dict:
    """A Loki rule of the project whose ruler rule is written (as Task 11 records it)."""
    rule = (
        await add_rule(
            http,
            rule_body(
                shop.project_id,
                name=name,
                source={"type": "loki", "id": None},
                expr='sum(count_over_time({app="api"} |= "error" [5m]))',
                engine="tool",
            ),
        )
    )["rule"]
    [target] = rule["targets"]
    assert target["tool"] == "loki_ruler"
    await services.alerts.set_tool(
        target["id"],
        tool_state="in_sync",
        tool_message=None,
        tool_object=ToolObject("loki_ruler", shop.loki_source_id, None, "omnikrux", "g"),
        applied_version=1,
    )
    return rule


async def test_a_loki_removal_that_fails_stops_the_project_delete(
    monitoring_app, linked_project_with_loki
):
    http, app = monitoring_app
    services = app.state.monitoring
    shop = linked_project_with_loki
    pid = shop.project_id
    rule = (
        await add_rule(
            http,
            rule_body(
                pid,
                name="Errors",
                source={"type": "loki", "id": None},
                expr='sum(count_over_time({app="api"} |= "error" [5m]))',
            ),
        )
    )["rule"]
    [target] = rule["targets"]
    await services.alerts.set_tool(
        target["id"],
        tool_state="in_sync",
        tool_message=None,
        tool_object=ToolObject("loki_ruler", shop.loki_source_id, None, "omnikrux", "g"),
        applied_version=1,
    )
    loki = _Loki("Loki answered HTTP 500.")
    services.alert_sync.tool_sync = loki
    review = (await http.get(f"{API}/projects/{pid}/delete-review")).json()
    assert [r["name"] for r in review["alert_rules"]] == ["Errors"]

    refused = await http.delete(f"{API}/projects/{pid}", params={"token": review["token"]})
    assert refused.status_code == 502
    assert refused.json() == {
        "detail": (
            'Couldn\'t remove the rule "Errors" from Loki: Loki answered HTTP 500. '
            "Nothing was deleted."
        )
    }
    assert loki.asked == [target["id"]]
    assert (await http.get(f"{API}/projects/{pid}")).status_code == 200
    assert [r["id"] for r in (await http.get(RULES)).json()] == [rule["id"]]
    removes = [r for r in await monitoring_records(http) if r["action"].endswith("_remove")]
    assert {r["outcome"] for r in removes} == {"failed"}

    loki.fail = None
    gone = await http.delete(f"{API}/projects/{pid}", params={"token": review["token"]})
    assert gone.status_code == 204, gone.text
    assert (await http.get(RULES)).json() == []


async def test_unlinked_source_turns_targets_into_errors(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid, sid = linked_project.project_id, linked_project.source_id
    rule = (await add_rule(http, rule_body(pid)))["rule"]
    assert rule["targets"][0]["state"] == "waiting"  # not checked yet

    unlinked = await http.delete(f"{API}/projects/{pid}/sources/{sid}")
    assert unlinked.status_code == 204
    [target] = (await http.get(f"{RULES}/{rule['id']}")).json()["targets"]
    assert target["state"] == "error"
    assert target["message"] == no_source_copy("Shop", "prometheus")
    assert target["rule_text"] == ""

    linked = await http.put(f"{API}/projects/{pid}/sources/{sid}", json={"filter": 'cluster="z"'})
    assert linked.status_code == 200, linked.text
    [target] = (await http.get(f"{RULES}/{rule['id']}")).json()["targets"]
    assert target["state"] == "waiting" and target["message"] == NOT_CHECKED_OFF
    assert target["rule_text"] == '(rate(x{cluster="z"}[5m])\n) > 0.3'


async def test_a_deleted_source_leaves_its_projects_rules_without_one(
    monitoring_app, linked_project
):
    http, _ = monitoring_app
    pid, sid = linked_project.project_id, linked_project.source_id
    rule = (await add_rule(http, rule_body(pid)))["rule"]
    review = (await http.get(f"{API}/sources/{sid}/delete-review")).json()
    gone = await http.delete(f"{API}/sources/{sid}", params={"token": review["token"]})
    assert gone.status_code == 204, gone.text
    [target] = (await http.get(f"{RULES}/{rule['id']}")).json()["targets"]
    assert target["state"] == "error"
    assert target["message"] == no_source_copy("Shop", "prometheus")


async def test_rules_taken_out_of_loki_are_written_back_when_the_delete_stops(
    monitoring_app, linked_project_with_loki, monkeypatch
):
    http, app = monitoring_app
    services = app.state.monitoring
    shop = linked_project_with_loki
    pid = shop.project_id
    as_tool(app, "loki_ruler")
    first = await loki_rule(http, services, shop, "Errors")
    second = await loki_rule(http, services, shop, "Warnings")
    loki = _Loki("Loki answered HTTP 500.", fail_from=2)
    services.alert_sync.tool_sync = loki
    review = (await http.get(f"{API}/projects/{pid}/delete-review")).json()

    refused = await http.delete(f"{API}/projects/{pid}", params={"token": review["token"]})
    assert refused.status_code == 502
    assert refused.json() == {
        "detail": (
            'Couldn\'t remove the rule "Warnings" from Loki: Loki answered HTTP 500. '
            "Nothing was deleted. "
            "1 alert rule had been taken out of Loki and is being written back."
        )
    }
    first_target = first["targets"][0]["id"]
    assert loki.asked == [first_target, second["targets"][0]["id"]]
    # Taken out, so never "in sync" again until it is written back: and it is handed back.
    [target] = (await http.get(f"{RULES}/{first['id']}")).json()["targets"]
    assert target["tool_state"] == "needs_review" and target["state"] == "not_applied"
    assert loki.written == [first_target]
    [kept] = (await http.get(f"{RULES}/{second['id']}")).json()["targets"]
    assert kept["tool_state"] == "in_sync"
    assert (await http.get(f"{API}/projects/{pid}")).status_code == 200

    # The review changes between the removals and the delete's transaction: the same, in its
    # own words.
    async def changed_meanwhile(*args, **kwargs):
        raise ReviewChanged()

    monkeypatch.setattr(services.projects, "delete", changed_meanwhile)
    loki.fail, loki.asked, loki.written = None, [], []
    await services.alerts.set_tool(
        target["id"],
        tool_state="in_sync",
        tool_message=None,
        tool_object=ToolObject("loki_ruler", shop.loki_source_id, None, "omnikrux", "g"),
        applied_version=1,
    )
    stale = await http.delete(f"{API}/projects/{pid}", params={"token": review["token"]})
    assert stale.status_code == 409
    assert stale.json() == {
        "detail": (
            "Something changed since the review. Review it again. Nothing was deleted. "
            "2 alert rules had been taken out of Loki and are being written back."
        )
    }
    assert sorted(loki.written) == sorted([first_target, second["targets"][0]["id"]])


async def test_setting_up_a_project_brings_its_rules_up_to_date(monitoring_app, monkeypatch):
    http, app = monitoring_app
    sync = app.state.monitoring.alert_sync
    asked: list[tuple[str, str]] = []
    real = sync.reconcile_scope

    async def reconcile_scope(kind, id):
        asked.append((kind, id))
        return await real(kind, id)

    monkeypatch.setattr(sync, "reconcile_scope", reconcile_scope)
    made = await http.post(f"{API}/setup", json={"name": "Fresh", "kind": "custom"})
    assert made.status_code == 201, made.text
    assert asked == [("project", made.json()["id"])]
