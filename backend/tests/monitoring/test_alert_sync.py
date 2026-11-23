"""Where rules run: one target per project of the scope with that project's own source and
filter, targets that follow the projects, tool targets that don't flap, and the capability
cache."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from functools import partial

from fastapi.testclient import TestClient

from omnikrux.config import Settings
from omnikrux.main import create_app
from omnikrux.monitoring.alerts.engine import no_source_copy
from omnikrux.monitoring.alerts.store import HistoryRecord, RuleSpec
from omnikrux.monitoring.alerts.sync import UNKNOWN_CAPABILITY
from omnikrux.monitoring.alerts.types import Condition, Engine
from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.sources.capability import CapabilityCache, CapabilityUnknown
from omnikrux.monitoring.sources.connector import AlertingCapability, ConnectorRegistry
from omnikrux.monitoring.sources.transport import SourceUnreachable
from tests.monitoring.conftest import new_source


def spec(scope_kind: str, scope_id: str, *, engine: Engine = "omnikrux", **over) -> RuleSpec:
    values = {
        "name": "Errors",
        "scope_kind": scope_kind,
        "scope_id": scope_id,
        "source_type": "prometheus",
        "source_id": None,
        "expr": 'sum by (route) (rate(errors{job="api"}[5m]))',
        "condition": Condition("each", "above", 1, 300, 60),
        "engine": engine,
    }
    return RuleSpec(**(values | over))


async def test_each_project_gets_its_own_filter(monitoring_app, two_projects_on_one_source):
    _, app = monitoring_app
    services = app.state.monitoring
    pair = two_projects_on_one_source
    group = await services.groups.create("Both", [pair.a, pair.b])
    rule = await services.alerts.create_rule(spec("group", group.id))

    first, second = await services.alert_sync.desired(rule)
    texts = {first.project_id: first.rule_text, second.project_id: second.rule_text}
    assert texts[pair.a] == ('(sum by (route) (rate(errors{job="api",cluster="a"}[5m]))\n) > 1')
    assert 'cluster="b"' not in texts[pair.a]
    assert 'cluster="b"' in texts[pair.b] and 'cluster="a"' not in texts[pair.b]
    # OmniKrux runs the query as written: `run_query` adds the project's filter at each check.
    assert first.eval_expr == second.eval_expr == rule.expr
    assert {first.source_id, second.source_id} == {pair.source_id}

    total = replace(rule, condition=Condition("total", "below", 0.5, 0, 60))
    [a_spec] = [s for s in await services.alert_sync.desired(total) if s.project_id == pair.a]
    assert a_spec.eval_expr == f"sum({rule.expr}\n)"
    assert a_spec.rule_text.startswith("sum(sum by (route)") and a_spec.rule_text.endswith(
        "\n) < 0.5"
    )


async def test_alertmanager_links_never_become_targets(
    monitoring_app, fake_prometheus, fake_alertmanager
):
    _, app = monitoring_app
    services = app.state.monitoring
    manager = await services.sources.create(
        new_source(type="alertmanager", url=fake_alertmanager.url, name="Alerts")
    )
    prometheus = await services.sources.create(new_source(url=fake_prometheus.url))
    both = await services.projects.create("Both", "custom", None)
    early = datetime(2026, 1, 1, tzinfo=UTC)
    await services.projects.link(both.id, manager.id, (), "none", created_at=early)
    await services.projects.link(both.id, prometheus.id, (Matcher("cluster", "=", "x"),), "user")
    only = await services.projects.create("Only alerts", "custom", None)
    await services.projects.link(only.id, manager.id, (), "none")

    named = await services.alerts.create_rule(
        spec("project", both.id, source_id=manager.id, name="Named")
    )
    [target] = [s for s in await services.alert_sync.desired(named)]
    assert target.source_id == prometheus.id and 'cluster="x"' in target.rule_text

    rule = await services.alerts.create_rule(spec("project", only.id))
    await services.alert_sync.reconcile_rule(rule.id)
    [stored] = await services.alerts.targets(rule_id=rule.id)
    assert stored.source_id is None and stored.state == "error"
    assert stored.message == no_source_copy("Only alerts", "prometheus")


async def test_targets_follow_group_membership(monitoring_app, two_projects_on_one_source):
    http, app = monitoring_app
    services = app.state.monitoring
    alerts, sync = services.alerts, services.alert_sync
    pair = two_projects_on_one_source
    group = await services.groups.create("Both", [pair.a, pair.b])
    rule = await alerts.create_rule(spec("group", group.id))
    assert await sync.reconcile_rule(rule.id) == []
    by_project = {t.project_id: t for t in await alerts.targets(rule_id=rule.id)}
    gone = by_project[pair.b]
    await alerts.add_history(
        [
            HistoryRecord(
                id=None,
                target_id=gone.id,
                rule_id=rule.id,
                project_id=pair.b,
                at=datetime.now(UTC) - timedelta(minutes=1),
                kind="firing",
                labels={"route": "/b"},
                value=2.0,
            )
        ]
    )

    await services.groups.update(group.id, project_ids=[pair.a])
    changes = await sync.reconcile_scope("group", group.id)
    assert [(c.project_name, c.kind) for c in changes] == [("Team B", "removed")]
    [left] = await alerts.targets(rule_id=rule.id)
    assert left.project_id == pair.a
    # Its history stays as history; it never reads as a current state.
    got = (await http.get(f"/api/monitoring/alerts/rules/{rule.id}")).json()
    assert [t["project_name"] for t in got["targets"]] == ["Team A"]
    history = (await http.get(f"/api/monitoring/alerts/rules/{rule.id}/history")).json()
    assert [(h["project_name"], h["kind"]) for h in history] == [("Team B", "firing")]
    assert (await http.get("/api/monitoring/alerts/overview")).json()["firing"] == []

    await services.groups.update(group.id, project_ids=[pair.a, pair.b])
    assert await sync.reconcile_scope("project", pair.b) == []
    assert {t.project_id for t in await alerts.targets(rule_id=rule.id)} == {pair.a, pair.b}


async def test_a_tool_target_stays_while_its_tool_cant_be_read(
    monitoring_app, two_projects_on_one_source
):
    _, app = monitoring_app
    services = app.state.monitoring
    alerts, sync = services.alerts, services.alert_sync
    pair = two_projects_on_one_source
    group = await services.groups.create("Both", [pair.a])
    answer: dict = {"capability": AlertingCapability(True, "prometheus_rule", None)}

    async def get(source, *, refresh=False):
        if isinstance(answer["capability"], Exception):
            raise answer["capability"]
        return answer["capability"]

    services.capabilities.get = get
    rule = await alerts.create_rule(spec("group", group.id, engine="tool"))
    [change] = await sync.reconcile_rule(rule.id)
    assert change.kind == "review" and change.project_name == "Team A"

    answer["capability"] = CapabilityUnknown("Shared didn't answer within 10 s.")
    await services.groups.update(group.id, project_ids=[pair.a, pair.b])
    await sync.reconcile_rule(rule.id, changed=True)
    by_project = {t.project_id: t for t in await alerts.targets(rule_id=rule.id)}
    kept, new = by_project[pair.a], by_project[pair.b]
    assert kept.engine == "tool" and kept.tool_kind == "prometheus_rule"
    assert new.engine == "omnikrux" and new.engine_note == UNKNOWN_CAPABILITY.format(
        source="Shared", message="Shared didn't answer within 10 s."
    )


class _Counting:
    type = "prometheus"
    label = "Prometheus"
    language = "promql"

    def __init__(self) -> None:
        self.calls = 0
        self.fail = False

    async def alerting(self, t, *, cluster):
        self.calls += 1
        if self.fail:
            raise SourceUnreachable("timeout", "It took too long.")
        return AlertingCapability(True, None, "Not here.")


class _Transports:
    def for_source(self, source):
        return None


async def test_capability_cache_remembers_only_what_it_read(monitoring_app, fake_prometheus):
    _, app = monitoring_app
    source = await app.state.monitoring.sources.create(new_source(url=fake_prometheus.url))
    connector = _Counting()
    registry = ConnectorRegistry()
    registry.register(connector)
    clock = [100.0]
    cache = CapabilityCache(registry, _Transports(), None, None, ttl=300.0, clock=lambda: clock[0])

    first = await cache.get(source)
    assert first == AlertingCapability(True, None, "Not here.")
    await cache.get(source)
    assert connector.calls == 1
    await cache.get(replace(source, updated_at=source.updated_at + timedelta(seconds=1)))
    assert connector.calls == 2
    clock[0] += 301
    connector.fail = True
    try:
        await cache.get(source)
    except CapabilityUnknown as exc:
        assert exc.message == "It took too long." and exc.status == 504
    else:
        raise AssertionError("a failed read must raise")
    connector.fail = False
    await cache.get(source)
    assert connector.calls == 4  # the failure wasn't remembered
    await cache.get(source, refresh=True)
    assert connector.calls == 5


def test_startup_reconciles_every_rule(tmp_path):
    settings = Settings(data_dir=tmp_path, kubeconfig="", in_container=False, alert_engine=False)
    with TestClient(create_app(settings)) as client:
        services = client.app.state.monitoring
        source = client.post(
            "/api/monitoring/sources",
            json={
                "type": "prometheus",
                "reach": "url",
                "url": "http://p.example:9090",
                "name": "P",
            },
        ).json()
        project = client.post(
            "/api/monitoring/setup",
            json={
                "name": "Shop",
                "kind": "custom",
                "sources": [{"source_id": source["id"], "filter": 'cluster="a"'}],
            },
        ).json()
        portal = client.portal

        rule = portal.call(services.alerts.create_rule, spec("project", project["id"]))
        removed = portal.call(services.alerts.create_rule, spec("project", project["id"]))
        portal.call(services.alerts.tombstone_rule, removed.id)
        assert portal.call(services.alerts.targets) == []

    with TestClient(create_app(settings)) as client:
        services = client.app.state.monitoring
        [target] = client.portal.call(services.alerts.targets)
        assert target.rule_id == rule.id and 'cluster="a"' in target.rule_text
        rules = client.portal.call(partial(services.alerts.list_rules, include_deleted=True))
        assert [r.id for r in rules] == [rule.id]
