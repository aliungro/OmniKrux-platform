"""Shared Monitoring fixtures: the stores over a fresh SQLite file, and the app."""

import faulthandler
import itertools
import os
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
import yaml
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.kube.connections import ClusterConnections
from omnikrux.main import create_app
from omnikrux.monitoring.dashboards.store import DashboardStore
from omnikrux.monitoring.projects.store import GroupStore, ProjectStore
from omnikrux.monitoring.sources.store import NewSource, SourceStore
from omnikrux.monitoring.sources.transport import TransportFactory
from omnikrux.monitoring.sources.types import SourceConfig, SourceSecrets
from omnikrux.security.secrets import SecretBox
from tests.fakekube import kubeconfig_for
from tests.monitoring.fakes import (
    TlsMaterial,
    make_tls_material,
    serve_fake_grafana,
    serve_fake_loki,
    serve_fake_prometheus,
)

_names = itertools.count(1)

# A Monitoring test that runs this long is stuck: print every thread's stack and end the run.
WATCHDOG_SECONDS = 300


@pytest.fixture(scope="session")
def _terminal_fd(request):
    """A copy of the real stderr, taken while capture is paused, so a dump reaches the terminal."""
    capman = request.config.pluginmanager.getplugin("capturemanager")
    if capman is None:
        fd = os.dup(sys.__stderr__.fileno())
    else:
        with capman.global_and_fixture_disabled():
            fd = os.dup(sys.__stderr__.fileno())
    yield fd
    os.close(fd)


@pytest.fixture(autouse=True)
def _watchdog(_terminal_fd):
    """Bound every Monitoring test: a hang dumps all stacks and exits instead of waiting forever."""
    faulthandler.dump_traceback_later(WATCHDOG_SECONDS, exit=True, file=_terminal_fd)
    yield
    faulthandler.cancel_dump_traceback_later()


@dataclass
class Stores:
    """The stores the Monitoring services are built on, and their sessionmaker (for writes that
    share one transaction)."""

    sources: SourceStore
    projects: ProjectStore
    groups: GroupStore
    dashboards: DashboardStore
    sessionmaker: async_sessionmaker[AsyncSession]


@dataclass(frozen=True)
class LinkedProject:
    """A custom project linked to one Prometheus source with the filter `cluster="a"`."""

    project_id: str
    source_id: str
    project_name: str


def new_source(**over) -> NewSource:
    """A URL-reached Prometheus without authentication; `over` replaces any field."""
    values = {
        "name": f"Prometheus · test {next(_names)}",
        "type": "prometheus",
        "reach": "url",
        "url": "http://prometheus.example:9090",
    }
    return NewSource(**(values | over))


@pytest.fixture
def db_path(tmp_path) -> Path:
    return tmp_path / "omnikrux.db"


@pytest.fixture
async def stores(tmp_path, db_path):
    settings = Settings(data_dir=tmp_path, kubeconfig="", in_container=False)
    engine = make_engine(f"sqlite+aiosqlite:///{db_path}")
    await init_db(engine)
    sessionmaker = make_sessionmaker(engine)
    box = SecretBox.from_settings(settings)
    yield Stores(
        sources=SourceStore(sessionmaker, box),
        projects=ProjectStore(sessionmaker),
        groups=GroupStore(sessionmaker),
        dashboards=DashboardStore(sessionmaker),
        sessionmaker=sessionmaker,
    )
    await engine.dispose()


@pytest.fixture
def monitoring_client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    with TestClient(app) as client:
        yield client


