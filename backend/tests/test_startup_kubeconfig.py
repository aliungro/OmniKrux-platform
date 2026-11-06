import logging
import os
from pathlib import Path

import pytest
import yaml
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
    real = ClusterRegistry.upsert_contexts

    async def flaky(self, contexts, **kwargs):
        if any(c.context_name == "explodes" for c in contexts):
            raise KeyError("boom")
        return await real(self, contexts, **kwargs)

    monkeypatch.setattr(ClusterRegistry, "upsert_contexts", flaky)
    settings = Settings(data_dir=tmp_path, kubeconfig=os.pathsep.join([str(bad), str(good)]))
    with (
        caplog.at_level(logging.WARNING, logger="omnikrux.main"),
        TestClient(create_app(settings)) as client,
    ):
        assert [c["name"] for c in client.get("/api/clusters").json()] == ["kind-omnikrux-dev"]
    assert any(str(bad) in r.getMessage() and "KeyError" in r.getMessage() for r in caplog.records)


def _names(settings: Settings) -> list[str]:
    with TestClient(create_app(settings)) as client:
        return sorted(c["name"] for c in client.get("/api/clusters").json())


def _two_files(tmp_path: Path) -> tuple[Path, Path, Settings]:
    first, second = tmp_path / "first", tmp_path / "second"
    first.write_text(kc([("kind-a", "https://127.0.0.1:6443", None)]), encoding="utf-8")
    second.write_text(kc([("kind-b", "https://127.0.0.1:6444", None)]), encoding="utf-8")
    settings = Settings(data_dir=tmp_path, kubeconfig=os.pathsep.join([str(first), str(second)]))
    assert _names(settings) == ["kind-a", "kind-b"]
    return first, second, settings


def test_startup_removes_contexts_that_left_the_files(tmp_path):
    first, _, settings = _two_files(tmp_path)
    first.write_text(kc([("kind-c", "https://127.0.0.1:6445", None)]), encoding="utf-8")
    assert _names(settings) == ["kind-b", "kind-c"]


def test_unreadable_file_skips_reconcile(tmp_path, monkeypatch):
    first, _, settings = _two_files(tmp_path)
    real_read_text = Path.read_text

    def deny(self, *args, **kwargs):
        if self == first:
            raise PermissionError(13, "Permission denied")
        return real_read_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", deny)
    assert _names(settings) == ["kind-a", "kind-b"]


@pytest.mark.parametrize("damage", ["missing", "unparseable", "empty"])
def test_missing_or_broken_file_skips_reconcile(tmp_path, damage):
    first, _, settings = _two_files(tmp_path)
    if damage == "missing":
        first.unlink()
    else:
        first.write_text("::: nope" if damage == "unparseable" else "", encoding="utf-8")
    assert _names(settings) == ["kind-a", "kind-b"]


def test_no_configured_files_never_reconciles(tmp_path):
    _two_files(tmp_path)
    assert _names(Settings(data_dir=tmp_path, kubeconfig="")) == ["kind-a", "kind-b"]


def test_first_file_wins_for_a_context_defined_twice(tmp_path, caplog):
    first, second = tmp_path / "first", tmp_path / "second"
    first.write_text(kc([("shared", "https://127.0.0.1:6443", None)]), encoding="utf-8")
    second.write_text(
        kc(
            [("shared", "https://127.0.0.1:7000", None), ("kind-b", "https://127.0.0.1:6444", None)]
        ),
        encoding="utf-8",
    )
    settings = Settings(data_dir=tmp_path, kubeconfig=os.pathsep.join([str(first), str(second)]))
    for _ in range(2):  # the ignored copy still counts as seen: a restart keeps the cluster
        caplog.clear()
        with (
            caplog.at_level(logging.WARNING, logger="omnikrux.main"),
            TestClient(create_app(settings)) as client,
        ):
            servers = {c["name"]: c["server"] for c in client.get("/api/clusters").json()}
        assert servers == {"shared": "https://127.0.0.1:6443", "kind-b": "https://127.0.0.1:6444"}
        [warning] = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
        assert "shared" in warning and str(first) in warning and str(second) in warning


def test_file_with_no_usable_context_skips_reconcile(tmp_path, caplog):
    first, _, settings = _two_files(tmp_path)
    doc = yaml.safe_load(first.read_text(encoding="utf-8"))
    doc["contexts"][0]["context"] = "not a mapping"
    first.write_text(yaml.safe_dump(doc), encoding="utf-8")
    with caplog.at_level(logging.WARNING, logger="omnikrux.main"):
        assert _names(settings) == ["kind-a", "kind-b"]
    assert any(str(first) in r.getMessage() for r in caplog.records if r.name == "omnikrux.main")


def test_malformed_context_is_removed_while_the_rest_of_its_file_imports(tmp_path):
    path = tmp_path / "config"
    path.write_text(
        kc(
            [("kind-a", "https://127.0.0.1:6443", None), ("kind-c", "https://127.0.0.1:6445", None)]
        ),
        encoding="utf-8",
    )
    settings = Settings(data_dir=tmp_path, kubeconfig=str(path))
    assert _names(settings) == ["kind-a", "kind-c"]
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    doc["contexts"][1]["context"] = "not a mapping"
    path.write_text(yaml.safe_dump(doc), encoding="utf-8")
    assert _names(settings) == ["kind-a"]


def test_reconcile_error_does_not_stop_startup(tmp_path, monkeypatch, caplog):
    from omnikrux.clusters.registry import ClusterRegistry

    first, _, settings = _two_files(tmp_path)
    first.write_text(kc([("kind-c", "https://127.0.0.1:6445", None)]), encoding="utf-8")

    async def broken(self, seen):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(ClusterRegistry, "reconcile_files", broken)
    with (
        caplog.at_level(logging.WARNING, logger="omnikrux.main"),
        TestClient(create_app(settings)) as client,
    ):
        assert client.get("/api/health").json() == {"status": "ok"}
        names = sorted(c["name"] for c in client.get("/api/clusters").json())
    assert names == ["kind-a", "kind-b", "kind-c"]
    assert any("RuntimeError" in r.getMessage() for r in caplog.records)
