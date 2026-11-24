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
from omnikrux.monitoring.alerts.contact_points.store import ContactPointStore
from omnikrux.monitoring.alerts.engine import AlertEngine
from omnikrux.monitoring.alerts.notify import Notifier
from omnikrux.monitoring.alerts.store import AlertStore
from omnikrux.monitoring.dashboards.store import DashboardStore
from omnikrux.monitoring.install import connect as install_connect
from omnikrux.monitoring.install import readiness
from omnikrux.monitoring.install.values import RELEASES
from omnikrux.monitoring.projects.store import GroupStore, ProjectStore
from omnikrux.monitoring.sources.store import NewSource, SourceStore
from omnikrux.monitoring.sources.transport import TransportFactory
from omnikrux.monitoring.sources.types import SourceConfig, SourceSecrets
from omnikrux.monitoring.transfer.grafana_store import GrafanaStore
from omnikrux.monitoring.transfer.origins import OriginStore
from omnikrux.security.secrets import SecretBox
from tests.fakekube import kubeconfig_for, prometheus_operator
from tests.monitoring.alert_env import CONTACT_POINTS, EngineEnv, no_sleep
from tests.monitoring.fake_helm import AvailableTools, FakeHelm
from tests.monitoring.fake_receivers import serve_fake_smtp, serve_fake_webhook
from tests.monitoring.fakes import (
    Bearer,
    TlsMaterial,
    grafana_answer,
    make_tls_material,
    serve_fake_alertmanager,
    serve_fake_grafana,
    serve_fake_loki,
    serve_fake_prometheus,
)
from tests.monitoring.install_env import (
    InstalledCluster,
    install_plan,
    mark_all_ready,
    prepare_install,
    wait_job,
)
from tests.monitoring.install_env import apply as apply_plan

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
    alerts: AlertStore
    contact_points: ContactPointStore
    sessionmaker: async_sessionmaker[AsyncSession]
    origins: OriginStore
    grafana: GrafanaStore


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
        alerts=AlertStore(sessionmaker),
        contact_points=ContactPointStore(sessionmaker, box),
        sessionmaker=sessionmaker,
        origins=OriginStore(sessionmaker),
        grafana=GrafanaStore(sessionmaker, box),
    )
    await engine.dispose()


@pytest.fixture
def monitoring_client(tmp_path):
    # No alert engine loop in API tests: a test that checks rules drives `engine.tick(now)`.
    app = create_app(
        Settings(data_dir=tmp_path, kubeconfig="", in_container=False, alert_engine=False)
    )
    with TestClient(app) as client:
        yield client


