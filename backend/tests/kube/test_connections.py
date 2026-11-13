import asyncio
import json
import logging
from dataclasses import asdict

import aiohttp
import httpx
import pytest
import yaml
from aiohttp import web
from kubernetes_asyncio.client.exceptions import ApiException
from kubernetes_asyncio.stream import WsApiClient

from omnikrux.cloud.azure import AKS_SERVER_APP_ID, AzureCliLogin
from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.exec.session import KubeExecChannel
from omnikrux.kube.client import ClusterUnavailable
from omnikrux.kube.connections import ClusterConnections, kube_error_message
from omnikrux.main import create_app
from tests.fakecloud import write_aws_cli_login, write_azure_cli_login
from tests.fakekube import kubeconfig_for, status_body
from tests.watch.test_ws import RecordingWebSocket, watch


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
        (
            _api_exc(422, {"message": 'Pod "p" is invalid: spec.containers: Required value'}),
            'Couldn\'t list pods: Pod "p" is invalid: spec.containers: Required value',
        ),
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
        [cluster] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(kubeconfig_for(fake_api)), rewrite_loopback=False, source="upload"
        )
        source = await app.state.hub._source_for(cluster.id, "pods")
        try:
            items, rv = await source.list()
        finally:
            await source.aclose()
    assert rv == "42" and items[0]["metadata"]["name"] == "web-1"


@pytest.fixture
def fake_bridge_lookup(monkeypatch):
    def local_bridge(dirs, endpoints, http):
        from omnikrux.cloud.exec_bridge import ExecBridge

        return ExecBridge(dirs, endpoints, http, which=binaries.get)

    binaries = {}
    monkeypatch.setattr("omnikrux.main.ExecBridge", local_bridge, raising=False)
    monkeypatch.setattr("omnikrux.kube.tokens.shutil.which", binaries.get)

    async def no_subprocess(*args, **kwargs):
        pytest.fail("Unexpected exec plugin subprocess")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", no_subprocess)
    return binaries


async def test_imported_eks_kubeconfig_watches_through_bridge(
    fake_api, fake_cloud, tmp_path, fake_bridge_lookup
):
    aws_dir = tmp_path / "aws"
    region = "eu-west-1"
    access_key = "AKIDBRIDGEUPLOAD"
    secret_key = "synthetic-bridge-upload-secret"
    write_aws_cli_login(
        aws_dir,
        profiles={"default": {"region": region}},
        credentials={
            "default": {"aws_access_key_id": access_key, "aws_secret_access_key": secret_key}
        },
    )
    fake_cloud.aws.keys[access_key] = secret_key
    fake_cloud.aws.add_eks(region, "prod", server=fake_api.url)
    accepts_token = fake_cloud.kube_token_ok("aws")
    watch_started = asyncio.Event()

    def check_token(header):
        if not accepts_token(header):
            return False
        _, path, query = fake_api.requests[-1]
        if path == "/api/v1/pods" and query.get("watch", "").lower() == "true":
            watch_started.set()
        return True

    fake_api.token_check = check_token
    config = kubeconfig_for(fake_api)
    exec_config = {
        "apiVersion": "client.authentication.k8s.io/v1beta1",
        "command": "aws",
        "args": ["eks", "get-token", "--cluster-name", "prod", "--region", region],
    }
    config["users"][0]["user"] = {"exec": exec_config}
    app = create_app(
        Settings(
            data_dir=tmp_path,
            kubeconfig="",
            in_container=False,
            aws_dir=aws_dir,
            cloud_endpoints=json.dumps(asdict(fake_cloud.endpoints())),
        )
    )

    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            response = await client.post(
                "/api/clusters/kubeconfig", json={"kubeconfig": yaml.safe_dump(config)}
            )
        assert response.status_code == 200
        (cluster,) = response.json()
        ws = RecordingWebSocket(app)
        handler = asyncio.create_task(watch(ws, "pods"))
        try:
            async with asyncio.timeout(5):
                while True:
                    frame = await ws.sent.get()
                    if frame["type"] == "cluster_status":
                        assert frame["cluster_id"] == cluster["id"]
                        assert frame["state"] != "error", frame
                        if frame["state"] == "ready":
                            break
                await watch_started.wait()
            channel = await KubeExecChannel.open(
                app.state.connections, cluster["id"], "demo", "web-1", "app", ["sh"]
            )
            await channel.close()
        finally:
            ws.gone.set()
            await asyncio.wait_for(handler, 5)
        stored = await app.state.registry.get_kubeconfig(cluster["id"])
        assert stored["users"][0]["user"] == {"exec": exec_config}

    assert fake_cloud.requests == []


