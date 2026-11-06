import pytest

from omnikrux.clusters.kubeconfig import parse_kubeconfig
from omnikrux.kube.client import ClusterUnavailable, make_api_client
from tests.clusters.test_kubeconfig import kc


async def test_tls_server_name_applied():
    p = parse_kubeconfig(kc([("kind-dev", "https://127.0.0.1:6443", None)]), rewrite_loopback=True)[0]
    # The kc() helper's CA data is a placeholder, not a real certificate; drop it so
    # the client builds its SSL context from the system trust store.
    del p.standalone["clusters"][0]["cluster"]["certificate-authority-data"]
    api = await make_api_client(p.standalone)
    try:
        assert api.configuration.host == "https://host.docker.internal:6443"
        assert api.configuration.tls_server_name == "127.0.0.1"
    finally:
        await api.close()


async def test_missing_exec_plugin_is_a_clear_error():
    p = parse_kubeconfig(kc([("x", "https://1.2.3.4", "definitely-not-installed-xyz")]), rewrite_loopback=False)[0]
    with pytest.raises(ClusterUnavailable, match="definitely-not-installed-xyz"):
        await make_api_client(p.standalone)
