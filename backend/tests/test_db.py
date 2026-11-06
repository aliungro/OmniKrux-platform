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
