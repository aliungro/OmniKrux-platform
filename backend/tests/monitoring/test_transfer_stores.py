"""Where imported dashboards came from and the Grafana connections they use, on a real SQLite
file: Grafana secrets encrypted at rest and kept until replaced, unique connection names, origin
rows that go with their dashboards, and migration 0011."""

import itertools
import sqlite3
from contextlib import closing
from datetime import UTC, datetime

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import inspect

from omnikrux.db import MIGRATIONS_DIR, init_db, make_engine
from omnikrux.monitoring.dashboards.schema import validate_dashboard
from omnikrux.monitoring.sources.types import ClusterTarget, NameTaken
from omnikrux.monitoring.transfer.grafana_store import (
    GrafanaChange,
    GrafanaSecrets,
    GrafanaStore,
    NewGrafana,
    UnknownGrafana,
)
from omnikrux.monitoring.transfer.origins import (
    MappingChoice,
    OriginRecord,
    OriginStore,
    mapping_from_json,
    mapping_json,
)
from omnikrux.security.secrets import SecretBox

T0 = datetime(2026, 11, 24, 12, 0, tzinfo=UTC)
T1 = datetime(2026, 11, 25, 9, 30, tzinfo=UTC)
_names = itertools.count(1)
CLUSTER = ClusterTarget("c1", "monitoring", "grafana", "80", "http")


def new_grafana(**over) -> NewGrafana:
    values = {
        "name": f"Grafana · test {next(_names)}",
        "reach": "url",
        "url": "http://grafana.example:3000",
    }
    return NewGrafana(**(values | over))


def doc(title: str, panels: int = 1) -> dict:
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
        owner_kind="project",
    )


def origin(dashboard_id: str, **over) -> OriginRecord:
    values = {
        "dashboard_id": dashboard_id,
        "kind": "grafana",
        "via": "grafana",
        "label": "Grafana · kind",
        "grafana_id": None,
        "grafana_uid": "uid-1",
        "grafana_version": 7,
        "export_id": None,
        "source_title": "Node overview",
        "mapping": {
            "grafana:uid:prom": MappingChoice(None),
            "grafana:uid:loki": MappingChoice(None, True),
        },
        "digest": "d1",
        "imported_at": T0,
        "imported_version": 1,
        "panels": {"2": "p-1"},
    }
    return OriginRecord(**(values | over))


def rows(db_path, table: str) -> list[tuple]:
    with closing(sqlite3.connect(db_path)) as conn:
        return conn.execute(f"select * from {table}").fetchall()


@pytest.fixture
async def pid(stores) -> str:
    return (await stores.projects.create("Shop", "custom", None)).id


# -- Grafana connections -----------------------------------------------------------------------


async def test_grafana_secrets_are_encrypted_at_rest(stores, db_path):
    g = await stores.grafana.create(
        new_grafana(auth_type="bearer", secrets=GrafanaSecrets(token="glsa_SECRET-1"))
    )
    raw = rows(db_path, "monitoring_grafana")
    assert b"glsa_SECRET-1" not in repr(raw).encode()
    assert (await stores.grafana.get(g.id)).secrets.token == "glsa_SECRET-1"
    assert "glsa_SECRET-1" not in repr(g)


async def test_grafana_create_keeps_only_what_its_reach_and_auth_use(stores):
    g = await stores.grafana.create(
        new_grafana(
            reach="cluster",
            url="http://ignored.example",
            cluster=CLUSTER,
            path_prefix="/grafana",
            auth_type="none",
            username="admin",
            secrets=GrafanaSecrets(password="pw", token="t"),
        )
    )
    got = await stores.grafana.get(g.id)
    assert got == g
    assert (got.reach, got.url, got.cluster, got.path_prefix) == (
        "cluster",
        None,
        CLUSTER,
        "/grafana",
    )
    assert (got.auth_type, got.username, got.secrets) == ("none", None, GrafanaSecrets())
    assert got.created_at.tzinfo is not None and not got.secrets_unreadable