@pytest.fixture
def imported_azure(fake_api, fake_cloud, tmp_path, fake_bridge_lookup):
    tenant = "a1656f69-93d5-4e1b-9583-d3722c77dafe"
    subscription = "050d52ed-0bc8-46c3-95e1-a7aef67ff331"
    refresh = "synthetic-import-refresh"
    user = "import-test@example.test"
    settings = Settings(
        data_dir=tmp_path,
        kubeconfig="",
        in_container=False,
        cloud_endpoints=json.dumps(asdict(fake_cloud.endpoints())),
    )
    write_azure_cli_login(
        settings.cloud_dirs.azure,
        subscriptions=[{"id": subscription, "name": "Test", "tenantId": tenant, "isDefault": True}],
        refresh_token=refresh,
        user=user,
    )
    fake_cloud.azure.refresh_tokens[refresh] = tenant, user
    config = kubeconfig_for(fake_api)
    config["users"][0]["user"] = {
        "exec": {
            "apiVersion": "client.authentication.k8s.io/v1beta1",
            "command": "kubelogin",
            "args": ["get-token", "--login", "azurecli", "--server-id", AKS_SERVER_APP_ID],
        }
    }
    return create_app(settings), config


async def test_imported_azure_shutdown_drains_forgotten_refresh(imported_azure, monkeypatch):
    app, config = imported_azure
    started, release, exiting, completed = (asyncio.Event() for _ in range(4))
    observed = []
    original_token = AzureCliLogin.token

    async def delayed_token(login, *args):
        started.set()
        await release.wait()
        try:
            return await original_token(login, *args)
        finally:
            observed.append("refresh finished")
            completed.set()

    monkeypatch.setattr(AzureCliLogin, "token", delayed_token)

    async def run_app():
        async with app.router.lifespan_context(app):
            http = app.state.cloud.http
            original_close = http.close

            async def record_close():
                observed.append("HTTP closed")
                await original_close()

            monkeypatch.setattr(http, "close", record_close)
            [cluster] = await app.state.registry.upsert_from_kubeconfig(
                yaml.safe_dump(config), rewrite_loopback=False, source=SOURCE_UPLOAD
            )
            connections = app.state.connections
            waiter = asyncio.create_task(connections.open_api(cluster.id))
            await asyncio.wait_for(started.wait(), 5)
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
            connections.forget(cluster.id)
            exiting.set()

    task = asyncio.create_task(run_app())
    try:
        await asyncio.wait_for(exiting.wait(), 5)
        await asyncio.sleep(0.1)
    finally:
        release.set()
        await asyncio.wait_for(task, 5)
        await asyncio.wait_for(completed.wait(), 5)
        await type(app.state.cloud.http).close(app.state.cloud.http)

    assert observed == ["refresh finished", "HTTP closed"]


