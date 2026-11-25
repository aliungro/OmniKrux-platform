"""The install records on a real SQLite file: one per cluster, busy while a job runs, interrupted
at startup, migration 0010; the audit actions; installed sources; leftover Helm folders."""

import asyncio
import os
import time
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from sqlalchemy import inspect

from omnikrux.audit.store import AuditEntry
from omnikrux.config import Settings
from omnikrux.db import MIGRATIONS_DIR, init_db, make_engine, make_sessionmaker
from omnikrux.main import create_app
from omnikrux.monitoring.install.kubeconfig import (
    FOLDER_PREFIX,
    STALE_FOLDER_SECONDS,
    remove_leftover_folders,
)
from omnikrux.monitoring.install.settings import InstallSettings
from omnikrux.monitoring.install.store import INTERRUPTED, InstallBusy, InstallStore
from tests.monitoring.conftest import new_source

T0 = datetime(2026, 11, 24, 12, 0, tzinfo=UTC)
CHARTS = {"kube-prometheus-stack": "1.2.3", "loki": "4.5.6"}


@pytest.fixture
async def installs(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/i.db")
    await init_db(engine)
    yield InstallStore(make_sessionmaker(engine))
    await engine.dispose()


async def begin(store: InstallStore, cluster="c1", job="j1", **over):
    args = {
        "namespace": "monitoring",
        "components": ("metrics", "logs"),
        "settings": InstallSettings(),
        "charts": CHARTS,
    }
    args.update(over)
    return await store.begin(
        cluster,
        args["namespace"],
        args["components"],
        args["settings"],
        args["charts"],
        job_id=job,
        project_id="p1",
    )


async def test_one_record_per_cluster_and_busy(installs):
    first = await begin(installs, job="j1")
    assert first.state == "installing" and first.components == ("metrics", "logs")
    assert first.settings == InstallSettings() and dict(first.charts) == CHARTS
    with pytest.raises(InstallBusy) as busy:
        await begin(installs, job="j2")
    assert busy.value.state == "installing"
    again = await begin(installs, job="j1", namespace="obs")  # the same job may update
    assert again.id == first.id and again.namespace == "obs"
    await installs.finish("c1", "failed", "no")
    second = await begin(installs, job="j2")
    assert second.id == first.id and second.state == "installing" and second.message is None
    assert len(await installs.list()) == 1
    await installs.finish("c1", "installed", None)
    await installs.begin_uninstall("c1", job_id="j2")
    with pytest.raises(InstallBusy) as busy:
        await begin(installs, job="j3")
    assert busy.value.state == "uninstalling"


async def test_settings_round_trip(installs):
    custom = replace(InstallSettings(), retention_days=30, persist=False, namespace="obs")
    await begin(installs, settings=custom, namespace="obs")
    assert (await installs.get("c1")).settings == custom


async def test_finish_records_sources_and_time(installs):
    await begin(installs)
    done = await installs.finish(
        "c1", "installed", "done", sources={"prometheus": "s1", "loki": "s3", "alertmanager": None}
    )
    assert done.state == "installed" and done.message == "done"
    assert (done.prometheus_source_id, done.alertmanager_source_id, done.loki_source_id) == (
        "s1",
        None,
        "s3",
    )
    assert done.installed_at is not None and done.installed_at.tzinfo is not None
    kept = await installs.finish("c1", "failed", "later", sources=None)
    assert kept.prometheus_source_id == "s1"
    with pytest.raises(KeyError):
        await installs.finish("nope", "failed", "x")


async def test_contacts_and_remove(installs):
    await begin(installs)
    record = await installs.set_contacts("c1", digest="abc", message="ok", at=T0)
    assert (record.contacts_digest, record.contacts_message, record.contacts_applied_at) == (
        "abc",
        "ok",
        T0,
    )
    await installs.remove("c1")
    assert await installs.get("c1") is None
    await installs.remove("c1")  # nothing to remove is fine


async def test_mark_interrupted_words(installs):
    await begin(installs, "c1", "j1")
    await begin(installs, "c2", "j2")
    await installs.finish("c2", "installed", None)
    await installs.begin_uninstall("c2", job_id="j3")
    await begin(installs, "c3", "j4")
    await installs.finish("c3", "cancelled", "stopped")
    assert await installs.mark_interrupted(T0) == 2
    assert (await installs.get("c1")).message == INTERRUPTED.format(what="install")
    assert (await installs.get("c2")).message == INTERRUPTED.format(what="uninstall")
    assert (await installs.get("c3")).state == "cancelled"
    assert (await installs.get("c1")).state == "failed"


async def test_interrupted_installs_are_marked_on_start(tmp_path):
    def app():
        return create_app(
            Settings(
                data_dir=tmp_path,
                kubeconfig="",
                in_container=False,
                rewrite_loopback=False,
                alert_engine=False,
            )
        )

    first = app()
    async with first.router.lifespan_context(first):
        await begin(first.state.monitoring.installs, "c1", "j1")
    second = app()
    async with second.router.lifespan_context(second):
        services = second.state.monitoring
        record = await services.installs.get("c1")
        assert record.state == "failed"
        assert record.message == INTERRUPTED.format(what="install")
        assert services.install_tools is not None and services.helm is not None


def test_leftover_helm_folders_are_removed(tmp_path):
    old = time.time() - STALE_FOLDER_SECONDS - 60
    mine = tmp_path / f"{FOLDER_PREFIX}abc"
    run = tmp_path / f"{FOLDER_PREFIX}run-xyz"
    young = tmp_path / f"{FOLDER_PREFIX}young"
    other = tmp_path / "somebody-else"
    for folder in (mine, run, young, other):
        folder.mkdir()
        (folder / "kubeconfig").write_text("x")
    for folder in (mine, run, other):
        os.utime(folder, (old, old))
    plain = tmp_path / f"{FOLDER_PREFIX}file"
    plain.write_text("a file, not a folder")
    assert remove_leftover_folders(tmp_path) == 2
    assert not mine.exists() and not run.exists()
    assert other.exists() and plain.exists()
    assert young.exists()  # may be another OmniKrux process running a call
    assert remove_leftover_folders(tmp_path / "missing") == 0


def test_leftover_sweep_skips_links(tmp_path):
    target = tmp_path / "target"
    target.mkdir()
    (target / "keep").write_text("x")
    link = tmp_path / f"{FOLDER_PREFIX}link"
    try:
        link.symlink_to(target, target_is_directory=True)
    except OSError:
        pytest.skip("this system will not create a link")
    assert remove_leftover_folders(tmp_path, older_than=0) == 0
    assert (target / "keep").exists()


async def test_start_sweeps_the_injected_folder_only(tmp_path):
    from omnikrux.monitoring import services

    old = time.time() - STALE_FOLDER_SECONDS - 60
    stale = tmp_path / "helm-temp-sweep" / f"{FOLDER_PREFIX}stale"
    stale.mkdir()
    os.utime(stale, (old, old))
    assert services.helm_temp_root() == tmp_path / "helm-temp-sweep"
    app = create_app(
        Settings(
            data_dir=tmp_path / "data",
            kubeconfig="",
            in_container=False,
            rewrite_loopback=False,
            alert_engine=False,
        )
    )
    async with app.router.lifespan_context(app):
        assert not stale.exists()


async def test_two_starts_at_once_give_one_busy(installs):
    results = await asyncio.gather(
        begin(installs, job="j1"), begin(installs, job="j2"), return_exceptions=True
    )
    assert sorted(type(r).__name__ for r in results) == ["InstallBusy", "InstallRecord"]
    await installs.finish("c1", "installed", None)
    results = await asyncio.gather(
        installs.begin_uninstall("c1", job_id="u1"),
        installs.begin_uninstall("c1", job_id="u2"),
        return_exceptions=True,
    )
    assert sorted(type(r).__name__ for r in results) == ["InstallBusy", "InstallRecord"]


async def test_migration_0010_up_and_down(tmp_path):
    from alembic import command
    from alembic.config import Config

    def migrate(conn, direction, rev):
        config = Config()
        config.set_main_option("script_location", str(MIGRATIONS_DIR))
        config.attributes["connection"] = conn
        getattr(command, direction)(config, rev)

    def tables(conn):
        return set(inspect(conn).get_table_names())

    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/m.db")
    await init_db(engine)
    async with engine.begin() as conn:
        assert "monitoring_installs" in await conn.run_sync(tables)
        uniques = await conn.run_sync(
            lambda c: inspect(c).get_unique_constraints("monitoring_installs")
        )
        assert [u["column_names"] for u in uniques] == [["cluster_id"]]
        await conn.run_sync(migrate, "downgrade", "0009")
        names = await conn.run_sync(tables)
        assert "monitoring_installs" not in names and "monitoring_alert_rules" in names
    await init_db(engine)
    async with engine.connect() as conn:
        assert "monitoring_installs" in await conn.run_sync(tables)
    await engine.dispose()


@pytest.mark.parametrize("action", ["install", "uninstall"])
async def test_install_actions_are_audit_actions(monitoring_app, action):
    _, app = monitoring_app
    entry = AuditEntry(
        actor="local",
        action=action,
        cluster_id="c1",
        namespace="monitoring",
        kind="helm",
        name="x",
    )
    audit_id = await app.state.audit.begin(entry)
    await app.state.audit.finish(audit_id, "succeeded", "ok")
    page = await app.state.audit.list(action=action)
    assert [(r.id, r.action, r.outcome) for r in page.records] == [(audit_id, action, "succeeded")]


async def test_sources_can_be_marked_as_installed_by_omnikrux(monitoring_app):
    _, app = monitoring_app
    sources = app.state.monitoring.sources
    source = await sources.create(new_source(name="Made by us"))
    assert source.installed_by_omnikrux is False
    await sources.set_installed_by_omnikrux(source.id, True)
    assert (await sources.get(source.id)).installed_by_omnikrux is True
    await sources.set_installed_by_omnikrux(source.id, False)
    assert (await sources.get(source.id)).installed_by_omnikrux is False
    with pytest.raises(KeyError):
        await sources.set_installed_by_omnikrux("missing", True)


async def test_installed_flag_joins_a_callers_transaction(monitoring_app):
    _, app = monitoring_app
    services = app.state.monitoring
    source = await services.sources.create(new_source(name="In a transaction"))
    with pytest.raises(RuntimeError):
        async with services.sessionmaker.begin() as session:
            await services.sources.set_installed_by_omnikrux(source.id, True, session=session)
            raise RuntimeError("roll back")
    assert (await services.sources.get(source.id)).installed_by_omnikrux is False
    async with services.sessionmaker.begin() as session:
        await services.sources.set_installed_by_omnikrux(source.id, True, session=session)
    assert (await services.sources.get(source.id)).installed_by_omnikrux is True
