import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.config import Settings
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.main import create_app
from omnikrux.security.secrets import SecretBox
from tests.clusters.test_kubeconfig import kc


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
