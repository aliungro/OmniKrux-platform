"""Alert rules, their targets, state and bounded history on a real SQLite file."""

import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import inspect

from omnikrux.db import MIGRATIONS_DIR, init_db, make_engine, make_sessionmaker
from omnikrux.monitoring.alerts import store as alert_store
from omnikrux.monitoring.alerts.store import (
    AlertStore,
    HistoryRecord,
    InstanceRecord,
    RuleChanged,
    RuleRef,
    RuleSpec,
    TargetSpec,
    ToolObject,
    UnknownRule,
    UnknownTarget,
)
from omnikrux.monitoring.alerts.types import ChannelPick, Condition
from omnikrux.monitoring.models import DeliveryRow
from omnikrux.monitoring.projects.types import review_token
from tests.monitoring.conftest import new_source
from tests.monitoring.test_dashboard_store import doc

T0 = datetime(2026, 11, 23, 12, 0, tzinfo=UTC)


def rule_spec(**over) -> RuleSpec:
    """A page rule on project "p1": p95 latency above 0.3 for 5 minutes, checked every minute.
    `over` replaces any field; `of`, `op`, `threshold`, `for_seconds` and `every_seconds` replace
    the condition's."""
    cond = {"of": "each", "op": "above", "threshold": 0.3, "for_seconds": 300, "every_seconds": 60}
    for key in list(over):
        if key in cond:
            cond[key] = over.pop(key)
    values = {
        "name": "API latency high",
        "scope_kind": "project",
        "scope_id": "p1",
        "source_type": "prometheus",
        "source_id": None,
        "expr": "histogram_quantile(0.95, rate(x[5m]))",
        "condition": Condition(**cond),
        "severity": "warning",
        "message": "p95 for {{route}} is {{value}}",
        "contact_point_ids": (),
        "engine": "omnikrux",
        "channel": None,
    }
    return RuleSpec(**(values | over))


def target_spec(project_id: str, **over) -> TargetSpec:
    values = {
        "project_id": project_id,
        "engine": "omnikrux",
        "engine_note": None,
        "source_id": f"src-{project_id}",
        "eval_expr": "rate(x[5m])",
        "rule_text": f'(rate(x{{project="{project_id}"}}[5m])) > 0.3',
        "tool_kind": None,
    }
    return TargetSpec(**(values | over))


def entry(target_id: str, rule_id: str, at: datetime, kind="firing") -> HistoryRecord:
    return HistoryRecord(
        id=None,
        target_id=target_id,
        rule_id=rule_id,
        at=at,
        kind=kind,
        labels={"route": "/a"},
        value=0.4,
        message=None,
    )


def count(db_path, table: str) -> int:
    with closing(sqlite3.connect(db_path)) as conn:
        return conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


# -- rules -------------------------------------------------------------------------------------


async def test_rule_versions_and_conflicts(stores):
    r = await stores.alerts.create_rule(rule_spec(name="API latency high"))
    r2 = await stores.alerts.update_rule(
        r.id, rule_spec(name="API latency high", threshold=0.4), base_version=1
    )
    assert (r.version, r2.version) == (1, 2)
    assert r2.condition.threshold == 0.4
    with pytest.raises(RuleChanged) as e:
        await stores.alerts.update_rule(r.id, rule_spec(threshold=0.5), base_version=1)
    assert e.value.current == 2
    assert str(e.value) == (
        "This rule was changed somewhere else since you opened it (version 2). Open it again."
    )
    assert (await stores.alerts.get_rule(r.id)).condition.threshold == 0.4


async def test_a_rule_reads_back_as_written(stores):
    spec = rule_spec(
        contact_point_ids=("cp1", "cp2"),
        engine="tool",
        channel=ChannelPick(receiver="team-a", labels={"team": "a"}),
        severity="critical",
    )
    r = await stores.alerts.create_rule(spec)
    got = await stores.alerts.get_rule(r.id)
    assert got == r
    assert got.condition == spec.condition
    assert got.contact_point_ids == ("cp1", "cp2")
    assert got.channel == ChannelPick(receiver="team-a", labels={"team": "a"})
    assert (got.paused, got.origin, got.deleted_at, got.version) == (False, "page", None, 1)
    assert len(got.id) == 32
    assert got.created_at.tzinfo is not None
    with pytest.raises(UnknownRule):
        await stores.alerts.get_rule("missing")


