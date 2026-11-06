import os
from pathlib import Path

from omnikrux.config import Settings


def test_default_db_url_lives_in_data_dir(tmp_path):
    s = Settings(data_dir=tmp_path)
    assert s.db_url == f"sqlite+aiosqlite:///{tmp_path}/omnikrux.db"


def test_kubeconfig_default_in_container():
    assert Settings(in_container=True).kubeconfig_paths == [Path("/kube/config")]


def test_kubeconfig_path_list_and_empty(tmp_path):
    s = Settings(kubeconfig=f"{tmp_path}/a{os.pathsep}{tmp_path}/b")
    assert s.kubeconfig_paths == [tmp_path / "a", tmp_path / "b"]
    assert Settings(kubeconfig="").kubeconfig_paths == []


def test_allowed_hosts_default_is_loopback_only(monkeypatch):
    monkeypatch.delenv("OMNIKRUX_ALLOWED_HOSTS", raising=False)
    assert Settings().allowed_hosts == ["localhost", "127.0.0.1", "[::1]", "*.localhost"]


def test_allowed_hosts_from_env_is_comma_separated(monkeypatch):
    monkeypatch.setenv("OMNIKRUX_ALLOWED_HOSTS", " omnikrux.lan , 10.0.0.5,")
    assert Settings().allowed_hosts == ["omnikrux.lan", "10.0.0.5"]
    monkeypatch.setenv("OMNIKRUX_ALLOWED_HOSTS", "*")
    assert Settings().allowed_hosts == ["*"]
