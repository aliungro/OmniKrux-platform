import json

import aiohttp
import pytest
from kubernetes_asyncio.client.exceptions import ApiException
from kubernetes_asyncio.stream import WsApiClient

from omnikrux.config import Settings
from omnikrux.kube.client import ClusterUnavailable
from omnikrux.kube.connections import ClusterConnections, kube_error_message
from omnikrux.main import create_app
from omnikrux.resources.kinds import KINDS
from tests.fakekube import kubeconfig_for


class FakeRegistry:
    def __init__(self, kubeconfigs: dict[str, dict]):
        self._kubeconfigs = kubeconfigs

    async def get_kubeconfig(self, cluster_id: str) -> dict:
        return self._kubeconfigs[cluster_id]


async def test_api_context_closes_client(fake_api):
    connections = ClusterConnections(FakeRegistry({"c1": kubeconfig_for(fake_api)}))
    async with connections.api("c1") as api:
        version = await api.call_api(
            "/version", "GET", auth_settings=["BearerToken"], _preload_content=False
        )
        assert version.status == 200
        version.release()
        assert not api.rest_client.pool_manager.closed
    assert api.rest_client.pool_manager.closed


async def test_open_api_is_owned_by_the_caller(fake_api):
    connections = ClusterConnections(FakeRegistry({"c1": kubeconfig_for(fake_api)}))
    api = await connections.open_api("c1")
    try:
        assert not api.rest_client.pool_manager.closed
    finally:
        await api.close()
    assert api.rest_client.pool_manager.closed


async def test_ws_api_builds_and_closes(fake_api):
    connections = ClusterConnections(FakeRegistry({"c1": kubeconfig_for(fake_api)}))
    async with connections.ws_api("c1") as ws:
        assert isinstance(ws, WsApiClient)
        assert ws.configuration.host == fake_api.url
        assert not ws.rest_client.pool_manager.closed
    assert ws.rest_client.pool_manager.closed


async def test_unknown_cluster_keyerror():
    connections = ClusterConnections(FakeRegistry({}))
    with pytest.raises(KeyError):
        async with connections.api("nope"):
            pass
    with pytest.raises(KeyError):
        await connections.open_api("nope")
    with pytest.raises(KeyError):
        async with connections.ws_api("nope"):
            pass


async def test_missing_exec_plugin_is_cluster_unavailable_for_both_clients():
    config = {
        "clusters": [{"name": "x", "cluster": {"server": "https://1.2.3.4"}}],
        "users": [{"name": "x", "user": {"exec": {"command": "definitely-not-installed-xyz"}}}],
    }
    connections = ClusterConnections(FakeRegistry({"c": config}))
    with pytest.raises(ClusterUnavailable, match="definitely-not-installed-xyz"):
        async with connections.api("c"):
            pass
    with pytest.raises(ClusterUnavailable, match="definitely-not-installed-xyz"):
        async with connections.ws_api("c"):
            pass


def _api_exc(status: int, body: dict | None = None) -> ApiException:
    exc = ApiException(status=status, reason="whatever")
    exc.body = json.dumps(body) if body is not None else None
    return exc


@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (
            _api_exc(401),
            "The cluster rejected the console's credentials while trying to list pods.",
        ),
        (
            _api_exc(403, {"message": 'pods is forbidden: User "x" cannot list'}),
            'Not allowed to list pods: pods is forbidden: User "x" cannot list',
        ),
        (_api_exc(403), "Not allowed to list pods: forbidden"),
        (_api_exc(404), "list pods: not found (it may have just been deleted)."),
        (
            _api_exc(400, {"message": 'container "x" is not valid for pod "p"'}),
            'Couldn\'t list pods: container "x" is not valid for pod "p"',
        ),
        (_api_exc(400), "Couldn't list pods: the cluster refused the request"),
        (TimeoutError(), "The cluster didn't answer while trying to list pods."),
        (aiohttp.ServerTimeoutError(), "The cluster didn't answer while trying to list pods."),
        (
            ClusterUnavailable("This cluster signs in with 'aws', which isn't installed."),
            "This cluster signs in with 'aws', which isn't installed.",
        ),
        (
            RuntimeError("boom\nTraceback secret line"),
            "Couldn't list pods: RuntimeError: boom",
        ),
        (
            _api_exc(500, {"message": "internal"}),
            "Couldn't list pods: ApiException: (500)",
        ),
    ],
)
def test_kube_error_message_variants(exc, expected):
    assert kube_error_message(exc, "list pods") == expected


def test_kube_error_message_connector_error():
    key = aiohttp.client_reqrep.ConnectionKey("h", 1, False, None, None, None, None)
    exc = aiohttp.ClientConnectorError(key, OSError("connection refused"))
    message = kube_error_message(exc, "list pods")
    assert message.startswith("Can't reach the cluster while trying to list pods: ")
    assert "connection refused" in message


def test_kube_error_message_other_is_short_and_one_line():
    message = kube_error_message(ValueError("x" * 500), "do it")
    assert message.startswith("Couldn't do it: ValueError: ")
    assert len(message.split(": ", 2)[2]) <= 200
    assert "\n" not in message


async def test_source_for_uses_connections(fake_api, tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    async with app.router.lifespan_context(app):
        assert isinstance(app.state.connections, ClusterConnections)
        app.state.connections._registry = FakeRegistry({"c1": kubeconfig_for(fake_api)})
        source = await app.state.hub._source_for("c1", KINDS["pods"])
        try:
            items, rv = await source.list()
        finally:
            await source.aclose()
    assert rv == "42" and items[0]["metadata"]["name"] == "web-1"