async def test_an_update_that_changes_nothing_keeps_the_version(stores):
    r = await stores.alerts.create_rule(rule_spec())
    same = await stores.alerts.update_rule(r.id, rule_spec(), base_version=None)
    assert same.version == 1
    later = await stores.alerts.update_rule(r.id, rule_spec(severity="info"), base_version=None)
    assert later.version == 2
    with pytest.raises(UnknownRule):
        await stores.alerts.update_rule("missing", rule_spec(), base_version=None)


async def test_rules_are_listed_by_scope_and_name(stores):
    b = await stores.alerts.create_rule(rule_spec(name="beta"))
    a = await stores.alerts.create_rule(rule_spec(name="Alpha"))
    g = await stores.alerts.create_rule(rule_spec(name="gamma", scope_kind="group", scope_id="g"))
    assert [r.id for r in await stores.alerts.list_rules()] == [a.id, b.id, g.id]
    assert [r.id for r in await stores.alerts.list_rules(scope_kind="group")] == [g.id]
    assert [r.id for r in await stores.alerts.list_rules(scope_kind="project", scope_id="p1")] == [
        a.id,
        b.id,
    ]
    await stores.alerts.tombstone_rule(b.id)
    assert [r.id for r in await stores.alerts.list_rules(scope_id="p1")] == [a.id]
    assert [r.id for r in await stores.alerts.list_rules(scope_id="p1", include_deleted=True)] == [
        a.id,
        b.id,
    ]
    assert (await stores.alerts.get_rule(b.id)).deleted_at is not None


async def test_pause_detach_tombstone_and_purge(stores):
    r = await stores.alerts.create_rule(
        rule_spec(origin="panel", dashboard_id="d1", panel_id="p-1")
    )
    assert (await stores.alerts.rule_for_panel("d1", "p-1")).id == r.id
    assert await stores.alerts.rule_for_panel("d1", "p-2") is None

    paused = await stores.alerts.set_paused(r.id, True)
    assert (paused.paused, paused.version) == (True, 1)

    detached = await stores.alerts.detach_rule(r.id)
    assert (detached.origin, detached.dashboard_id, detached.panel_id) == ("page", None, None)
    assert detached.version == 2
    assert await stores.alerts.rule_for_panel("d1", "p-1") is None

    await stores.alerts.put_targets(r.id, [target_spec("a")])
    await stores.alerts.tombstone_rule(r.id)
    assert await stores.alerts.purge_rule(r.id) is False  # a target is left
    [t] = await stores.alerts.targets(rule_id=r.id)
    await stores.alerts.delete_target(t.id)
    assert await stores.alerts.purge_rule(r.id) is True
    with pytest.raises(UnknownRule):
        await stores.alerts.get_rule(r.id)
    with pytest.raises(UnknownTarget):
        await stores.alerts.delete_target(t.id)


async def test_writes_share_the_callers_transaction(stores):
    with pytest.raises(RuntimeError):
        async with stores.sessionmaker.begin() as session:
            r = await stores.alerts.create_rule(rule_spec(), session=session)
            await stores.alerts.put_targets(r.id, [target_spec("a")], session=session)
            raise RuntimeError("stop")
    assert await stores.alerts.list_rules() == []
    assert await stores.alerts.targets() == []


# -- targets -----------------------------------------------------------------------------------


async def test_put_targets_adds_changes_and_marks_leaving(stores):
    r = await stores.alerts.create_rule(rule_spec())
    first = await stores.alerts.put_targets(r.id, [target_spec("A"), target_spec("B")])
    by_project = {t.project_id: t for t in await stores.alerts.targets(rule_id=r.id)}
    assert first.added == (by_project["A"].id, by_project["B"].id)
    assert (first.changed, first.leaving) == ((), ())
    a = by_project["A"]
    assert (a.state, a.next_eval_at, a.failures, a.leaving, a.engine) == (
        "ok",
        None,
        0,
        False,
        "omnikrux",
    )

    again = await stores.alerts.put_targets(r.id, [target_spec("A"), target_spec("B")])
    assert (again.added, again.changed, again.leaving) == ((), (), ())

    second = await stores.alerts.put_targets(
        r.id, [target_spec("B", eval_expr="rate(y[5m])"), target_spec("C")]
    )
    by_project = {t.project_id: t for t in await stores.alerts.targets(rule_id=r.id)}
    assert second.changed == (by_project["B"].id,)
    assert second.added == (by_project["C"].id,)
    assert second.leaving == (by_project["A"].id,)
    assert by_project["A"].leaving is True
    assert by_project["B"].eval_expr == "rate(y[5m])"
    assert [t.project_id for t in await stores.alerts.targets(project_id="A")] == ["A"]

    # A project that comes back is no longer leaving.
    back = await stores.alerts.put_targets(r.id, [target_spec("A"), target_spec("C")])
    assert back.changed == (by_project["A"].id,)
    assert back.leaving == (by_project["B"].id,)
    assert (await stores.alerts.get_target(by_project["A"].id)).leaving is False
    with pytest.raises(UnknownTarget):
        await stores.alerts.get_target("missing")


