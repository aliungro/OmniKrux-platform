import logging
from pathlib import Path

from fastapi.testclient import TestClient

from omnikrux.config import Settings
from omnikrux.main import create_app
from tests.clusters.test_kubeconfig import kc


def test_unreadable_kubeconfig_warns_and_startup_continues(tmp_path, monkeypatch, caplog):
    path = tmp_path / "config"
    path.write_text(kc([("kind-omnikrux-dev", "https://127.0.0.1:6443", None)]), encoding="utf-8")
    real_read_text = Path.read_text

    def deny(self, *args, **kwargs):
        if self == path:
            raise PermissionError(13, "Permission denied")
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", deny)
    app = create_app(Settings(data_dir=tmp_path, kubeconfig=str(path)))
    with caplog.at_level(logging.WARNING, logger="omnikrux.main"), TestClient(app) as client:
        assert client.get("/api/health").json() == {"status": "ok"}
        assert client.get("/api/clusters").json() == []
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert str(path) in warnings[0]
    assert "--user" in warnings[0]