@pytest.mark.parametrize("scenario", ["describe", "watch", "kinds"])
async def test_imported_azure_diagnostics_hide_echoed_bearer(
    imported_azure, fake_cloud, fake_api, monkeypatch, caplog, scenario
):
    app, config = imported_azure
    fake_api.token_check = fake_cloud.kube_token_ok("azure")
    route = fake_api._route
    exposed = []

    async def echo(request):
        if scenario == "describe" and request.path == "/api/v1/namespaces/demo/pods/web-1":
            token = request.headers["Authorization"].removeprefix("Bearer ")
            exposed.append(token)
            return web.json_response(status_body(403, "Forbidden", token), status=403)
        if scenario == "watch" and request.query.get("watch") == "true":
            token = request.headers["Authorization"].removeprefix("Bearer ")
            exposed.append(token)
            event = {"type": "ERROR", "object": status_body(403, "Forbidden", token)}
            return web.Response(text=json.dumps(event) + "\n", content_type="application/json")
        if scenario == "kinds" and request.path == "/apis":
            token = request.headers["Authorization"].removeprefix("Bearer ")
            exposed.append(token)
            response = await route(request)
            body = json.loads(response.body)
            group = f"{token}.invalid@example.test"
            body["groups"].append(
                {
                    "name": group,
                    "preferredVersion": {"version": "v1", "groupVersion": f"{group}/v1"},
                }
            )
            return web.json_response(body)
        return await route(request)

    monkeypatch.setattr(fake_api, "_route", echo)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client,
    ):
        response = await client.post(
            "/api/clusters/kubeconfig", json={"kubeconfig": yaml.safe_dump(config)}
        )
        assert response.status_code == 200
        [cluster] = response.json()
        with caplog.at_level(logging.DEBUG):
            if scenario == "describe":
                response = await client.get(
                    f"/api/clusters/{cluster['id']}/pods/demo/web-1/describe"
                )
                assert response.status_code == 502
                published = response.text
            elif scenario == "kinds":
                response = await client.get("/api/kinds")
                assert response.status_code == 200
                assert response.json()["clusters"][cluster["id"]]["state"] == "ok"
                published = response.text + json.dumps(fake_api.requests)
            else:
                ws = RecordingWebSocket(app)
                handler = asyncio.create_task(watch(ws, "pods"))
                try:
                    async with asyncio.timeout(5):
                        while True:
                            frame = await ws.sent.get()
                            if frame.get("state") == "error":
                                break
                finally:
                    ws.gone.set()
                    await asyncio.wait_for(handler, 5)
                published = json.dumps(frame)

    assert exposed, "the request did not reach the injected failure"
    for token in exposed:
        assert token not in published
        assert token not in caplog.text


@pytest.mark.parametrize(
    ("plugin", "protected"), [(None, False), ("custom-plugin", False), ("aws", True)]
)
async def test_imported_describe_preserves_unrelated_diagnostics(
    plugin, protected, fake_api, fake_bridge_lookup, tmp_path, monkeypatch
):
    config = kubeconfig_for(fake_api)
    if plugin:
        fake_bridge_lookup[plugin] = plugin
        version = "client.authentication.k8s.io/v1beta1"
        config["users"][0]["user"] = {"exec": {"command": plugin, "apiVersion": version}}

        class Plugin:
            returncode = 0

            async def communicate(self):
                return json.dumps(
                    {
                        "kind": "ExecCredential",
                        "apiVersion": version,
                        "status": {"token": "synthetic-plugin"},
                    }
                ).encode(), b""

        async def launch(executable, *args, **kwargs):
            assert executable == plugin
            return Plugin()

        monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)

    reason = "Synthetic pod rejection detail."
    fake_api.token_check = lambda header: (
        header
        == (
            "Bearer synthetic-plugin" if plugin else f"Bearer {config['users'][0]['user']['token']}"
        )
    )

    async def refuse(_request):
        return web.json_response(status_body(403, "Forbidden", reason), status=403)

    monkeypatch.setattr(fake_api, "_route", refuse)
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as client,
    ):
        [cluster] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(config), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        response = await client.get(f"/api/clusters/{cluster.id}/pods/demo/web-1/describe")

    assert response.status_code == 502
    assert (reason in response.text) is not protected