async def test_eval_and_tool_state(stores):
    r = await stores.alerts.create_rule(rule_spec(engine="tool"))
    await stores.alerts.put_targets(
        r.id, [target_spec("A", engine="tool", tool_kind="prometheus_rule")]
    )
    [t] = await stores.alerts.targets(rule_id=r.id)
    assert (t.tool_kind, t.tool_state, t.tool_object, t.applied_version) == (
        "prometheus_rule",
        None,
        None,
        None,
    )
    obj = ToolObject("prometheus_rule", "src-A", "c1", "monitoring", "omnikrux-abc")
    got = await stores.alerts.set_tool(
        t.id, tool_state="in_sync", tool_message=None, tool_object=obj, applied_version=1
    )
    assert (got.tool_state, got.tool_object, got.applied_version) == ("in_sync", obj, 1)
    kept = await stores.alerts.set_tool(t.id, tool_state="needs_review", tool_message="Changed.")
    assert (kept.tool_state, kept.tool_message, kept.tool_object, kept.applied_version) == (
        "needs_review",
        "Changed.",
        obj,
        1,
    )
    cleared = await stores.alerts.set_tool(
        t.id, tool_state=None, tool_message=None, tool_object=None, applied_version=None
    )
    assert (cleared.tool_object, cleared.applied_version) == (None, None)

    await stores.alerts.set_eval(
        t.id,
        state="firing",
        message=None,
        at=T0,
        next_eval_at=T0 + timedelta(minutes=1),
        failures=0,
    )
    firing = await stores.alerts.get_target(t.id)
    assert (firing.state, firing.state_since, firing.last_eval_at) == ("firing", T0, T0)
    assert firing.next_eval_at == T0 + timedelta(minutes=1)
    later = T0 + timedelta(minutes=1)
    await stores.alerts.set_eval(
        t.id, state="firing", message=None, at=later, next_eval_at=None, failures=0
    )
    still = await stores.alerts.get_target(t.id)
    assert (still.state_since, still.last_eval_at) == (T0, later)  # same state: since unchanged
    await stores.alerts.set_eval(
        t.id, state="unreachable", message="Down.", at=later, next_eval_at=None, failures=2
    )
    down = await stores.alerts.get_target(t.id)
    assert (down.state, down.state_since, down.message, down.failures) == (
        "unreachable",
        later,
        "Down.",
        2,
    )
    with pytest.raises(UnknownTarget):
        await stores.alerts.set_eval(
            "missing", state="ok", message=None, at=T0, next_eval_at=None, failures=0
        )


async def test_due_targets_skip_paused_tool_and_leaving(stores):
    alerts = stores.alerts
    due = await alerts.create_rule(rule_spec(name="due"))
    paused = await alerts.create_rule(rule_spec(name="paused"))
    tool = await alerts.create_rule(rule_spec(name="tool"))
    gone = await alerts.create_rule(rule_spec(name="gone"))
    await alerts.put_targets(due.id, [target_spec("A"), target_spec("B"), target_spec("C")])
    await alerts.put_targets(paused.id, [target_spec("A")])
    await alerts.put_targets(tool.id, [target_spec("A", engine="tool", tool_kind="loki_ruler")])
    await alerts.put_targets(gone.id, [target_spec("A")])
    await alerts.set_paused(paused.id, True)
    await alerts.tombstone_rule(gone.id)
    by_project = {t.project_id: t for t in await alerts.targets(rule_id=due.id)}
    # B was checked and isn't due for a minute; C leaves.
    await alerts.set_eval(
        by_project["B"].id,
        state="ok",
        message=None,
        at=T0,
        next_eval_at=T0 + timedelta(minutes=1),
        failures=0,
    )
    await alerts.put_targets(due.id, [target_spec("A"), target_spec("B")])

    assert [t.id for t in await alerts.due_targets(T0)] == [by_project["A"].id]
    assert {t.id for t in await alerts.due_targets(T0 + timedelta(minutes=1))} == {
        by_project["A"].id,
        by_project["B"].id,
    }


