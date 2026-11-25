"""Dashboards on a real SQLite file: every save is a new version, a stale save is refused, titles
are unique per owner, and an owner's delete takes its dashboards with it."""

import sqlite3
from contextlib import closing

import pytest
from sqlalchemy import inspect

from omnikrux.db import MIGRATIONS_DIR, init_db, make_engine
from omnikrux.monitoring.dashboards.schema import validate_dashboard
from omnikrux.monitoring.dashboards.store import (
    DashboardRef,
    DashboardStore,
    UnknownDashboard,
    UnknownVersion,
    VersionConflict,
)
from omnikrux.monitoring.projects.types import UnknownGroup, UnknownProject
from omnikrux.monitoring.sources.types import NameTaken

CONFLICT = (
    "This dashboard was saved somewhere else since you started (version {}). "
    "Review the differences before saving."
)


def doc(title: str, panels: int = 0, owner_kind: str = "project") -> dict:
    """A valid, normalised document with `panels` stat panels stacked down the left."""
    return validate_dashboard(
        {
            "schemaVersion": 1,
            "title": title,
            "panels": [
                {
                    "id": f"p-{i + 1}",
                    "type": "stat",
                    "title": f"Panel {i + 1}",
                    "layout": {"x": 0, "y": 4 * i, "w": 6, "h": 4},
                    "queries": [
                        {"ref": "A", "source": {"type": "prometheus", "id": None}, "expr": "up"}
                    ],
                }
                for i in range(panels)
            ],
        },
        owner_kind=owner_kind,
    )


@pytest.fixture
async def pid(stores) -> str:
    return (await stores.projects.create("Shop", "custom", None)).id


def rows(db_path, table: str) -> list[tuple]:
    with closing(sqlite3.connect(db_path)) as conn:
        return conn.execute(f"select * from {table}").fetchall()


async def test_create_and_save_keep_every_version(stores, pid):
    d = await stores.dashboards.create("project", pid, doc("API latency"))
    d2 = await stores.dashboards.save(d.id, 1, doc("API latency", panels=1))
    assert (d.version, d2.version) == (1, 2)
    assert (d2.title, d2.spec) == ("API latency", doc("API latency", panels=1))
    assert d2.created_at == d.created_at and d2.updated_at >= d.updated_at
    vs = await stores.dashboards.versions(d.id)
    assert [(v.version, v.origin, v.panel_count) for v in vs] == [
        (2, "saved", 1),
        (1, "created", 0),
    ]
    assert [(v.restored_from, v.copied_from) for v in vs] == [(None, None), (None, None)]
    first, spec = await stores.dashboards.version(d.id, 1)
    assert (first.version, first.title, spec) == (1, "API latency", doc("API latency"))
    assert await stores.dashboards.get(d.id) == d2


async def test_create_records_the_owner_and_an_id_without_colons(stores, pid):
    d = await stores.dashboards.create("project", pid, doc("API latency", panels=2))
    assert ":" not in d.id
    assert (d.owner_kind, d.owner_id, d.title, d.version) == ("project", pid, "API latency", 1)
    assert d.created_at.tzinfo is not None
    got = await stores.dashboards.get(d.id)
    assert got == d


async def test_a_copy_remembers_where_it_came_from(stores, pid):
    d = await stores.dashboards.create(
        "project", pid, doc("Pod health"), origin="copied", copied_from=f"ready:{pid}:pods"
    )
    [v] = await stores.dashboards.versions(d.id)
    assert (v.origin, v.copied_from, v.restored_from) == ("copied", f"ready:{pid}:pods", None)


async def test_create_needs_an_owner_that_exists(stores, db_path):
    with pytest.raises(UnknownProject):
        await stores.dashboards.create("project", "gone", doc("API latency"))
    with pytest.raises(UnknownGroup):
        await stores.dashboards.create("group", "gone", doc("API latency", owner_kind="group"))
    assert rows(db_path, "monitoring_dashboards") == []
    assert rows(db_path, "monitoring_dashboard_versions") == []


async def test_save_with_old_base_version_is_refused(stores, pid):
    d = await stores.dashboards.create("project", pid, doc("API latency"))
    await stores.dashboards.save(d.id, 1, doc("API latency", panels=1))
    with pytest.raises(VersionConflict) as caught:
        await stores.dashboards.save(d.id, 1, doc("API latency", panels=3))
    assert caught.value.current == 2
    assert str(caught.value) == CONFLICT.format(2)
    got = await stores.dashboards.get(d.id)
    assert (got.version, got.spec) == (2, doc("API latency", panels=1))
    assert [v.version for v in await stores.dashboards.versions(d.id)] == [2, 1]