async def test_grafana_update_keeps_secrets_unless_replaced(stores, db_path):
    g = await stores.grafana.create(
        new_grafana(auth_type="bearer", secrets=GrafanaSecrets(token="glsa_SECRET-2"))
    )
    renamed = await stores.grafana.update(g.id, GrafanaChange(name="Grafana · renamed"))
    assert renamed.name == "Grafana · renamed"
    assert renamed.secrets.token == "glsa_SECRET-2"
    assert renamed.updated_at >= g.updated_at

    replaced = await stores.grafana.update(
        g.id, GrafanaChange(secrets=GrafanaSecrets(token="glsa_SECRET-3"))
    )
    assert replaced.secrets.token == "glsa_SECRET-3"

    basic = await stores.grafana.update(
        g.id,
        GrafanaChange(
            auth_type="basic", username="admin", secrets=GrafanaSecrets(password="pw-SECRET-4")
        ),
    )
    assert (basic.auth_type, basic.username) == ("basic", "admin")
    assert basic.secrets == GrafanaSecrets(password="pw-SECRET-4")
    assert (await stores.grafana.get(g.id)).secrets.token is None
    raw = repr(rows(db_path, "monitoring_grafana")).encode()
    assert b"pw-SECRET-4" not in raw and b"glsa_SECRET" not in raw

    url = await stores.grafana.update(g.id, GrafanaChange(url="http://other.example:3000"))
    assert url.url == "http://other.example:3000" and url.secrets.password == "pw-SECRET-4"

    none = await stores.grafana.update(g.id, GrafanaChange(auth_type="none"))
    assert (none.username, none.secrets) == (None, GrafanaSecrets())
    with closing(sqlite3.connect(db_path)) as conn:
        assert conn.execute("select secret_encrypted from monitoring_grafana").fetchall() == [
            (None,)
        ]


async def test_grafana_with_another_key_reads_as_unreadable(stores):
    g = await stores.grafana.create(
        new_grafana(auth_type="bearer", secrets=GrafanaSecrets(token="glsa_SECRET-5"))
    )
    other = GrafanaStore(stores.sessionmaker, SecretBox(Fernet.generate_key()))
    got = await other.get(g.id)
    assert got.secrets_unreadable and got.secrets == GrafanaSecrets()
    # A rename leaves the unreadable secret alone; a new token replaces it.
    await other.update(g.id, GrafanaChange(name="Grafana · still"))
    assert (await stores.grafana.get(g.id)).secrets.token == "glsa_SECRET-5"
    await other.update(g.id, GrafanaChange(secrets=GrafanaSecrets(token="glsa_NEW")))
    assert (await other.get(g.id)).secrets.token == "glsa_NEW"


async def test_grafana_names_are_unique(stores):
    first = await stores.grafana.create(new_grafana(name="Grafana · kind"))
    with pytest.raises(NameTaken) as taken:
        await stores.grafana.create(new_grafana(name=" Grafana · kind "))
    assert str(taken.value) == (
        'A Grafana connection named "Grafana · kind" already exists. Pick another name.'
    )
    assert await stores.grafana.unique_name("Grafana · kind") == "Grafana · kind (2)"
    assert await stores.grafana.unique_name("Grafana · new") == "Grafana · new"
    assert (
        await stores.grafana.unique_name("Grafana · kind", also_taken=["Grafana · kind (2)"])
        == "Grafana · kind (3)"
    )
    long = "G" * 80
    await stores.grafana.create(new_grafana(name=long))
    assert await stores.grafana.unique_name(long) == "G" * 76 + " (2)"

    second = await stores.grafana.create(new_grafana(name="Grafana · other"))
    with pytest.raises(NameTaken):
        await stores.grafana.update(second.id, GrafanaChange(name="Grafana · kind"))
    same = await stores.grafana.update(first.id, GrafanaChange(name="Grafana · kind"))
    assert same.name == "Grafana · kind"
    with pytest.raises(ValueError):
        await stores.grafana.create(new_grafana(name="  "))


async def test_grafana_list_get_and_unknown_ids(stores):
    b = await stores.grafana.create(new_grafana(name="b Grafana"))
    a = await stores.grafana.create(new_grafana(name="A Grafana"))
    assert [g.id for g in await stores.grafana.list()] == [a.id, b.id]
    with pytest.raises(UnknownGrafana):
        await stores.grafana.get("nope")
    with pytest.raises(UnknownGrafana):
        await stores.grafana.update("nope", GrafanaChange(name="x"))
    with pytest.raises(UnknownGrafana):
        await stores.grafana.delete("nope")
    assert issubclass(UnknownGrafana, KeyError)


async def test_find_target_matches_address_or_cluster_service(stores):
    by_url = await stores.grafana.create(new_grafana(url="http://grafana.example:3000/"))
    in_cluster = await stores.grafana.create(new_grafana(reach="cluster", cluster=CLUSTER))
    find = stores.grafana.find_target
    assert (await find("http://grafana.example:3000", None)).id == by_url.id
    assert (await find("http://grafana.example:3000/", None)).id == by_url.id
    assert await find("http://elsewhere.example:3000", None) is None
    assert (await find(None, CLUSTER)).id == in_cluster.id
    https = ClusterTarget("c1", "monitoring", "grafana", "80", "https")
    assert (await find(None, https)).id == in_cluster.id
    assert await find(None, ClusterTarget("c2", "monitoring", "grafana", "80", "http")) is None
    assert await find(None, None) is None


# -- origins -----------------------------------------------------------------------------------


