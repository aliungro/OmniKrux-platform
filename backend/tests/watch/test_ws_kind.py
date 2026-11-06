import subprocess

import pytest
from fastapi.testclient import TestClient

from omnikrux.config import Settings
from omnikrux.main import create_app
from tests.kube.test_source_kind import find_kind

pytestmark = pytest.mark.kind


@pytest.fixture
def kind_kubeconfig(tmp_path):
    if (kind := find_kind()) is None:
        pytest.skip("kind is not installed")
    result = subprocess.run([kind, "get", "kubeconfig", "--name", "omnikrux-dev"], check=False, capture_output=True, text=True)
    if result.returncode != 0:
        pytest.skip("kind cluster omnikrux-dev not running (scripts/dev-kind.sh)")
    path = tmp_path / "config"
    path.write_text(result.stdout, encoding="utf-8")
    return path


def test_ws_streams_kind_pods(tmp_path, kind_kubeconfig):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig=str(kind_kubeconfig), in_container=False))
    with TestClient(app) as client:
        with client.websocket_connect("/api/watch?kind=pods") as ws:
            rows = []
            while True:  # status messages, then the snapshot parts
                msg = ws.receive_json()
                assert msg["type"] != "cluster_status" or msg["state"] != "error", msg
                if msg["type"] == "snapshot":
                    rows += msg["rows"]
                    if msg["last"]:
                        break
        assert ("demo", "crasher") in {(r["namespace"], r["name"]) for r in rows}
        assert client.get("/api/clusters").json()[0]["state"] == "ready"