async def test_save_can_rename_and_unknown_ids_say_so(stores, pid):
    d = await stores.dashboards.create("project", pid, doc("API latency"))
    renamed = await stores.dashboards.save(d.id, 1, doc("API latency · prod"))
    assert renamed.title == "API latency · prod"
    assert [s.title for s in await stores.dashboards.list()] == ["API latency · prod"]
    with pytest.raises(UnknownDashboard):
        await stores.dashboards.save("gone", 1, doc("Other"))
    with pytest.raises(UnknownDashboard):
        await stores.dashboards.get("gone")
    with pytest.raises(UnknownDashboard):
        await stores.dashboards.versions("gone")
    with pytest.raises(UnknownVersion):
        await stores.dashboards.version(d.id, 9)
    with pytest.raises(UnknownDashboard):
        await stores.dashboards.delete("gone", 1)


async def test_restore_makes_a_new_version(stores, pid):
    d = await stores.dashboards.create("project", pid, doc("API latency"))
    await stores.dashboards.save(d.id, 1, doc("API latency", panels=1))
    await stores.dashboards.save(d.id, 2, doc("API latency v3", panels=2))
    restored = await stores.dashboards.restore(d.id, 1, base_version=3)
    assert restored.version == 4
    assert (restored.title, restored.spec) == ("API latency", doc("API latency"))
    [v4, *_] = await stores.dashboards.versions(d.id)
    assert (v4.version, v4.origin, v4.restored_from, v4.panel_count) == (4, "restored", 1, 0)
    _, spec = await stores.dashboards.version(d.id, 4)
    assert spec == doc("API latency")


async def test_restore_refuses_a_stale_base_or_an_unknown_version(stores, pid):
    d = await stores.dashboards.create("project", pid, doc("API latency"))
    await stores.dashboards.save(d.id, 1, doc("API latency", panels=1))
    with pytest.raises(VersionConflict) as caught:
        await stores.dashboards.restore(d.id, 1, base_version=1)
    assert caught.value.current == 2
    with pytest.raises(UnknownVersion):
        await stores.dashboards.restore(d.id, 7, base_version=2)
    with pytest.raises(UnknownDashboard):
        await stores.dashboards.restore("gone", 1, base_version=1)
    assert (await stores.dashboards.get(d.id)).version == 2


async def test_titles_are_unique_per_owner(stores, pid):
    other = (await stores.projects.create("Billing", "custom", None)).id
    group = (await stores.groups.create("Production", [pid])).id
    first = await stores.dashboards.create("project", pid, doc("API latency"))
    with pytest.raises(NameTaken) as caught:
        await stores.dashboards.create("project", pid, doc("API latency"))
    assert str(caught.value) == 'A dashboard named "API latency" already exists. Pick another name.'
    await stores.dashboards.create("project", other, doc("API latency"))
    await stores.dashboards.create("group", group, doc("API latency", owner_kind="group"))

    # A save or a restore can't take a title another dashboard of the owner has.
    second = await stores.dashboards.create("project", pid, doc("Errors"))
    with pytest.raises(NameTaken):
        await stores.dashboards.save(second.id, 1, doc("API latency"))
    assert (await stores.dashboards.get(second.id)).version == 1
    await stores.dashboards.save(first.id, 1, doc("Latency"))
    await stores.dashboards.save(second.id, 1, doc("API latency"))
    with pytest.raises(NameTaken):
        await stores.dashboards.restore(first.id, 1, base_version=2)
    assert (await stores.dashboards.get(first.id)).version == 2

    assert await stores.dashboards.unique_title("project", pid, "API latency") == "API latency (2)"
    assert await stores.dashboards.unique_title("project", pid, "Errors") == "Errors"
    await stores.dashboards.create("project", pid, doc("API latency (2)"))
    assert await stores.dashboards.unique_title("project", pid, "API latency") == "API latency (3)"
    assert await stores.dashboards.unique_title("group", group, "API latency") == "API latency (2)"
    assert await stores.dashboards.unique_title("project", other, "Latency") == "Latency"


async def test_unique_title_keeps_120_characters(stores, pid):
    long = "x" * 120
    await stores.dashboards.create("project", pid, doc(long))
    title = await stores.dashboards.unique_title("project", pid, long)
    assert title == "x" * 116 + " (2)"
    assert len(title) == 120


