"""The audit log on a real SQLite file: begin, finish, list, and rows a stopped console left."""

import logging

import pytest
from sqlalchemy import text

from omnikrux.audit.store import (
    INTERRUPTED,
    AuditEntry,
    AuditLog,
    AuditUnavailable,
    no_audit_message,
)
from omnikrux.clusters.registry import SOURCE_UPLOAD, ClusterRegistry
from omnikrux.config import Settings
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.main import create_app
from omnikrux.security.secrets import SecretBox
from tests.clusters.test_kubeconfig import kc


@pytest.fixture
async def setup(tmp_path):
    """(audit log, the prod-east cluster's info, engine)"""
    settings = Settings(data_dir=tmp_path, kubeconfig="", in_container=False)
    engine = make_engine(settings.db_url)
    await init_db(engine)
    sessionmaker = make_sessionmaker(engine)
    registry = ClusterRegistry(sessionmaker, SecretBox.from_settings(settings))
    [info] = await registry.upsert_from_kubeconfig(
        kc([("prod-east", "https://prod.example:6443", None)]),
        rewrite_loopback=False,
        source=SOURCE_UPLOAD,
    )
    yield AuditLog(sessionmaker, registry), info, engine
    await engine.dispose()


def entry(cluster_id: str, **overrides) -> AuditEntry:
    values = {
        "actor": "local",
        "action": "scale",
        "cluster_id": cluster_id,
        "namespace": "demo",
        "kind": "deployments.apps",
        "name": "web",
    }
    return AuditEntry(**(values | overrides))


async def test_audit_begin_finish_and_list_newest_first(setup, caplog):
    audit, info, _ = setup
    first = await audit.begin(
        entry(info.id, details={"summary": ["Scale from 2 to 3 replicas."]}, diff="-a\n+b\n")
    )
    second = await audit.begin(entry("gone-cluster", action="delete", name="api"))
    await audit.finish(first, "succeeded", "Scaled.")

    page = await audit.list()

    assert [r.id for r in page.records] == [second, first]
    assert page.next_before is None
    newer, older = page.records
    assert (older.cluster_name, older.provider) == ("prod-east", "onprem")  # snapshotted
    assert (older.actor, older.action, older.namespace, older.kind, older.name) == (
        "local",
        "scale",
        "demo",
        "deployments.apps",
        "web",
    )
    assert (older.outcome, older.message) == ("succeeded", "Scaled.")
    assert older.details == {"summary": ["Scale from 2 to 3 replicas."]}
    assert older.diff == "-a\n+b\n"
    assert older.started_at.tzinfo is not None and older.finished_at >= older.started_at
    # A cluster the registry doesn't know is named by its id.
    assert (newer.cluster_id, newer.cluster_name, newer.provider) == (
        "gone-cluster",
        "gone-cluster",
        "unknown",
    )
    assert (newer.outcome, newer.finished_at, newer.details, newer.diff) == (
        "started",
        None,
        None,
        None,
    )

    # A finished record stays as it finished; an unknown id is only a warning.
    with caplog.at_level(logging.WARNING, logger="omnikrux.audit.store"):
        await audit.finish(first, "failed", "again")
        await audit.finish(99_999, "succeeded")
    assert (await audit.list()).records[1].outcome == "succeeded"
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 2


async def test_audit_list_filters_and_paging(setup):
    audit, info, _ = setup
    ids = [
        await audit.begin(entry(info.id, name="web")),
        await audit.begin(entry(info.id, action="shell", kind="pods", name="web-1")),
        await audit.begin(entry("other", action="shell", kind="pods", name="api-1")),
        await audit.begin(entry("other", action="cordon", namespace=None, kind="nodes", name="n1")),
        await audit.begin(
            entry(info.id, action="node_shell", kind="pods", name="p", details={"node": "w-9"})
        ),
    ]
    await audit.finish(ids[0], "failed", "Deployment web changed since you reviewed it.")

    async def listed(**kwargs) -> list[int]:
        return [r.id for r in (await audit.list(**kwargs)).records]

    assert await listed(cluster_id="other") == [ids[3], ids[2]]
    assert await listed(action="shell") == [ids[2], ids[1]]
    assert await listed(text="WEB") == [ids[1], ids[0]]  # name, any case
    assert await listed(text="changed since") == [ids[0]]  # message
    assert await listed(text="prod-east", action="shell") == [ids[1]]  # cluster name
    assert await listed(text="w-9") == [ids[4]]  # details
    assert await listed(text="%") == []  # a literal, not a wildcard
    assert (await audit.list(cluster_id="other")).records[0].namespace is None

    page = await audit.list(limit=2)
    assert [r.id for r in page.records] == [ids[4], ids[3]] and page.next_before == ids[3]
    page = await audit.list(limit=2, before=page.next_before)
    assert [r.id for r in page.records] == [ids[2], ids[1]] and page.next_before == ids[1]
    page = await audit.list(limit=2, before=page.next_before)
    assert [r.id for r in page.records] == [ids[0]] and page.next_before is None

    accented = await audit.begin(entry(info.id, action="node_shell", details={"node": "wörker"}))
    assert await listed(text="wörker") == [accented]  # non-ASCII details are searchable


async def test_started_records_marked_unknown_on_startup(tmp_path):
    settings = Settings(data_dir=tmp_path, kubeconfig="", in_container=False)
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        audit = app.state.audit
        running = await audit.begin(entry("c1", action="shell", kind="pods"))
        done = await audit.begin(entry("c1"))
        await audit.finish(done, "succeeded", "Scaled.")
        assert await audit.mark_interrupted() == 1
        await audit.begin(entry("c1", action="drain", namespace=None, kind="nodes"))

    app = create_app(settings)  # the console starts again
    async with app.router.lifespan_context(app):
        records = {r.id: r for r in (await app.state.audit.list()).records}

    assert (records[running].outcome, records[running].message) == ("unknown", INTERRUPTED)
    assert INTERRUPTED == "The console stopped before this finished."
    assert records[done].outcome == "succeeded"
    assert [r.outcome for r in records.values()].count("unknown") == 2


async def test_begin_raises_audit_unavailable_with_reason(setup, caplog):
    audit, info, engine = setup
    async with engine.begin() as conn:
        await conn.execute(text("DROP TABLE audit"))

    with pytest.raises(AuditUnavailable) as raised:
        await audit.begin(entry(info.id))
    assert raised.value.reason == "no such table: audit"
    assert no_audit_message(raised.value) == (
        "Nothing was changed: the audit log can't be written (no such table: audit)."
    )

    with caplog.at_level(logging.WARNING, logger="omnikrux.audit.store"):
        await audit.finish(1, "succeeded")  # never raises
    assert "Could not finish audit record 1" in caplog.text
