import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

import aiohttp
import pytest
import yaml
from aiohttp import web
from fastapi.testclient import TestClient
from kubernetes_asyncio.client import ApiClient
from starlette.websockets import WebSocketDisconnect

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.main import create_app
from omnikrux.watch.api import watch
from omnikrux.watch.hub import WatchHub
from tests.clusters.test_kubeconfig import kc
from tests.fakekube import kubeconfig_for, status_body
from tests.watch.fakes import FakeSource
from tests.watch.test_cache import p


def test_ws_streams_snapshot(
    app_with_fake_sources,
):  # fixture: app whose hub uses FakeSource per cluster
    client = app_with_fake_sources
    types = set()
    with client.websocket_connect("/api/watch?kind=pods") as ws:
        # Two clusters send 3 messages each (syncing, ready, snapshot); their interleaving is not fixed.
        for _ in range(6):
            types.add(ws.receive_json()["type"])
            if "snapshot" in types:
                break
    assert "snapshot" in types


@pytest.mark.parametrize("kind", ["Deployments", "pods/log", "a..b"])
def test_unknown_kind_key_4404(app_with_fake_sources, kind):
    with (
        pytest.raises(WebSocketDisconnect) as e,
        app_with_fake_sources.websocket_connect(f"/api/watch?kind={kind}") as ws,
    ):
        ws.receive_json()
    assert e.value.code == 4404 and e.value.reason == "Unknown kind"


def test_ws_from_another_origin_is_rejected(app_with_fake_sources):
    hub = app_with_fake_sources.app.state.hub
    with (
        pytest.raises(WebSocketDisconnect) as e,
        app_with_fake_sources.websocket_connect(
            "/api/watch?kind=pods", headers={"origin": "http://evil.example"}
        ) as ws,
    ):
        ws.receive_json()
    assert e.value.code == 4403
    assert hub._subscriptions == set() and hub._caches == {}


@pytest.mark.parametrize("origin", ["http://testserver", "http://TESTSERVER"])
def test_ws_from_the_same_origin_is_accepted(app_with_fake_sources, origin):
    with app_with_fake_sources.websocket_connect(
        "/api/watch?kind=pods", headers={"origin": origin}
    ) as ws:
        assert ws.receive_json()["type"] == "cluster_status"


def test_ws_without_origin_is_accepted(app_with_fake_sources):  # non-browser clients send none
    with app_with_fake_sources.websocket_connect("/api/watch?kind=pods") as ws:
        assert ws.receive_json()["type"] == "cluster_status"


def test_ws_disconnect_closes_the_subscription(app_with_fake_sources):
    client = app_with_fake_sources
    hub = client.app.state.hub
    with client.websocket_connect("/api/watch?kind=pods") as ws:
        ws.receive_json()
        assert len(hub._subscriptions) == 1
    assert hub._subscriptions == set()


class FakeWebSocket:
    """Just enough of a WebSocket for `watch()`; the client disconnects once `gone` is set."""

    def __init__(self, hub):
        self.app = SimpleNamespace(state=SimpleNamespace(hub=hub))
        self.headers = {}
        self.gone = asyncio.Event()

    async def accept(self): ...

    async def close(self, code=1000, reason=None): ...

    async def send_text(self, text): ...

    async def receive(self):
        await self.gone.wait()
        return {"type": "websocket.disconnect"}


@pytest.mark.parametrize("steps", range(12))
async def test_ws_cancel_during_cleanup_is_not_swallowed(fake_registry_two_clusters, steps):
    # The server cancels the handler while it is still cleaning up after a disconnect (as Starlette's
    # TestClient and uvicorn shutdown do). Each `steps` lands the cancellation at a different await
    # in the cleanup: it must neither be swallowed nor skip releasing the subscription.
    async def source_for(cid, spec):
        return await FakeSource(lists=[([p("a")], "1")], watches=[[]]).factory()

    hub = WatchHub(fake_registry_two_clusters, source_for)
    ws = FakeWebSocket(hub)
    t = asyncio.create_task(watch(ws, "pods"))
    while not hub._subscriptions:
        await asyncio.sleep(0)
    ws.gone.set()
    for _ in range(steps):
        await asyncio.sleep(0)
    finished_first = t.done()
    t.cancel()
    await asyncio.wait([t])
    assert finished_first or t.cancelled(), "the handler swallowed its cancellation"
    assert hub._subscriptions == set()
    await hub.close()


@pytest.fixture
def app_with_real_registry(tmp_path):
    """The real app (real registry, no clusters yet), with a hub of FakeSources over it."""

    async def source_for(cluster_id, spec):
        return await FakeSource(lists=[([p("a")], "1")], watches=[[]]).factory()

    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    real_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        async with real_lifespan(app):
            await app.state.hub.close()
            app.state.hub = WatchHub(app.state.registry, source_for)
            yield

    app.router.lifespan_context = lifespan
    with TestClient(app) as client:
        yield client