async def test_list_sorts_by_title_and_filters_by_owner(stores, pid):
    other = (await stores.projects.create("Billing", "custom", None)).id
    a = await stores.dashboards.create("project", pid, doc("b errors", panels=2))
    b = await stores.dashboards.create("project", pid, doc("API latency"))
    c = await stores.dashboards.create("project", other, doc("Cost"))
    await stores.dashboards.save(a.id, 1, doc("b errors", panels=3))
    every = await stores.dashboards.list()
    assert [s.id for s in every] == [b.id, a.id, c.id]
    mine = await stores.dashboards.list("project", pid)
    assert [(s.title, s.version, s.panel_count) for s in mine] == [
        ("API latency", 1, 0),
        ("b errors", 2, 3),
    ]
    assert [s.id for s in await stores.dashboards.list("project")] == [b.id, a.id, c.id]
    assert await stores.dashboards.list("group") == []


async def test_delete_needs_the_current_version_and_takes_versions(stores, pid, db_path):
    d = await stores.dashboards.create("project", pid, doc("API latency"))
    await stores.dashboards.save(d.id, 1, doc("API latency", panels=1))
    with pytest.raises(VersionConflict) as caught:
        await stores.dashboards.delete(d.id, 1)
    assert caught.value.current == 2
    assert len(rows(db_path, "monitoring_dashboard_versions")) == 2
    await stores.dashboards.delete(d.id, 2)
    assert rows(db_path, "monitoring_dashboards") == []
    assert rows(db_path, "monitoring_dashboard_versions") == []
    with pytest.raises(UnknownDashboard):
        await stores.dashboards.get(d.id)


async def test_delete_owned_returns_refs(stores, db_path):
    a = (await stores.projects.create("A", "custom", None)).id
    b = (await stores.projects.create("B", "custom", None)).id
    two = await stores.dashboards.create("project", a, doc("Alpha"))
    await stores.dashboards.save(two.id, 1, doc("Alpha", panels=1))
    one = await stores.dashboards.create("project", a, doc("beta"))
    kept = await stores.dashboards.create("project", b, doc("Alpha"))

    expected = [DashboardRef(two.id, "Alpha", 2), DashboardRef(one.id, "beta", 1)]
    assert await stores.dashboards.owned_refs("project", a) == expected
    async with stores.sessionmaker.begin() as session:
        assert await stores.dashboards.owned_refs("project", a, session=session) == expected
        assert await stores.dashboards.delete_owned("project", a, session=session) == expected
    assert [s.id for s in await stores.dashboards.list()] == [kept.id]
    assert [r[0] for r in rows(db_path, "monitoring_dashboard_versions")] == [kept.id]
    assert await stores.dashboards.owned_refs("project", a) == []


async def test_delete_owned_rolls_back_with_its_transaction(stores):
    a = (await stores.projects.create("A", "custom", None)).id
    d = await stores.dashboards.create("project", a, doc("Alpha"))
    with pytest.raises(RuntimeError):
        async with stores.sessionmaker.begin() as session:
            await stores.dashboards.delete_owned("project", a, session=session)
            raise RuntimeError("stop")
    assert (await stores.dashboards.get(d.id)).version == 1


async def test_the_services_carry_the_dashboard_store(monitoring_app):
    _, app = monitoring_app
    assert isinstance(app.state.monitoring.dashboards, DashboardStore)


async def test_migration_0008_up_and_down(tmp_path):
    from alembic import command
    from alembic.config import Config

    def migrate(conn, direction, rev):
        config = Config()
        config.set_main_option("script_location", str(MIGRATIONS_DIR))
        config.attributes["connection"] = conn
        getattr(command, direction)(config, rev)

    tables = {"monitoring_dashboards", "monitoring_dashboard_versions"}
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/m.db")
    await init_db(engine)
    async with engine.begin() as conn:
        names = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))
        assert tables <= names
        indexes = await conn.run_sync(
            lambda c: {i["name"] for i in inspect(c).get_indexes("monitoring_dashboards")}
        )
        assert indexes == {"ix_monitoring_dashboards_owner"}
        uniques = await conn.run_sync(
            lambda c: {
                u["name"]: u["column_names"]
                for u in inspect(c).get_unique_constraints("monitoring_dashboards")
            }
        )
        assert uniques == {
            "uq_monitoring_dashboards_owner_title": ["owner_kind", "owner_id", "title"]
        }
        pk = await conn.run_sync(
            lambda c: inspect(c).get_pk_constraint("monitoring_dashboard_versions")
        )
        assert pk["constrained_columns"] == ["dashboard_id", "version"]
        await conn.run_sync(migrate, "downgrade", "0007")
        names = await conn.run_sync(lambda c: set(inspect(c).get_table_names()))
        assert not tables & names
        assert "monitoring_projects" in names
    await init_db(engine)
    await engine.dispose()
