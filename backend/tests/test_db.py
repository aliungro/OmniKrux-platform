import pytest
from sqlalchemy import inspect

from omnikrux.db import init_db, make_engine


async def test_init_db_creates_clusters_table(tmp_settings):
    engine = make_engine(tmp_settings.db_url)
    await init_db(engine)
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda c: {x["name"] for x in inspect(c).get_columns("clusters")}
        )
    await engine.dispose()
    assert {
        "id",
        "name",
        "context_name",
        "server",
        "provider",
        "environment",
        "kubeconfig_encrypted",
    } <= cols


async def test_init_db_is_repeatable(tmp_settings):
    engine = make_engine(tmp_settings.db_url)
    await init_db(engine)
    await init_db(engine)  # no error on second run
    await engine.dispose()


async def test_init_db_creates_missing_parent_directory(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/nested/dir/omnikrux.db")
    await init_db(engine)
    await engine.dispose()
    assert (tmp_path / "nested" / "dir" / "omnikrux.db").exists()


async def test_migration_matches_orm_model(tmp_settings):
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    from omnikrux.audit import models as audit_models  # noqa: F401
    from omnikrux.cloud import models as cloud_models  # noqa: F401
    from omnikrux.clusters import models  # noqa: F401
    from omnikrux.db import Base

    engine = make_engine(tmp_settings.db_url)
    await init_db(engine)
    async with engine.connect() as conn:
        diff = await conn.run_sync(
            lambda c: compare_metadata(MigrationContext.configure(c), Base.metadata)
        )
    await engine.dispose()
    assert diff == []


async def test_upgrade_from_0001_keeps_rows_and_adds_original_server(tmp_settings):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import text

    from omnikrux.db import MIGRATIONS_DIR

    def upgrade_to(conn, rev):
        config = Config()
        config.set_main_option("script_location", str(MIGRATIONS_DIR))
        config.attributes["connection"] = conn
        command.upgrade(config, rev)

    engine = make_engine(tmp_settings.db_url)
    async with engine.begin() as conn:
        await conn.run_sync(upgrade_to, "0001")
        await conn.execute(
            text(
                "INSERT INTO clusters VALUES ('id1', 'kind', 'kubeconfig', 'kind', 'https://h:1', 'kind', NULL,"
                " 'development', x'00', '2026-01-01', '2026-01-01')"
            )
        )
    await init_db(engine)
    async with engine.connect() as conn:
        row = (await conn.execute(text("SELECT name, original_server FROM clusters"))).one()
    await engine.dispose()
    assert tuple(row) == ("kind", None)


def _migrate(conn, direction, rev):
    from alembic import command
    from alembic.config import Config

    from omnikrux.db import MIGRATIONS_DIR

    config = Config()
    config.set_main_option("script_location", str(MIGRATIONS_DIR))
    config.attributes["connection"] = conn
    getattr(command, direction)(config, rev)


def _row(cluster_id, source, context, server, updated_at):
    from sqlalchemy import text

    return text(
        "INSERT INTO clusters (id, name, source, context_name, server, original_server, provider,"
        " region, environment, kubeconfig_encrypted, created_at, updated_at) VALUES"
        f" ('{cluster_id}', '{context}', '{source}', '{context}', '{server}', NULL, 'kind', NULL,"
        f" 'development', x'00', '2026-01-01', '{updated_at}')"
    )


async def test_migration_0003_collapses_duplicates(tmp_settings):
    from sqlalchemy import text

    engine = make_engine(tmp_settings.db_url)
    async with engine.begin() as conn:
        await conn.run_sync(_migrate, "upgrade", "0002")
        for stmt in (
            _row("old", "kubeconfig", "kind-dev", "https://h:41001", "2026-01-01 10:00:00"),
            _row("new", "kubeconfig", "kind-dev", "https://h:52002", "2026-01-02 10:00:00"),
            _row("other", "kubeconfig", "lab", "https://lab:6443", "2026-01-01 09:00:00"),
        ):
            await conn.execute(stmt)
    await init_db(engine)
    async with engine.connect() as conn:
        rows = (
            await conn.execute(text("SELECT id, source, server FROM clusters ORDER BY id"))
        ).all()
    await engine.dispose()
    assert [tuple(r) for r in rows] == [
        ("new", "file", "https://h:52002"),
        ("other", "file", "https://lab:6443"),
    ]


async def test_migration_0003_downgrade_restores_old_identity(tmp_settings):
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    engine = make_engine(tmp_settings.db_url)
    await init_db(engine)
    async with engine.begin() as conn:
        await conn.execute(_row("f", "file", "kind-dev", "https://h:1", "2026-01-01 10:00:00"))
        await conn.execute(_row("g", "file", "lab", "https://lab:6443", "2026-01-01 10:00:00"))
        # Same context and server as "f", newer: the two collapse under the old identity.
        await conn.execute(_row("x", "upload", "kind-dev", "https://h:1", "2026-01-02 11:00:00"))
    async with engine.begin() as conn:
        await conn.run_sync(_migrate, "downgrade", "0002")
    async with engine.connect() as conn:
        rows = (await conn.execute(text("SELECT id, source FROM clusters ORDER BY id"))).all()
    assert [tuple(r) for r in rows] == [("g", "kubeconfig"), ("x", "kubeconfig")]
    # The old identity includes the server again: a second address for the same context is allowed.
    async with engine.begin() as conn:
        await conn.execute(_row("p", "kubeconfig", "kind-dev", "https://h:3", "2026-01-03"))
    with pytest.raises(IntegrityError):
        async with engine.begin() as conn:
            await conn.execute(_row("q", "kubeconfig", "kind-dev", "https://h:3", "2026-01-03"))
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM clusters WHERE id = 'p'"))
    await init_db(engine)  # and back up again
    async with engine.connect() as conn:
        rows = (await conn.execute(text("SELECT id, source FROM clusters ORDER BY id"))).all()
    await engine.dispose()
    assert [tuple(r) for r in rows] == [("g", "file"), ("x", "file")]


async def test_migration_0004_upgrade_and_downgrade(tmp_settings):
    from sqlalchemy import text

    def tables_and_indexes(conn):
        found = inspect(conn)
        names = set(found.get_table_names())
        indexes = {i["name"] for i in found.get_indexes("audit")} if "audit" in names else set()
        return names, indexes

    engine = make_engine(tmp_settings.db_url)
    async with engine.begin() as conn:
        await conn.run_sync(_migrate, "upgrade", "0003")
        await conn.execute(_row("f", "file", "kind-dev", "https://h:1", "2026-01-01 10:00:00"))
    await init_db(engine)
    async with engine.begin() as conn:
        names, indexes = await conn.run_sync(tables_and_indexes)
        assert "audit" in names
        assert indexes == {"ix_audit_started_at", "ix_audit_cluster_id"}
        await conn.execute(
            text(
                "INSERT INTO audit (started_at, actor, action, cluster_id, cluster_name, provider,"
                " namespace, kind, name, outcome) VALUES ('2026-11-07 10:00:00', 'local',"
                " 'cordon', 'f', 'kind-dev', 'kind', NULL, 'nodes', 'worker', 'started')"
            )
        )
        row = (await conn.execute(text("SELECT id, namespace, diff FROM audit"))).one()
        assert tuple(row) == (1, None, None)
    async with engine.begin() as conn:
        await conn.run_sync(_migrate, "downgrade", "0003")
    async with engine.connect() as conn:
        names, _ = await conn.run_sync(tables_and_indexes)
        clusters = (await conn.execute(text("SELECT id FROM clusters"))).all()
    await engine.dispose()
    assert "audit" not in names
    assert [tuple(r) for r in clusters] == [("f",)]


async def test_migration_0005_upgrade_and_downgrade(tmp_settings):
    from sqlalchemy import text

    def schema(conn):
        found = inspect(conn)
        return set(found.get_table_names()), {col["name"] for col in found.get_columns("clusters")}

    engine = make_engine(tmp_settings.db_url)
    async with engine.begin() as conn:
        await conn.run_sync(_migrate, "upgrade", "0004")
        await conn.execute(_row("f", "file", "kind-dev", "https://h:1", "2026-01-01 10:00:00"))
        old_tables, old_columns = await conn.run_sync(schema)
    async with engine.begin() as conn:
        await conn.run_sync(_migrate, "upgrade", "0005")
        tables, columns = await conn.run_sync(schema)
        assert tables - old_tables == {"cloud_accounts", "cloud_discovered"}
        assert columns - old_columns == {
            "cloud_account_id",
            "cloud_resource_id",
            "cloud_details",
            "kubernetes_version",
            "node_pools",
            "node_count",
            "cloud_missing_since",
        }
        assert (
            await conn.execute(text("SELECT cloud_account_id FROM clusters"))
        ).scalar_one() is None
        await conn.execute(_row("c", "cloud", "sample-resource", "https://h:2", "2026-01-02"))
    async with engine.begin() as conn:
        await conn.run_sync(_migrate, "downgrade", "0004")
        assert await conn.run_sync(schema) == (old_tables, old_columns)
        assert (await conn.execute(text("SELECT id FROM clusters"))).scalar_one() == "f"
    await engine.dispose()