def test_mapping_json_round_trip():
    mapping = {
        "grafana:uid:prom": MappingChoice("s1"),
        "grafana:uid:loki": MappingChoice(None, True),
        "omnikrux:x": MappingChoice(None),
    }
    assert mapping_from_json(mapping_json(mapping)) == mapping
    assert mapping_from_json("{}") == {}
    assert mapping_from_json('{"k": "not a choice", "j": {"source_id": 3}}') == {
        "j": MappingChoice(None)
    }


async def test_origin_round_trip_and_update(stores, pid):
    d = await stores.dashboards.create("project", pid, doc("Node overview"), origin="imported")
    recorded = await stores.origins.record(origin(d.id))
    assert recorded == origin(d.id)
    got = await stores.origins.get(d.id)
    assert got == origin(d.id)
    assert got.updated_at is None and got.updated_version is None
    assert await stores.origins.get("nope") is None

    updated = await stores.origins.mark_updated(
        d.id,
        version=3,
        digest="d2",
        grafana_version=9,
        mapping={"grafana:uid:prom": MappingChoice("s1")},
        now=T1,
        panels={"2": "p-1", "5": "p-2"},
    )
    assert (updated.updated_version, updated.imported_version) == (3, 1)
    assert (updated.digest, updated.grafana_version, updated.updated_at) == ("d2", 9, T1)
    assert updated.mapping == {"grafana:uid:prom": MappingChoice("s1")}
    assert updated.panels == {"2": "p-1", "5": "p-2"}
    assert updated.imported_at == T0
    assert await stores.origins.get(d.id) == updated

    kept = await stores.origins.mark_updated(
        d.id, version=4, digest="d3", grafana_version=None, mapping={}, now=T1
    )
    assert kept.panels == {"2": "p-1", "5": "p-2"} and kept.grafana_version is None
    with pytest.raises(KeyError):
        await stores.origins.mark_updated(
            "nope", version=2, digest="x", grafana_version=None, mapping={}, now=T1
        )


async def test_origin_of_a_file_import(stores, pid):
    d = await stores.dashboards.create("project", pid, doc("From a file"), origin="imported")
    file_origin = origin(
        d.id,
        kind="omnikrux",
        via="file",
        label="shop.omnikrux.json",
        grafana_uid=None,
        grafana_version=None,
        export_id="e1",
        mapping={},
        panels={},
    )
    await stores.origins.record(file_origin)
    assert await stores.origins.get(d.id) == file_origin


async def test_origins_by_grafana_connection(stores, pid):
    g = await stores.grafana.create(new_grafana())
    one = await stores.dashboards.create("project", pid, doc("One"))
    two = await stores.dashboards.create("project", pid, doc("Two"))
    other = await stores.dashboards.create("project", pid, doc("Other"))
    await stores.origins.record(origin(one.id, grafana_id=g.id))
    await stores.origins.record(origin(two.id, grafana_id=g.id))
    await stores.origins.record(origin(other.id))
    assert sorted(await stores.origins.from_grafana(g.id)) == sorted([one.id, two.id])
    assert await stores.origins.from_grafana("nope") == []

    async with stores.sessionmaker.begin() as session:
        await stores.origins.delete(one.id, session=session)
    assert await stores.origins.get(one.id) is None
    assert await stores.origins.from_grafana(g.id) == [two.id]


async def test_deleting_a_dashboard_takes_its_origin(stores, pid, db_path):
    d = await stores.dashboards.create("project", pid, doc("Gone"))
    kept = await stores.dashboards.create("project", pid, doc("Kept"))
    await stores.origins.record(origin(d.id))
    await stores.origins.record(origin(kept.id))
    await stores.dashboards.delete(d.id, 1)
    assert await stores.origins.get(d.id) is None
    assert await stores.origins.get(kept.id) is not None
    assert [r[0] for r in rows(db_path, "monitoring_dashboard_origins")] == [kept.id]


async def test_deleting_an_owner_takes_its_dashboards_origins(stores, pid):
    other = (await stores.projects.create("Other", "custom", None)).id
    d = await stores.dashboards.create("project", pid, doc("Gone"))
    kept = await stores.dashboards.create("project", other, doc("Kept"))
    await stores.origins.record(origin(d.id))
    await stores.origins.record(origin(kept.id))
    review = await stores.projects.delete_review(pid, stores.dashboards, stores.alerts)
    await stores.projects.delete(
        pid, review.token, stores.sources, stores.dashboards, stores.alerts
    )
    assert await stores.origins.get(d.id) is None
    assert await stores.origins.get(kept.id) is not None


