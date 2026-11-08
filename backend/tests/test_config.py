import os
from pathlib import Path

import pytest

from omnikrux.config import Settings
from omnikrux.main import create_app


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


def test_rewrite_loopback_follows_in_container_unless_set(monkeypatch):
    monkeypatch.delenv("OMNIKRUX_REWRITE_LOOPBACK", raising=False)
    assert Settings(in_container=True).loopback_rewrite is True
    assert Settings(in_container=False).loopback_rewrite is False
    assert Settings(in_container=True, rewrite_loopback=False).loopback_rewrite is False
    monkeypatch.setenv("OMNIKRUX_REWRITE_LOOPBACK", "false")
    assert Settings(in_container=True).loopback_rewrite is False
    assert Settings(in_container=True).kubeconfig_paths == [
        Path("/kube/config")
    ]  # path choice unchanged


def test_debug_image_default_and_env(monkeypatch):
    monkeypatch.delenv("OMNIKRUX_DEBUG_IMAGE", raising=False)
    assert Settings().debug_image == "busybox:1.36"
    monkeypatch.setenv("OMNIKRUX_DEBUG_IMAGE", "registry.local/toolbox:2")
    assert Settings().debug_image == "registry.local/toolbox:2"


def test_port_forward_bind_defaults_to_loopback_even_in_a_container(monkeypatch):
    monkeypatch.delenv("OMNIKRUX_PORT_FORWARD_BIND", raising=False)
    assert Settings().forward_bind == "127.0.0.1"
    assert Settings(in_container=True).forward_bind == "127.0.0.1"
    assert Settings(in_container=True, rewrite_loopback=False).forward_bind == "127.0.0.1"


def test_port_forward_bind_override(monkeypatch):
    monkeypatch.setenv("OMNIKRUX_PORT_FORWARD_BIND", " 0.0.0.0 ")
    assert Settings(in_container=True).forward_bind == "0.0.0.0"
    monkeypatch.setenv("OMNIKRUX_PORT_FORWARD_BIND", "::1")
    assert Settings().forward_bind == "::1"


@pytest.mark.parametrize("value", ["localhost", "0.0.0.0.0", "", "127.0.0.1:80", "10.0.0.0/8"])
def test_bad_port_forward_bind_plain_startup_error(tmp_path, value):
    with pytest.raises(SystemExit) as stopped:
        create_app(Settings(data_dir=tmp_path, kubeconfig="", port_forward_bind=value))
    assert str(stopped.value) == (
        "Omnikrux can't start: OMNIKRUX_PORT_FORWARD_BIND must be an IP address like 127.0.0.1 "
        f"or 0.0.0.0, not {value!r}."
    )
