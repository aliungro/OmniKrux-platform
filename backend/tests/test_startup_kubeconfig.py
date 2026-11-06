import logging
import os
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


def test_int_context_name_does_not_stop_startup(tmp_path):
    path = tmp_path / "config"
    path.write_text(
        kc([("kind-omnikrux-dev", "https://127.0.0.1:6443", None)]).replace(
            "kind-omnikrux-dev", "2024"
        ),
        encoding="utf-8",
    )
    with TestClient(create_app(Settings(data_dir=tmp_path, kubeconfig=str(path)))) as client:
        assert [c["name"] for c in client.get("/api/clusters").json()] == ["2024"]


def test_unexpected_error_in_one_file_skips_only_that_file(tmp_path, monkeypatch, caplog):
    from omnikrux.clusters.registry import ClusterRegistry

    bad, good = tmp_path / "bad", tmp_path / "good"
    bad.write_text(kc([("explodes", "https://a:6443", None)]), encoding="utf-8")
    good.write_text(kc([("kind-omnikrux-dev", "https://127.0.0.1:6443", None)]), encoding="utf-8")
    real = ClusterRegistry.upsert_from_kubeconfig

    async def flaky(self, text, **kwargs):
        if "explodes" in text:
            raise KeyError("boom")
        return await real(self, text, **kwargs)

    monkeypatch.setattr(ClusterRegistry, "upsert_from_kubeconfig", flaky)
    settings = Settings(data_dir=tmp_path, kubeconfig=os.pathsep.join([str(bad), str(good)]))
    with (
        caplog.at_level(logging.WARNING, logger="omnikrux.main"),
        TestClient(create_app(settings)) as client,
    ):
        assert [c["name"] for c in client.get("/api/clusters").json()] == ["kind-omnikrux-dev"]
    assert any(str(bad) in r.getMessage() and "KeyError" in r.getMessage() for r in caplog.records)
