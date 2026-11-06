"""KubeResourceSource against a real local HTTP server standing in for the Kubernetes API.

Unlike test_source.py, nothing here is mocked inside kubernetes_asyncio: discovery, the probe and
the list go through its real REST client, so timeouts and error mapping are exercised end to end.
"""

import asyncio
import tempfile
import time

import pytest
from aiohttp import web

from omnikrux.kube.client import ClusterUnavailable, make_api_client
from omnikrux.kube.source import KubeResourceSource
from omnikrux.resources.kinds import KINDS

TOKEN = "fake-api-token"


def status_body(code: int, reason: str, message: str) -> dict:
    return {"kind": "Status", "apiVersion": "v1", "status": "Failure", "code": code, "reason": reason, "message": message}


POD = {"metadata": {"name": "web-1", "namespace": "demo", "uid": "u1", "resourceVersion": "41"}}

ROUTES = {
    "/version": {"major": "1", "minor": "31", "gitVersion": "v1.31.0"},
    "/api": {"kind": "APIVersions", "versions": ["v1"]},
    "/apis": {"kind": "APIGroupList", "apiVersion": "v1", "groups": []},
    "/api/v1": {
        "kind": "APIResourceList",
        "groupVersion": "v1",
        "resources": [
            {"name": "pods", "singularName": "pod", "namespaced": True, "kind": "Pod", "verbs": ["get", "list", "watch"]}
        ],
    },
    "/api/v1/pods": {"kind": "PodList", "apiVersion": "v1", "metadata": {"resourceVersion": "42"}, "items": [POD]},
}


class FakeKubeApi:
    """A tiny Kubernetes API: `mode` picks how it answers.

    ok: discovery + pod list; unauthorized: 401 everywhere; hang: never answers;
    apis_unauthorized: everything works except `/apis`, which answers 401.
    """

    def __init__(self) -> None:
        self.mode = "ok"
        self.paths: list[str] = []
        self.auth: set[str | None] = set()
        self.release = asyncio.Event()
        self.url = ""

    async def handle(self, request: web.Request) -> web.Response:
        self.paths.append(request.path)
        self.auth.add(request.headers.get("Authorization"))
        if self.mode == "hang":
            await self.release.wait()
        if self.mode == "unauthorized" or (self.mode == "apis_unauthorized" and request.path == "/apis"):
            return web.json_response(status_body(401, "Unauthorized", "Unauthorized"), status=401)
        if (body := ROUTES.get(request.path)) is None:
            return web.json_response(status_body(404, "NotFound", "not found"), status=404)
        return web.json_response(body)


@pytest.fixture
async def fake_api(tmp_path, monkeypatch):
    # The dynamic client caches discovery in the temp dir, keyed by host: keep runs independent.
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    server = FakeKubeApi()
    app = web.Application()
    app.router.add_route("GET", "/{tail:.*}", server.handle)
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    server.url = f"http://127.0.0.1:{port}"
    try:
        yield server
    finally:
        server.release.set()
        await runner.cleanup()


async def source_for(server: FakeKubeApi, **kwargs) -> KubeResourceSource:
    kubeconfig = {
        "apiVersion": "v1",
        "kind": "Config",
        "current-context": "fake",
        "clusters": [{"name": "fake", "cluster": {"server": server.url}}],
        "users": [{"name": "fake", "user": {"token": TOKEN}}],
        "contexts": [{"name": "fake", "context": {"cluster": "fake", "user": "fake"}}],
    }
    return KubeResourceSource(await make_api_client(kubeconfig), KINDS["pods"], **kwargs)


async def test_happy_path_lists_pods_through_real_discovery(fake_api):
    source = await source_for(fake_api)
    try:
        items, rv = await source.list()
    finally:
        await source.aclose()
    assert items == [POD] and rv == "42"
    assert fake_api.paths[0] == "/api"  # the probe runs before discovery
    assert "/api/v1/pods" in fake_api.paths
    assert fake_api.auth == {f"Bearer {TOKEN}"}


async def test_unauthorized_during_discovery_gives_the_credentials_message(fake_api):
    fake_api.mode = "unauthorized"
    source = await source_for(fake_api)
    try:
        with pytest.raises(ClusterUnavailable) as info:
            await source.list()
    finally:
        await source.aclose()
    assert info.value.message == "The cluster rejected the console's credentials: Unauthorized"


async def test_unexpected_discovery_answer_is_a_plain_cluster_unavailable(fake_api):
    fake_api.mode = "apis_unauthorized"  # the probe passes, discovery then trips over a Status body
    source = await source_for(fake_api)
    try:
        with pytest.raises(ClusterUnavailable) as info:
            await source.list()
    finally:
        await source.aclose()
    assert info.value.message == "The cluster's API discovery failed: it answered with something unexpected"
    assert "NoneType" not in info.value.message


async def test_a_silent_api_times_out_within_the_bound(fake_api):
    fake_api.mode = "hang"
    source = await source_for(fake_api, discovery_timeout=0.5)
    started = time.monotonic()
    try:
        with pytest.raises(ClusterUnavailable) as info:
            await source.list()
    finally:
        await source.aclose()
    assert time.monotonic() - started < 5
    assert info.value.message == "The cluster API did not respond within 0.5 s"
