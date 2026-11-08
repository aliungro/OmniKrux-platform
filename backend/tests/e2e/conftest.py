"""Fixtures for the kind end-to-end tests: the real app on the kubeconfig of `omnikrux-dev`."""

import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from omnikrux.config import Settings
from omnikrux.main import create_app
from tests.kube.test_source_kind import find_kind


@pytest.fixture
def kind_kubeconfig(tmp_path):
    if (kind := find_kind()) is None:
        pytest.skip("kind is not installed")
    result = subprocess.run(
        [kind, "get", "kubeconfig", "--name", "omnikrux-dev"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip("kind cluster omnikrux-dev not running (scripts/dev-kind.sh)")
    path = tmp_path / "config"
    path.write_text(result.stdout, encoding="utf-8")
    return path


@pytest.fixture
def client(tmp_path, kind_kubeconfig):
    app = create_app(
        Settings(data_dir=tmp_path, kubeconfig=str(kind_kubeconfig), in_container=False)
    )
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def cluster(client):
    clusters = client.get("/api/clusters").json()
    assert len(clusters) == 1, clusters
    return clusters[0]["id"]


@pytest.fixture(autouse=True)
def need_kubectl():
    if shutil.which("kubectl") is None:
        pytest.skip("kubectl is not installed")