# -- instances and history ---------------------------------------------------------------------


async def test_instances_and_history_survive_a_new_store(stores, db_path):
    r = await stores.alerts.create_rule(rule_spec())
    await stores.alerts.put_targets(r.id, [target_spec("A")])
    [t] = await stores.alerts.targets(rule_id=r.id)
    items = [
        InstanceRecord(
            target_id=t.id,
            fingerprint="f2",
            labels={"route": "/b"},
            state="pending",
            active_since=T0,
            fired_at=None,
            value=0.35,
            last_notified_at=None,
            silenced=False,
        ),
        InstanceRecord(
            target_id=t.id,
            fingerprint="f1",
            labels={"route": "/a"},
            state="firing",
            active_since=T0,
            fired_at=T0 + timedelta(minutes=5),
            value=0.4,
            last_notified_at=T0 + timedelta(minutes=5),
            silenced=True,
        ),
    ]
    await stores.alerts.replace_instances(t.id, items)
    await stores.alerts.add_history(
        [entry(t.id, r.id, T0), entry(t.id, r.id, T0 + timedelta(minutes=5), "resolved")]
    )

    engine = make_engine(f"sqlite+aiosqlite:///{db_path}")
    try:
        fresh = AlertStore(make_sessionmaker(engine))
        assert await fresh.instances(t.id) == [items[1], items[0]]  # by fingerprint
        history = await fresh.history(rule_id=r.id)
        assert [(h.kind, h.at, h.labels, h.value) for h in history] == [
            ("resolved", T0 + timedelta(minutes=5), {"route": "/a"}, 0.4),
            ("firing", T0, {"route": "/a"}, 0.4),
        ]
        assert all(isinstance(h.id, int) for h in history)
        assert len(await fresh.history(rule_id=r.id, limit=1)) == 1
    finally:
        await engine.dispose()

    await stores.alerts.replace_instances(t.id, items[:1])
    assert await stores.alerts.instances(t.id) == items[:1]
    await stores.alerts.delete_target(t.id)
    assert await stores.alerts.instances(t.id) == []


async def test_prune_keeps_seven_days_and_caps(stores, db_path):
    r = await stores.alerts.create_rule(rule_spec())
    await stores.alerts.put_targets(r.id, [target_spec("A"), target_spec("B")])
    a, b = sorted(await stores.alerts.targets(rule_id=r.id), key=lambda t: t.project_id)
    recent = [entry(a.id, r.id, T0 - timedelta(seconds=i)) for i in range(600)]
    old = [entry(a.id, r.id, T0 - timedelta(days=8, minutes=i)) for i in range(10)]
    other = [entry(b.id, r.id, T0 - timedelta(days=6))]
    await stores.alerts.add_history(old + recent + other)

    assert await stores.alerts.prune(T0) == 110
    kept = [h for h in await stores.alerts.history(rule_id=r.id, limit=1000) if h.target_id == a.id]
    assert len(kept) == 500
    assert {h.at for h in kept} == {e.at for e in recent[:500]}  # the newest
    assert count(db_path, "monitoring_alert_history") == 501
    assert await stores.alerts.prune(T0) == 0


