import pytest

from omnikrux.config import Settings


@pytest.fixture
def tmp_settings(tmp_path):
    return Settings(data_dir=tmp_path, kubeconfig="", in_container=False)
