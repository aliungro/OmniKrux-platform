from sqlalchemy import inspect

from omnikrux.db import init_db, make_engine


async def test_init_db_creates_clusters_table(tmp_settings):
    engine = make_engine(tmp_settings.db_url)
    await init_db(engine)
    async with engine.connect() as conn:
        cols = await conn.run_sync(lambda c: {x["name"] for x in inspect(c).get_columns("clusters")})
    await engine.dispose()
    assert {"id", "name", "context_name", "server", "provider", "environment", "kubeconfig_encrypted"} <= cols


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
        diff = await conn.run_sync(lambda c: compare_metadata(MigrationContext.configure(c), Base.metadata))
    await engine.dispose()
    assert diff == []
