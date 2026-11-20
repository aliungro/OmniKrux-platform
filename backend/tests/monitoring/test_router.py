"""The Monitoring router's shared checks and audit helpers."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from omnikrux.audit.store import AuditLog, AuditUnavailable
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.router import router


@pytest.fixture(autouse=True)
def ping_route():
    """A test-only GET /api/monitoring/ping on the real router, added before the app is built
    (autouse fixtures run before `monitoring_client`) and removed afterwards."""

    async def ping() -> dict[str, str]:
        return {"pong": "yes"}

    router.add_api_route("/ping", ping, methods=["GET"])
    added = router.routes[-1]
    yield
    router.routes.remove(added)


def test_monitoring_routes_refuse_cross_origin(monitoring_client):
    r = monitoring_client.get("/api/monitoring/ping", headers={"Origin": "http://evil.example"})
    assert r.status_code == 403 and r.json() == {"detail": "Cross-origin request refused"}


def test_monitoring_routes_answer_the_same_origin(monitoring_client):
    r = monitoring_client.get("/api/monitoring/ping", headers={"Origin": "http://testserver"})
    assert r.status_code == 200 and r.json() == {"pong": "yes"}
    assert monitoring_client.get("/api/monitoring/ping").status_code == 200


def test_the_app_builds_the_monitoring_services(monitoring_client):
    services = monitoring_client.app.state.monitoring
    assert services.sources and services.projects and services.groups


@pytest.fixture
async def audit_log(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/audit.db")
    await init_db(engine)
    yield AuditLog(make_sessionmaker(engine), registry=None)
    await engine.dispose()


async def test_begin_and_finish_change_write_a_monitoring_record(audit_log):
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(audit=audit_log)))
    record_id = await begin_change(
        request, "project_add", "project", "shop", {"kind": "kubernetes"}
    )
    await finish_change(request, record_id, True)
    other = await begin_change(request, "group_remove", "group", "team")
    await finish_change(request, other, False, "It went wrong.")
    page = await audit_log.list()
    by_id = {r.id: r for r in page.records}
    first, second = by_id[record_id], by_id[other]
    assert (first.app, first.action, first.kind, first.name, first.outcome) == (
        "monitoring",
        "project_add",
        "project",
        "shop",
        "succeeded",
    )
    assert first.cluster_id == "" and first.details == {"kind": "kubernetes"}
    assert (second.outcome, second.message) == ("failed", "It went wrong.")


async def test_begin_change_refuses_without_an_audit_log():
    class Broken:
        async def begin_app(self, entry):
            raise AuditUnavailable("disk I/O error")

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(audit=Broken())))
    with pytest.raises(HTTPException) as caught:
        await begin_change(request, "source_add", "source", "x")
    assert caught.value.status_code == 503
    assert caught.value.detail == (
        "Nothing was changed: the audit log can't be written (disk I/O error)."
    )