def _wait_for_subscription(hub):
    deadline = time.monotonic() + 2
    while not hub._subscriptions:
        assert time.monotonic() < deadline, "the socket never subscribed"
        time.sleep(0.01)


def _import(client, name, server):
    r = client.post("/api/clusters/kubeconfig", json={"kubeconfig": kc([(name, server, None)])})
    assert r.status_code == 200
    return r.json()[0]["id"]


def test_import_mid_session_streams_new_cluster(app_with_real_registry):
    client = app_with_real_registry
    with client.websocket_connect("/api/watch?kind=pods") as ws:
        _wait_for_subscription(client.app.state.hub)
        cluster_id = _import(client, "kind-new", "https://10.0.0.1:6443")
        assert (cluster_id, "pods") in client.app.state.hub._caches  # attached before responding
        msgs = [ws.receive_json() for _ in range(3)]
    assert [(m["type"], m["cluster_id"]) for m in msgs] == [
        ("cluster_status", cluster_id),
        ("cluster_status", cluster_id),
        ("snapshot", cluster_id),
    ]


def test_delete_mid_session_sends_cluster_removed(app_with_real_registry):
    client = app_with_real_registry
    cluster_id = _import(client, "kind-gone", "https://10.0.0.2:6443")
    hub = client.app.state.hub
    with client.websocket_connect("/api/watch?kind=pods") as ws:
        assert [ws.receive_json()["type"] for _ in range(3)][-1] == "snapshot"
        assert client.delete(f"/api/clusters/{cluster_id}").status_code == 204
        assert hub._caches == {}  # forgotten before responding
        assert ws.receive_json() == {"type": "cluster_removed", "cluster_id": cluster_id}


class RecordingWebSocket(FakeWebSocket):
    """A FakeWebSocket on a real app that keeps what the handler sends."""

    def __init__(self, app):
        super().__init__(app.state.hub)
        self.app = app
        self.sent: asyncio.Queue[dict] = asyncio.Queue()

    async def send_text(self, text):
        self.sent.put_nowait(json.loads(text))


async def test_watch_crd_rows_through_fake_api(fake_api, tmp_path):
    fake_api.objects["widgets.example.omnikrux.dev"][("demo", "w1")] = {
        "apiVersion": "example.omnikrux.dev/v1",
        "kind": "Widget",
        "metadata": {
            "name": "w1",
            "namespace": "demo",
            "uid": "u-w1",
            "creationTimestamp": "2026-11-07T09:00:00Z",
            "labels": {"app": "web"},
        },
        "spec": {"size": 3},
    }
    app = create_app(
        Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
    )
    async with app.router.lifespan_context(app):
        [info] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(kubeconfig_for(fake_api)), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        ws = RecordingWebSocket(app)
        handler = asyncio.create_task(watch(ws, "widgets.example.omnikrux.dev"))
        try:
            msgs = []
            while not msgs or msgs[-1]["type"] != "snapshot":
                msgs.append(await asyncio.wait_for(ws.sent.get(), 5))
        finally:
            ws.gone.set()
            await asyncio.wait_for(handler, 5)
    assert [m.get("state") for m in msgs[:-1]] == ["syncing", "ready"]
    [row] = msgs[-1]["rows"]
    assert row["cluster_id"] == info.id and row["kind"] == "Widget"
    assert (row["namespace"], row["name"], row["uid"]) == ("demo", "w1", "u-w1")
    assert row["labels"] == {"app": "web"} and row["created_at"] == "2026-11-07T09:00:00Z"
    paths = [p for _, p, _ in fake_api.requests]
    assert "/apis/example.omnikrux.dev/v1/widgets" in paths


async def test_watch_a_kind_the_cluster_does_not_serve_says_absent(fake_api, tmp_path):
    app = create_app(
        Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
    )
    async with app.router.lifespan_context(app):
        await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(kubeconfig_for(fake_api)), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        ws = RecordingWebSocket(app)
        handler = asyncio.create_task(watch(ws, "certificates.cert-manager.io"))
        try:
            msgs = [await asyncio.wait_for(ws.sent.get(), 5) for _ in range(2)]
        finally:
            ws.gone.set()
            await asyncio.wait_for(handler, 5)
    assert msgs[1]["state"] == "absent"
    assert msgs[1]["message"] == "This cluster doesn't serve certificates.cert-manager.io."


@pytest.mark.parametrize("cloud_cluster", ["azure", "aws", "gcp", "oci"], indirect=True)
async def test_cloud_cluster_watch_with_cloud_token(cloud_cluster, cloud_pods_watch):
    _, cluster, _ = cloud_cluster
    states = []
    async with cloud_pods_watch() as queue:
        async with asyncio.timeout(5):
            while True:
                message = await queue.get()
                if message["type"] == "cluster_status":
                    states.append(message["state"])
                    assert message["state"] != "error", message
                if message["type"] == "snapshot":
                    break
    assert states == ["syncing", "ready"]
    [row] = message["rows"]
    assert (row["cluster_id"], row["namespace"], row["name"]) == (cluster.id, "demo", "web-1")