@pytest.fixture
async def monitoring_app(tmp_path):
    """The real app with its lifespan running, and an httpx client talking to it in-process."""
    app = create_app(
        Settings(
            data_dir=tmp_path,
            kubeconfig="",
            in_container=False,
            rewrite_loopback=False,
            alert_engine=False,
        )
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
async def connections(monitoring_app) -> ClusterConnections:
    """The running app's `ClusterConnections`."""
    _, app = monitoring_app
    return app.state.connections


@pytest.fixture
async def fake_helm(monitoring_app) -> FakeHelm:
    """A `FakeHelm` as the app's Helm runner, with a tools check that reports the pinned Helm and
    charts available (at placeholder paths)."""
    _, app = monitoring_app
    helm = FakeHelm()
    services = app.state.monitoring
    services.helm = helm
    services.install_tools = AvailableTools()
    return helm


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
async def fake_alertmanager():
    async with serve_fake_alertmanager() as server:
        yield server


@pytest.fixture
async def fake_webhook():
    async with serve_fake_webhook() as server:
        yield server


@pytest.fixture
async def fake_smtp():
    async with serve_fake_smtp() as server:
        yield server


@pytest.fixture
async def fake_smtp_tls(fake_tls):
    """An SMTP server offering STARTTLS (and AUTH only after it) with `fake_tls`'s certificate."""
    async with serve_fake_smtp(fake_tls) as server:
        yield server


@pytest.fixture
async def fake_grafana():
    async with serve_fake_grafana() as server:
        yield server


# The service account token `fake_grafana_auth` wants (made up).
GRAFANA_TOKEN = "glsa_SECRET-11"


@pytest.fixture
async def fake_grafana_auth():
    """A fake Grafana that wants the bearer token `GRAFANA_TOKEN` for everything but its health,
    with three dashboards: "Overview" at the root, "api" and "Nodes" in the folder "Platform"."""
    async with serve_fake_grafana() as server:
        server.require = Bearer(GRAFANA_TOKEN)
        server.dashboards = {
            "nodes": grafana_answer("nodes", "Nodes", folder="Platform", tags=("k8s",)),
            "api": grafana_answer("api", "api", folder="Platform"),
            "overview": grafana_answer("overview", "Overview"),
        }
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


@pytest.fixture
async def engine_env(monitoring_app, fake_prometheus, linked_project, fake_webhook):
    """`linked_project` ("Shop" on `fake_prometheus`, filter `cluster="a"`) with a webhook
    contact point "Ops hook" on `fake_webhook`, and the app's services with an alert engine that
    runs no loop (tests drive `tick(now)`) and a notifier that waits nothing between retries."""
    http, app = monitoring_app
    services = app.state.monitoring
    services.notifier = Notifier(services, sleep=no_sleep)
    services.engine = AlertEngine(services, enabled=False)
    created = await http.post(
        CONTACT_POINTS,
        json={
            "name": "Ops hook",
            "type": "webhook",
            "secrets": {"url": f"{fake_webhook.url}/hook"},
        },
    )
    assert created.status_code == 201, created.text
    yield EngineEnv(
        http=http,
        app=app,
        services=services,
        engine=services.engine,
        prom=fake_prometheus,
        webhook=fake_webhook,
        project_id=linked_project.project_id,
        source_id=linked_project.source_id,
        cp_id=created.json()["id"],
    )
    # Whatever a test left hanging answers now, so nothing waits on it at shutdown.
    fake_prometheus.release.set()
    fake_webhook.release.set()
    await services.engine.stop()
    await services.notifier.drain(10)


@dataclass(frozen=True)
class InstalledBackends:
    """The fake tools behind the Services an install makes in namespace `monitoring`."""

    prometheus: object
    alertmanager: object
    loki: object


@pytest.fixture
def fast_install(monkeypatch):
    """The install job's waits shortened: readiness and source tests poll every 20 ms, and a
    source that never answers gives up after a second."""
    monkeypatch.setattr(readiness, "READY_INTERVAL_SECONDS", 0.02)
    monkeypatch.setattr(install_connect, "CONNECT_INTERVAL_SECONDS", 0.02)
    monkeypatch.setattr(install_connect, "CONNECT_TIMEOUT_SECONDS", 1.0)
    monkeypatch.setattr(install_connect, "TEST_SECONDS", 1.0)


@pytest.fixture
async def installed_backends(fake_api, fake_prometheus, fake_alertmanager, fake_loki):
    """The fake Kubernetes API's service proxy relays the three installed Services (in
    `monitoring`) to M1's fake Prometheus and Loki and M4's fake Alertmanager."""
    for specs in RELEASES.values():
        for spec in specs:
            for kind, (service, port) in spec.services.items():
                server = {
                    "prometheus": fake_prometheus,
                    "alertmanager": fake_alertmanager,
                    "loki": fake_loki,
                }[kind]
                fake_api.service_backends[("monitoring", f"{service}:{port}")] = server.url
    return InstalledBackends(fake_prometheus, fake_alertmanager, fake_loki)


@pytest.fixture
async def installed_cluster(
    monitoring_app, kube_cluster, fake_api, fake_helm, installed_backends, fast_install
) -> InstalledCluster:
    """A cluster with a finished install of metrics and logs in `monitoring` (record
    `installed`, Helm release records on the fake API) and its three connected sources."""
    http, _ = monitoring_app
    prepare_install(fake_api, fake_helm)
    mark_all_ready(fake_api, "monitoring")
    plan = await install_plan(http, kube_cluster, ["metrics", "logs"])
    out = await apply_plan(http, plan)
    job = await wait_job(http, out["job_id"])
    assert job["state"] == "succeeded", job
    sources = {
        s["type"]: s["id"]
        for s in (await http.get("/api/monitoring/sources")).json()
        if s["installed_by_omnikrux"]
    }
    return InstalledCluster(
        cluster_id=kube_cluster, namespace="monitoring", project_id=None, sources=sources, job=job
    )


# A Slack address with a secret in its path: it must never leave the backend except into the
# Secret OmniKrux writes into its own Alertmanager.
WEBHOOK_URL = "https://hooks.slack.example.test/services/T000/B000/XXXX-SECRET"
HOOK_URL = "https://hooks.example.test/omnikrux/XXXX-SECRET-HOOK"


@dataclass(frozen=True)
class ToolRuleWithContacts:
    """A rule that runs in the installed Prometheus and notifies two contact points."""

    rule_id: str
    cp_id: str  # Slack, at WEBHOOK_URL
    hook_id: str  # a webhook, at HOOK_URL
    project_id: str
    cluster_id: str


@pytest.fixture
async def tool_rule_with_contacts(
    monitoring_app, installed_cluster, fake_api
) -> ToolRuleWithContacts:
    """On `installed_cluster`: the Prometheus Operator's resources served (as the chart's CRDs
    serve them) with OmniKrux's Prometheus behind its Service; a project linked to the installed
    Prometheus; a Slack contact point (at `WEBHOOK_URL`) and a webhook (at `HOOK_URL`); and a
    rule that runs in Prometheus notifying both."""
    http, app = monitoring_app
    services = app.state.monitoring
    prometheus_operator(
        fake_api,
        name="omnikrux-metrics-prometheus",
        service="omnikrux-metrics-prometheus",
        rule_selector={"matchLabels": {"release": "omnikrux-metrics"}},
    )
    prometheus_id = installed_cluster.sources["prometheus"]
    services.capabilities.forget(prometheus_id)
    project = await http.post(
        "/api/monitoring/setup",
        json={
            "name": "Cluster apps",
            "kind": "custom",
            "sources": [{"source_id": prometheus_id, "filter": 'namespace="shop"'}],
        },
    )
    assert project.status_code == 201, project.text
    project_id = project.json()["id"]
    ids = []
    for body in (
        {"name": "Ops Slack", "type": "slack", "secrets": {"webhook_url": WEBHOOK_URL}},
        {"name": "Ops hook", "type": "webhook", "secrets": {"url": HOOK_URL}},
    ):
        created = await http.post(CONTACT_POINTS, json=body)
        assert created.status_code == 201, created.text
        ids.append(created.json()["id"])
    rule = await http.post(
        "/api/monitoring/alerts/rules",
        json={
            "name": "API latency high",
            "scope": {"kind": "project", "id": project_id},
            "source": {"type": "prometheus", "id": prometheus_id},
            "expr": "rate(http_seconds_sum[5m])",
            "condition": {"op": "above", "threshold": 0.3, "for": "5m", "every": "1m"},
            "engine": "tool",
            "contact_point_ids": ids,
        },
    )
    assert rule.status_code == 201, rule.text
    [target] = rule.json()["rule"]["targets"]
    assert target["engine"] == "tool", target
    return ToolRuleWithContacts(
        rule_id=rule.json()["rule"]["id"],
        cp_id=ids[0],
        hook_id=ids[1],
        project_id=project_id,
        cluster_id=installed_cluster.cluster_id,
    )