async def test_prune_caps_all_history_and_deliveries(stores, db_path, monkeypatch):
    monkeypatch.setattr(alert_store, "HISTORY_TOTAL", 5)
    monkeypatch.setattr(alert_store, "DELIVERIES_TOTAL", 3)
    r = await stores.alerts.create_rule(rule_spec())
    await stores.alerts.put_targets(r.id, [target_spec("A"), target_spec("B")])
    a, b = await stores.alerts.targets(rule_id=r.id)
    await stores.alerts.add_history(
        [entry(a.id, r.id, T0 - timedelta(minutes=i)) for i in range(4)]
        + [entry(b.id, r.id, T0 - timedelta(minutes=i, seconds=30)) for i in range(4)]
    )
    async with stores.sessionmaker.begin() as session:
        for i in range(5):
            session.add(
                DeliveryRow(
                    at=T0 - timedelta(minutes=i), contact_point_id="cp", kind="firing", ok=True
                )
            )
        session.add(
            DeliveryRow(at=T0 - timedelta(days=8), contact_point_id="cp", kind="firing", ok=False)
        )
    assert await stores.alerts.prune(T0) == 3 + 3
    history = await stores.alerts.history(rule_id=r.id)
    assert [h.at for h in history] == sorted({h.at for h in history}, reverse=True)
    assert len(history) == 5
    assert min(h.at for h in history) == T0 - timedelta(minutes=2)
    with closing(sqlite3.connect(db_path)) as conn:
        left = conn.execute("SELECT count(*), min(at) FROM monitoring_alert_deliveries").fetchone()
    assert left[0] == 3


# -- owners ------------------------------------------------------------------------------------


async def test_rule_refs_and_delete_owned_for_a_project(stores, db_path):
    alerts = stores.alerts
    a = (await stores.projects.create("A", "custom", None)).id
    b = (await stores.projects.create("B", "custom", None)).id
    group = await stores.groups.create("Ops", [a, b])
    own = await alerts.create_rule(rule_spec(name="own", scope_id=a))
    other = await alerts.create_rule(rule_spec(name="other", scope_id=b))
    shared = await alerts.create_rule(
        rule_spec(name="shared", scope_kind="group", scope_id=group.id, engine="tool")
    )
    await alerts.put_targets(own.id, [target_spec(a)])
    await alerts.put_targets(other.id, [target_spec(b)])
    await alerts.put_targets(
        shared.id,
        [
            target_spec(a, engine="tool", tool_kind="prometheus_rule"),
            target_spec(b, engine="tool", tool_kind="prometheus_rule"),
        ],
    )
    async with stores.sessionmaker() as session:
        assert await alerts.rule_refs("project", a, session=session) == (
            (RuleRef(own.id, "own"),),
            (),
        )
    shared_a = next(t for t in await alerts.targets(rule_id=shared.id) if t.project_id == a)
    await alerts.set_tool(shared_a.id, tool_state="in_sync", tool_message=None, applied_version=1)
    async with stores.sessionmaker() as session:
        assert await alerts.rule_refs("project", a, session=session) == (
            (RuleRef(own.id, "own"),),
            (RuleRef(shared.id, "shared"),),
        )
        assert await alerts.rule_refs("group", group.id, session=session) == (
            (RuleRef(shared.id, "shared"),),
            (RuleRef(shared.id, "shared"),),
        )
    [own_target] = await alerts.targets(rule_id=own.id)
    await alerts.add_history([entry(own_target.id, own.id, T0)])

    async with stores.sessionmaker.begin() as session:
        gone = await alerts.delete_owned("project", a, session=session)
    assert gone == [RuleRef(own.id, "own")]
    assert [r.id for r in await alerts.list_rules(include_deleted=True)] == [other.id, shared.id]
    assert {t.project_id for t in await alerts.targets()} == {b}
    assert await alerts.history(rule_id=own.id) == []

    async with stores.sessionmaker.begin() as session:
        assert await alerts.delete_owned("group", group.id, session=session) == [
            RuleRef(shared.id, "shared")
        ]
    assert [r.id for r in await alerts.list_rules()] == [other.id]
    assert count(db_path, "monitoring_alert_targets") == 1


async def test_a_dashboards_rules_go_with_its_owner(stores):
    a = (await stores.projects.create("A", "custom", None)).id
    d = await stores.dashboards.create("project", a, doc("Alpha", panels=1))
    # A panel rule whose scope somehow differs still goes with the dashboard's owner.
    r = await stores.alerts.create_rule(
        rule_spec(scope_id="elsewhere", origin="panel", dashboard_id=d.id, panel_id="p-1")
    )
    async with stores.sessionmaker.begin() as session:
        refs = await stores.alerts.rule_refs("project", a, session=session)
        assert refs == ((RuleRef(r.id, "API latency high"),), ())
        await stores.alerts.delete_owned("project", a, session=session)
        await stores.dashboards.delete_owned("project", a, session=session)
    assert await stores.alerts.list_rules(include_deleted=True) == []


