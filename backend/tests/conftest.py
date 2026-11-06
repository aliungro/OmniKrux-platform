from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from omnikrux.clusters.models import Environment, Provider
from omnikrux.clusters.registry import ClusterInfo, ClusterRegistry
from omnikrux.config import DEFAULT_ALLOWED_HOSTS, Settings
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.main import create_app
from omnikrux.security.secrets import SecretBox
from omnikrux.watch.hub import WatchHub
from tests.clusters.test_kubeconfig import kc
from tests.watch.fakes import FakeSource


@pytest.fixture(autouse=True)
def allow_testserver_host(monkeypatch):
    """Starlette's TestClient sends `Host: testserver`; allow it next to the real defaults."""
    monkeypatch.setenv("OMNIKRUX_ALLOWED_HOSTS", ",".join([*DEFAULT_ALLOWED_HOSTS, "testserver"]))


@pytest.fixture
def tmp_settings(tmp_path):
    return Settings(data_dir=tmp_path, kubeconfig="", in_container=False)


@pytest_asyncio.fixture
async def registry(tmp_path):
    settings = Settings(data_dir=tmp_path, kubeconfig="", in_container=False)
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/omnikrux.db")
    await init_db(engine)
    yield ClusterRegistry(make_sessionmaker(engine), SecretBox.from_settings(settings))
    await engine.dispose()


@pytest.fixture
def app_with_kubeconfig(tmp_path):
    path = tmp_path / "config"
    path.write_text(kc([("kind-omnikrux-dev", "https://127.0.0.1:6443", None)]), encoding="utf-8")
    app = create_app(Settings(data_dir=tmp_path, kubeconfig=str(path)))
    with TestClient(app) as client:
        yield client, path


class FakeRegistry:
    def __init__(self, infos: list[ClusterInfo]):
        self._infos = infos

    async def list(self) -> list[ClusterInfo]:
        return list(self._infos)


def _cluster(cluster_id: str) -> ClusterInfo:
    return ClusterInfo(
        id=cluster_id,
        name=cluster_id,
        context_name=cluster_id,
        server=f"https://{cluster_id}.example:6443",
        original_server=None,
        provider=Provider.KIND,
        region=None,
        environment=Environment.DEVELOPMENT,
    )


@pytest.fixture
def fake_registry_two_clusters():
    return FakeRegistry([_cluster("good"), _cluster("bad")])


@pytest.fixture
def app_with_fake_sources(tmp_path, fake_registry_two_clusters):
    """The real app, with `app.state.hub` swapped (inside the lifespan) for a hub of FakeSources."""
    from tests.watch.test_cache import p

    async def source_for(cluster_id, spec):
        return await FakeSource(lists=[([p("a")], "1")], watches=[[]]).factory()

    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    real_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        async with real_lifespan(app):
            app.state.hub = WatchHub(fake_registry_two_clusters, source_for)
            try:
                yield
            finally:
                await app.state.hub.close()

    app.router.lifespan_context = lifespan
    with TestClient(app) as client:
        yield client