@pytest.fixture
async def monitoring_app(tmp_path):
    """The real app with its lifespan running, and an httpx client talking to it in-process."""
    app = create_app(
        Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            yield http, app


@pytest.fixture
async def kube_cluster(fake_api, monitoring_app) -> str:
    """Register the fake Kubernetes API as a cluster of the running app; return its id."""
    _, app = monitoring_app
    [info] = await app.state.registry.upsert_from_kubeconfig(
        yaml.safe_dump(kubeconfig_for(fake_api)), rewrite_loopback=False, source=SOURCE_UPLOAD
    )
    return info.id


@pytest.fixture
async def fake_prometheus():
    async with serve_fake_prometheus() as server:
        yield server


@pytest.fixture
async def linked_project(monitoring_app, fake_prometheus) -> LinkedProject:
    """A custom project linked to a Prometheus source over `fake_prometheus` with the filter
    `cluster="a"`, created through the API as a user would (a source, then the setup)."""
    http, _ = monitoring_app
    return await _shop_project(http, fake_prometheus.url)


@dataclass(frozen=True)
class LinkedProjectWithLoki(LinkedProject):
    """`linked_project`'s project, with a Loki source linked second with the same filter."""

    loki_source_id: str


@pytest.fixture
async def linked_project_with_loki(
    monitoring_app, fake_prometheus, fake_loki
) -> LinkedProjectWithLoki:
    """`linked_project`'s shape (the Prometheus source and the project are both "Shop", filter
    `cluster="a"`), then a Loki source "Shop logs" over `fake_loki` linked with the same filter
    by a later PUT, so the links read Prometheus, then Loki. Created through the API."""
    http, _ = monitoring_app
    shop = await _shop_project(http, fake_prometheus.url)
    source = await http.post(
        "/api/monitoring/sources",
        json={"type": "loki", "reach": "url", "url": fake_loki.url, "name": "Shop logs"},
    )
    assert source.status_code == 201, source.text
    loki_id = source.json()["id"]
    link = await http.put(
        f"/api/monitoring/projects/{shop.project_id}/sources/{loki_id}",
        json={"filter": 'cluster="a"'},
    )
    assert link.status_code == 200, link.text
    return LinkedProjectWithLoki(
        project_id=shop.project_id,
        source_id=shop.source_id,
        project_name=shop.project_name,
        loki_source_id=loki_id,
    )


async def _shop_project(http: httpx.AsyncClient, prometheus_url: str) -> LinkedProject:
    source = await http.post(
        "/api/monitoring/sources",
        json={"type": "prometheus", "reach": "url", "url": prometheus_url, "name": "Shop"},
    )
    assert source.status_code == 201, source.text
    source_id = source.json()["id"]
    project = await http.post(
        "/api/monitoring/setup",
        json={
            "name": "Shop",
            "kind": "custom",
            "sources": [{"source_id": source_id, "filter": 'cluster="a"'}],
        },
    )
    assert project.status_code == 201, project.text
    body = project.json()
    return LinkedProject(project_id=body["id"], source_id=source_id, project_name=body["name"])


@dataclass(frozen=True)
class TwoProjects:
    """One Prometheus source linked to two custom projects: `a` (filter `cluster="a"`) and `b`
    (filter `cluster="b"`). `a` and `b` are project ids."""

    source_id: str
    a: str
    b: str


@pytest.fixture
async def two_projects_on_one_source(monitoring_app, fake_prometheus) -> TwoProjects:
    """Two custom projects over one Prometheus source on `fake_prometheus`, each with its own
    filter, created through the API as a user would (a source, then one setup per project)."""
    http, _ = monitoring_app
    source = await http.post(
        "/api/monitoring/sources",
        json={"type": "prometheus", "reach": "url", "url": fake_prometheus.url, "name": "Shared"},
    )
    assert source.status_code == 201, source.text
    source_id = source.json()["id"]
    ids = []
    for name, filter in (("Team A", 'cluster="a"'), ("Team B", 'cluster="b"')):
        project = await http.post(
            "/api/monitoring/setup",
            json={
                "name": name,
                "kind": "custom",
                "sources": [{"source_id": source_id, "filter": filter}],
            },
        )
        assert project.status_code == 201, project.text
        ids.append(project.json()["id"])
    return TwoProjects(source_id=source_id, a=ids[0], b=ids[1])


@pytest.fixture
async def fake_loki():
    async with serve_fake_loki() as server:
        yield server


@pytest.fixture
async def fake_grafana():
    async with serve_fake_grafana() as server:
        yield server


@pytest.fixture(scope="session")
def fake_tls() -> TlsMaterial:
    return make_tls_material()


@pytest.fixture
async def fake_prometheus_mtls(fake_tls):
    """An HTTPS Prometheus that requires a client certificate signed by `fake_tls`'s CA."""
    async with serve_fake_prometheus(fake_tls, mtls=True) as server:
        yield server


@pytest.fixture
async def direct(registry):
    """`direct(url, type="prometheus", name=...)`: the transport of a URL-reached source."""
    factory = TransportFactory(ClusterConnections(registry), registry)

    def make(url: str, type: str = "prometheus", name: str = "Source · test", **over):
        now = datetime.now(UTC)
        values = {
            "id": "src-1",
            "name": name,
            "type": type,
            "reach": "url",
            "url": url,
            "cluster": None,
            "path_prefix": "",
            "auth_type": "none",
            "username": None,
            "header_name": None,
            "client_cert_pem": None,
            "ca_pem": None,
            "header_names": (),
            "secrets": SourceSecrets(),
            "created_by_project_id": None,
            "created_at": now,
            "updated_at": now,
            "check": None,
        }
        return factory.for_source(SourceConfig(**(values | over)))

    yield make
    await factory.close()