async def test_delete_owned_rolls_back_with_its_transaction(stores):
    a = (await stores.projects.create("A", "custom", None)).id
    r = await stores.alerts.create_rule(rule_spec(scope_id=a))
    with pytest.raises(RuntimeError):
        async with stores.sessionmaker.begin() as session:
            await stores.alerts.delete_owned("project", a, session=session)
            raise RuntimeError("stop")
    assert (await stores.alerts.get_rule(r.id)).version == 1


def test_review_token_leaves_out_empty_alert_rules():
    review = {"project_id": "p", "name": "A", "dashboards": []}
    assert review_token(review | {"alert_rules": [], "cluster_rules": []}) == review_token(review)
    assert review_token(review | {"alert_rules": [{"id": "r", "name": "x"}]}) != review_token(
        review
    )


# -- sources, services, migration --------------------------------------------------------------


async def test_sources_say_whether_omnikrux_installed_them(stores, db_path):
    src = await stores.sources.create(new_source())
    assert src.installed_by_omnikrux is False
    with closing(sqlite3.connect(db_path)) as conn:
        conn.execute("UPDATE monitoring_sources SET installed_by_omnikrux = 1")
        conn.commit()
    assert (await stores.sources.get(src.id)).installed_by_omnikrux is True


async def test_source_responses_say_whether_omnikrux_installed_them(
    monitoring_app, fake_prometheus
):
    http, _ = monitoring_app
    created = await http.post(
        "/api/monitoring/sources",
        json={"type": "prometheus", "reach": "url", "url": fake_prometheus.url},
    )
    assert created.status_code == 201, created.text
    assert created.json()["installed_by_omnikrux"] is False


async def test_the_services_carry_the_alert_store(monitoring_app):
    _, app = monitoring_app
    assert isinstance(app.state.monitoring.alerts, AlertStore)


TABLES = {
    "monitoring_alert_rules",
    "monitoring_alert_targets",
    "monitoring_alert_instances",
    "monitoring_alert_history",
    "monitoring_contact_points",
    "monitoring_silences",
    "monitoring_alert_deliveries",
}


async def test_migration_0009_up_and_down(tmp_path):
    from alembic import command
    from alembic.config import Config

    def migrate(conn, direction, rev):
        config = Config()
        config.set_main_option("script_location", str(MIGRATIONS_DIR))
        config.attributes["connection"] = conn
        getattr(command, direction)(config, rev)

    def schema(conn):
        found = inspect(conn)
        names = set(found.get_table_names())
        indexes = {
            i["name"]: i["column_names"]
            for t in sorted(TABLES & names)
            for i in found.get_indexes(t)
        }
        columns = {c["name"] for c in found.get_columns("monitoring_sources")}
        return names, indexes, columns

    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/m.db")
    await init_db(engine)
    async with engine.begin() as conn:
        names, indexes, columns = await conn.run_sync(schema)
        assert TABLES <= names
        assert indexes == {
            "ix_monitoring_alert_rules_scope": ["scope_kind", "scope_id"],
            "ix_monitoring_alert_rules_panel": ["dashboard_id", "panel_id"],
            "ix_monitoring_alert_targets_rule_id": ["rule_id"],
            "ix_monitoring_alert_targets_project_id": ["project_id"],
            "ix_monitoring_alert_history_rule_at": ["rule_id", "at"],
            "ix_monitoring_alert_history_at": ["at"],
            "ix_monitoring_alert_deliveries_at": ["at"],
        }
        pk = await conn.run_sync(
            lambda c: inspect(c).get_pk_constraint("monitoring_alert_instances")
        )
        assert pk["constrained_columns"] == ["target_id", "fingerprint"]
        uniques = await conn.run_sync(
            lambda c: inspect(c).get_unique_constraints("monitoring_contact_points")
        )
        assert [u["column_names"] for u in uniques] == [["name"]]
        assert "installed_by_omnikrux" in columns

        await conn.run_sync(migrate, "downgrade", "0008")
        names, _, columns = await conn.run_sync(schema)
        assert not TABLES & names
        assert "installed_by_omnikrux" not in columns
        assert "monitoring_dashboards" in names
    await init_db(engine)
    async with engine.connect() as conn:
        names, _, columns = await conn.run_sync(schema)
    await engine.dispose()
    assert TABLES <= names
    assert "installed_by_omnikrux" in columns