async def test_deleting_a_group_takes_its_dashboards_origins(stores, pid):
    group = await stores.groups.create("Team", [pid])
    g_doc = validate_dashboard({**doc("Team view"), "panels": []}, owner_kind="group")
    d = await stores.dashboards.create("group", group.id, g_doc)
    await stores.origins.record(origin(d.id))
    with pytest.raises(RuntimeError):
        async with stores.sessionmaker.begin() as session:
            await stores.dashboards.delete_owned("group", group.id, session=session)
            raise RuntimeError("stop")
    assert await stores.origins.get(d.id) is not None
    async with stores.sessionmaker.begin() as session:
        await stores.dashboards.delete_owned("group", group.id, session=session)
    assert await stores.origins.get(d.id) is None


async def test_removing_a_grafana_keeps_the_dashboards_and_forgets_the_link(stores, pid):
    g = await stores.grafana.create(
        new_grafana(auth_type="bearer", secrets=GrafanaSecrets(token="glsa_SECRET-6"))
    )
    d = await stores.dashboards.create("project", pid, doc("Node overview"))
    await stores.origins.record(origin(d.id, grafana_id=g.id))
    await stores.grafana.delete(g.id)
    with pytest.raises(UnknownGrafana):
        await stores.grafana.get(g.id)
    assert (await stores.dashboards.get(d.id)).title == "Node overview"
    kept = await stores.origins.get(d.id)
    assert kept is not None and kept.grafana_id is None
    assert kept.grafana_uid == "uid-1"
    assert await stores.origins.from_grafana(g.id) == []


async def test_save_records_the_given_origin(stores, pid):
    d = await stores.dashboards.create(
        "project", pid, doc("Node overview"), origin="imported", copied_from="Grafana · kind"
    )
    await stores.dashboards.save(
        d.id, 1, doc("Node overview", panels=2), origin="updated", copied_from="Grafana · kind"
    )
    await stores.dashboards.save(d.id, 2, doc("Node overview", panels=3))
    newest, updated, imported = await stores.dashboards.versions(d.id)
    assert (newest.version, newest.origin, newest.copied_from) == (3, "saved", None)
    assert (updated.version, updated.origin, updated.copied_from) == (
        2,
        "updated",
        "Grafana · kind",
    )
    assert (updated.panel_count, imported.origin, imported.copied_from) == (
        2,
        "imported",
        "Grafana · kind",
    )


async def test_save_with_a_session_records_the_given_origin(stores, pid):
    d = await stores.dashboards.create("project", pid, doc("Node overview"))
    async with stores.sessionmaker.begin() as session:
        await stores.dashboards.save(
            d.id, 1, doc("Node overview", panels=2), session=session, origin="updated"
        )
    assert (await stores.dashboards.versions(d.id))[0].origin == "updated"


async def test_the_services_carry_the_transfer_stores(monitoring_app):
    _, app = monitoring_app
    assert isinstance(app.state.monitoring.origins, OriginStore)
    assert isinstance(app.state.monitoring.grafana, GrafanaStore)


def _migrate(conn, direction, rev):
    from alembic import command
    from alembic.config import Config

    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    config.attributes["connection"] = conn
    getattr(command, direction)(config, rev)


async def test_migration_up_and_down(tmp_path):
    def tables(conn):
        return set(inspect(conn).get_table_names())

    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/m.db")
    await init_db(engine)
    async with engine.begin() as conn:
        names = await conn.run_sync(tables)
        assert {"monitoring_grafana", "monitoring_dashboard_origins"} <= names
        uniques = await conn.run_sync(
            lambda c: inspect(c).get_unique_constraints("monitoring_grafana")
        )
        assert [u["column_names"] for u in uniques] == [["name"]]
        indexes = await conn.run_sync(
            lambda c: inspect(c).get_indexes("monitoring_dashboard_origins")
        )
        assert [i["column_names"] for i in indexes] == [["grafana_id"]]
        await conn.run_sync(_migrate, "downgrade", "0010")
        names = await conn.run_sync(tables)
        assert "monitoring_grafana" not in names
        assert "monitoring_dashboard_origins" not in names
        assert "monitoring_installs" in names
    await init_db(engine)
    async with engine.connect() as conn:
        assert {"monitoring_grafana", "monitoring_dashboard_origins"} <= await conn.run_sync(tables)
    await engine.dispose()


async def test_find_target_takes_only_a_connection_that_fits(stores):
    first = await stores.grafana.create(new_grafana(url="http://grafana.example:3000"))
    second = await stores.grafana.create(new_grafana(url="http://grafana.example:3000/"))
    find = stores.grafana.find_target
    url = "http://grafana.example:3000"
    assert (await find(url, None)).id == first.id
    assert (await find(url, None, fits=lambda g: g.id == second.id)).id == second.id
    assert await find(url, None, fits=lambda g: False) is None
    in_cluster = await stores.grafana.create(new_grafana(reach="cluster", cluster=CLUSTER))
    assert (await find(None, CLUSTER, fits=lambda g: True)).id == in_cluster.id
    assert await find(None, CLUSTER, fits=lambda g: False) is None