async def test_cloud_watch_relists_after_expired_http_response(
    cloud_pods_watch, fake_api, monkeypatch
):
    route = fake_api._route
    expired = False

    async def expire_once(request):
        nonlocal expired
        if not expired and request.path == "/api/v1/pods" and request.query.get("watch") == "true":
            expired = True
            return web.json_response(
                status_body(410, "Expired", "resource version expired"), status=410
            )
        return await route(request)

    monkeypatch.setattr(fake_api, "_route", expire_once)
    snapshots = 0
    async with cloud_pods_watch() as queue:
        async with asyncio.timeout(5):
            while True:
                message = await queue.get()
                assert message.get("state") != "error", message
                snapshots += message["type"] == "snapshot"
                if message["type"] == "upsert":
                    break
    assert expired and snapshots == 2


@pytest.mark.parametrize(
    "failure", ["connector", "discovery-body", "list-body", "watch-event", "provider-body"]
)
async def test_cloud_watch_diagnostics_hide_private_endpoint_and_auth_data(
    failure,
    cloud_cluster,
    cloud_http_client,
    cloud_pods_watch,
    fake_cloud,
    fake_api,
    monkeypatch,
    caplog,
):
    _, cluster, _ = cloud_cluster
    host = "private-oke-api.example.test"
    sentinel = "synthetic-sensitive-cluster-credential"
    upstream = f"Failed to authenticate to https://{host}:6443 with {sentinel}"
    injected = []

    if failure == "connector":
        call_api = ApiClient.call_api

        async def fail_discovery(api, path, method, *args, **kwargs):
            if path == "/api/v1" and api.configuration.host == fake_api.url:
                injected.append(path)
                connection = SimpleNamespace(host=host, port=6443, ssl=True)
                raise aiohttp.ClientConnectorError(connection, OSError(upstream))
            return await call_api(api, path, method, *args, **kwargs)

        monkeypatch.setattr(ApiClient, "call_api", fail_discovery)
    elif failure == "provider-body":
        fake_cloud.fail[r"^/google/oauth/token$"] = (403, upstream)
    else:
        route = fake_api._route

        async def refuse(request):
            if failure == "discovery-body" and request.path == "/api/v1":
                injected.append(request.path)
                return web.json_response(status_body(401, "Unauthorized", upstream), status=401)
            if request.path == "/api/v1/pods":
                is_watch = request.query.get("watch") == "true"
                if failure == "list-body" and not is_watch:
                    injected.append(request.path)
                    return web.json_response(status_body(403, "Forbidden", upstream), status=403)
                if failure == "watch-event" and is_watch:
                    injected.append(request.path)
                    event = {"type": "ERROR", "object": status_body(403, "Forbidden", upstream)}
                    return web.Response(text=json.dumps(event) + "\n")
            return await route(request)

        monkeypatch.setattr(fake_api, "_route", refuse)

    async with cloud_pods_watch() as queue:
        async with asyncio.timeout(5):
            while (status := await queue.get()).get("state") != "error":
                pass
        response = await cloud_http_client.get("/api/clusters")
    assert response.status_code == 200, response.text
    public = next(item for item in response.json() if item["id"] == cluster.id)
    assert public["state"] == "error"
    assert public["message"] == status["message"]
    assert public["message"]
    assert public["server"] is None and public["original_server"] is None
    for sensitive in (host, sentinel, fake_api.url):
        assert sensitive not in json.dumps(status)
        assert sensitive not in response.text
    assert host not in caplog.text and sentinel not in caplog.text
    if failure == "provider-body":
        assert any(r.path == "/google/oauth/token" for r in fake_cloud.requests)
    else:
        assert injected, "the watch failed before reaching the injected error"


async def test_cloud_kinds_keeps_partial_discovery_and_omits_raw_diagnostics(
    cloud_cluster, cloud_http_client, fake_api, monkeypatch, caplog
):
    _, cluster, _ = cloud_cluster
    sentinel = "synthetic-private-catalog-credential"
    route = fake_api._route

    async def refuse(request):
        if request.path in {
            "/apis/apps/v1",
            "/apis/apiextensions.k8s.io/v1/customresourcedefinitions",
        }:
            return web.json_response(status_body(403, "Forbidden", sentinel), status=403)
        return await route(request)

    monkeypatch.setattr(fake_api, "_route", refuse)
    with caplog.at_level(logging.INFO):
        response = await cloud_http_client.get("/api/kinds")
    assert response.status_code == 200, response.text
    catalog = response.json()
    entry = catalog["clusters"][cluster.id]
    assert entry["state"] == "ok" and entry["failed_groups"]["apps"]
    assert "pods" in {kind["key"] for kind in catalog["kinds"]}
    assert sentinel not in response.text and sentinel not in caplog.text
