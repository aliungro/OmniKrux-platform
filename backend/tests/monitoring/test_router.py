"""The Monitoring router's shared checks and audit helpers."""

from types import SimpleNamespace

import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel

from omnikrux.audit.store import AuditLog, AuditUnavailable
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.router import adopt, router


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


class Shown(BaseModel):
    kept: str


def test_adopt_keeps_every_route_setting():
    ran: list[str] = []

    def dependency(label: str):
        async def run() -> None:
            ran.append(label)

        return Depends(run)

    feature = APIRouter(prefix="/things", dependencies=[dependency("feature")])

    @feature.post(
        "/{id}",
        status_code=202,
        response_model=Shown,
        dependencies=[dependency("route")],
        responses={418: {"description": "Teapot"}},
        summary="Make a thing",
        tags=["things"],
    )
    async def make(id: str) -> dict:
        return {"kept": id, "dropped": "never shown"}

    @feature.get("/hidden", include_in_schema=False)
    async def hidden() -> dict:
        return {}

    target = APIRouter(prefix="/api/x", dependencies=[dependency("outer")])
    adopt(feature, into=target)
    app = FastAPI()
    app.include_router(target)
    with TestClient(app) as client:
        r = client.post("/api/x/things/a")
        assert r.status_code == 202 and r.json() == {"kept": "a"}
        assert ran == ["outer", "feature", "route"]
        schema = client.get("/openapi.json").json()["paths"]
    operation = schema["/api/x/things/{id}"]["post"]
    assert operation["summary"] == "Make a thing" and operation["tags"] == ["things"]
    assert "418" in operation["responses"] and "202" in operation["responses"]
    assert "/api/x/things/hidden" not in schema


def test_adopt_refuses_what_it_cannot_carry():
    feature = APIRouter()
    feature.add_api_websocket_route("/ws", lambda websocket: None)
    with pytest.raises(TypeError):
        adopt(feature, into=APIRouter())
