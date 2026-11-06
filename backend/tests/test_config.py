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
