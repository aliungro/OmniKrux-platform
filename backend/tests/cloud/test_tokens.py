import asyncio
import json
import logging

import pytest
from aiohttp import web
from kubernetes_asyncio.client import CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.cloud.endpoints import CloudEndpoints
from omnikrux.cloud.store import CloudAccountStore
from omnikrux.cloud.types import DiscoveredCluster
from omnikrux.exec.api import exec_shell
from omnikrux.kube.client import ClusterUnavailable
from omnikrux.kube.http import call_json
from tests.exec.test_session import BrowserSocket
from tests.fakekube import status_body

ACCOUNT_REMOVED = (
    "The cloud account this cluster belonged to was removed. "
    "Remove the cluster too, or connect the account again."
)
AZURE_EXPIRED = "Your Azure CLI login has expired. Run `az login` on this machine, then try again."


async def _receive_through(queue, predicate, *, timeout=5):
    messages = []
    async with asyncio.timeout(timeout):
        while True:
            message = await queue.get()
            messages.append(message)
            if predicate(message):
                return messages


async def test_cloud_cluster_describe_logs_exec_through_connections(
    cloud_cluster, cloud_http_client, fake_api
):
    app, cluster, _ = cloud_cluster
    fake_api.logs[("demo", "web-1", "app", False)] = ["hello from the cloud pod"]
    pod = f"/api/clusters/{cluster.id}/pods/demo/web-1"
    describe = await cloud_http_client.get(f"{pod}/describe")
    assert describe.status_code == 200, describe.text
    assert describe.json()["pod"]["name"] == "web-1"
    log = await cloud_http_client.get(f"{pod}/logs/download", params={"container": "app"})
    assert log.status_code == 200, log.text
    assert log.text == "hello from the cloud pod\n"

    ws = BrowserSocket(app)
    ws.type({"type": "stdin", "data": "hello shell"})
    ws.type({"type": "stdin", "data": "exit 0"})
    await asyncio.wait_for(exec_shell(ws, cluster.id, "demo", "web-1"), 5)
    assert ws.output("stdout") == "hello shell"
    assert ws.closed == (1000, None)


@pytest.mark.parametrize(
    ("operation", "kube_status", "http_status"),
    [
        ("describe", 403, 502),
        ("describe", 422, 502),
        ("logs", 400, 400),
        ("logs", 403, 502),
        ("logs", 404, 404),
        ("exec-read", 403, None),
        ("exec-upgrade", 403, None),
        ("exec-status", 500, None),
        ("generated", 403, None),
    ],
)
async def test_cloud_kubernetes_failures_hide_echoed_bearer(
    operation,
    kube_status,
    http_status,
    cloud_cluster,
    cloud_http_client,
    fake_api,
    monkeypatch,
    caplog,
):
    app, cluster, _ = cloud_cluster
    pod = f"/api/clusters/{cluster.id}/pods/demo/web-1"
    upstream_pod = "/api/v1/namespaces/demo/pods/web-1"
    target = {
        "logs": f"{upstream_pod}/log",
        "exec-upgrade": f"{upstream_pod}/exec",
        "exec-status": f"{upstream_pod}/exec",
    }.get(operation, upstream_pod)
    private_host = "private-cloud-api.example.test"
    sent_bearer = []
    route = fake_api._route

    async def echo_bearer(request):
        if request.path != target:
            return await route(request)
        bearer = request.headers["Authorization"]
        assert bearer.startswith("Bearer ")
        sent_bearer.append(bearer.removeprefix("Bearer "))
        failure = status_body(kube_status, "Refused", f"https://{private_host} rejected {bearer}")
        if operation == "exec-status":
            fake_api.exec_status = failure
            return await route(request)
        return web.json_response(failure, status=kube_status)

    monkeypatch.setattr(fake_api, "_route", echo_bearer)
    with caplog.at_level(logging.DEBUG):
        if operation == "generated":
            async with app.state.connections.api(cluster.id) as api:
                with pytest.raises(ApiException) as exc_info:
                    await CoreV1Api(api).read_namespaced_pod("web-1", "demo")
            assert exc_info.value.status == kube_status
            published = str(exc_info.value)
        elif operation.startswith("exec-"):
            ws = BrowserSocket(app)
            await asyncio.wait_for(exec_shell(ws, cluster.id, "demo", "web-1"), 5)
            frame = ws.sent[-1]
            if operation == "exec-status":
                assert frame["type"] == "exit" and frame["cannot_run"]
                assert ws.closed == (1000, None)
            else:
                assert frame["type"] == "error" and ws.closed == (1011, None)
            assert frame["message"]
            audit = await cloud_http_client.get("/api/audit", params={"cluster": cluster.id})
            assert audit.status_code == 200
            published = json.dumps(ws.sent) + audit.text
        else:
            path = "describe" if operation == "describe" else "logs/download?container=app"
            response = await cloud_http_client.get(f"{pod}/{path}")
            assert response.status_code == http_status
            assert response.json()["detail"]
            published = response.text

    assert sent_bearer, "the request never reached the injected cloud Kubernetes failure"
    for sensitive in [*sent_bearer, private_host]:
        assert sensitive not in published
        assert sensitive not in caplog.text


@pytest.mark.parametrize(
    ("details", "expected_code"),
    [
        ("echo-bearer", None),
        ({"causes": [{"reason": "ExitCode", "message": "256"}]}, None),
        ("malformed details", None),
        ({"causes": {"reason": "ExitCode", "message": "7"}}, None),
        ({"causes": ["malformed cause", {"reason": "ExitCode", "message": "255"}]}, 255),
    ],
    ids=["numeric-bearer", "out-of-range", "non-object-details", "non-list-causes", "valid-exit"],
)
async def test_cloud_exec_status_only_reports_valid_exit_codes(
    details,
    expected_code,
    cloud_cluster,
    cloud_http_client,
    fake_cloud,
    fake_api,
    monkeypatch,
    caplog,
):
    app, cluster, _ = cloud_cluster
    bearer = "289364205570899346551"
    monkeypatch.setattr(
        fake_cloud.gcp,
        "token_response",
        lambda form, lifetime: web.json_response({"access_token": bearer, "expires_in": lifetime}),
    )
    fake_api.token_check = lambda header: header == f"Bearer {bearer}"
    exec_pod = fake_api._exec

    async def send_status(request, key):
        authorized = request.headers["Authorization"].removeprefix("Bearer ")
        assert authorized == bearer
        causes = {"causes": [{"reason": "ExitCode", "message": authorized}]}
        fake_api.exec_status = status_body(500, "NonZeroExitCode", f"Refused {authorized}") | {
            "details": causes if details == "echo-bearer" else details,
        }
        return await exec_pod(request, key)

    monkeypatch.setattr(fake_api, "_exec", send_status)
    ws = BrowserSocket(app)
    with caplog.at_level(logging.DEBUG):
        await asyncio.wait_for(exec_shell(ws, cluster.id, "demo", "web-1"), 5)
        audit = await cloud_http_client.get("/api/audit", params={"cluster": cluster.id})

    assert audit.status_code == 200
    assert bearer not in json.dumps(ws.sent) + audit.text + caplog.text
    assert ws.closed == (1000, None)
    [exit_frame] = ws.sent
    assert (exit_frame["type"], exit_frame["code"]) == ("exit", expected_code)
    [record] = audit.json()["records"]
    if expected_code is None:
        assert record["outcome"] == "failed"
        assert record["message"] == exit_frame["message"]
    else:
        assert (record["outcome"], record["message"]) == ("ended", f"exit {expected_code}")


async def test_cloud_token_refreshed_before_expiry_no_error(
    cloud_cluster, cloud_pods_watch, fake_cloud, fake_api
):
    app, cluster, _ = cloud_cluster
    fake_cloud.token_lifetime["gcp"] = 8
    fake_api.mode = "instant_close"
    accept = fake_cloud.kube_token_ok("gcp")
    accepted_watch_headers = set()

    def check(authorization):
        valid = accept(authorization)
        if valid and fake_api.requests[-1][2].get("watch") == "true":
            accepted_watch_headers.add(authorization)
        return valid

    fake_api.token_check = check
    states = []
    async with cloud_pods_watch() as queue:
        async with asyncio.timeout(20):
            while True:
                message = await queue.get()
                if message["type"] == "cluster_status":
                    states.append(message["state"])
                    assert message["state"] != "error", message
                if message["type"] == "upsert" and len(accepted_watch_headers) >= 3:
                    break
        assert app.state.hub.status(cluster.id) == ("ready", None)
    assert states == ["syncing", "ready"]
    assert len(fake_cloud.gcp._expires) >= 2


@pytest.mark.parametrize("cloud_cluster", ["azure"], indirect=True)
async def test_broker_single_flight_across_clients(cloud_cluster, fake_cloud):
    app, cluster, _ = cloud_cluster

    async def version():
        async with app.state.connections.api(cluster.id) as api:
            return await call_json(api, "GET", "/version", timeout=5)

    versions = await asyncio.gather(*(version() for _ in range(5)))
    assert all(info["gitVersion"] == "v1.31.0" for info in versions)
    token_requests = [
        request
        for request in fake_cloud.requests
        if request.method == "POST" and request.path.endswith("/oauth2/v2.0/token")
    ]
    assert len(token_requests) == 1


@pytest.mark.parametrize("cloud_cluster", ["azure"], indirect=True)
async def test_cloud_login_expired_band_message(
    cloud_cluster, cloud_pods_watch, fake_cloud, fake_api
):
    app, cluster, _ = cloud_cluster
    fake_cloud.token_lifetime["azure"] = 4
    fake_api.mode = "instant_close"
    async with cloud_pods_watch() as queue:
        ready = await _receive_through(
            queue, lambda m: m["type"] == "upsert" or m.get("state") == "error"
        )
        assert ready[-1]["type"] == "upsert", ready[-1]
        fake_cloud.azure.refresh_tokens.clear()
        failure = await _receive_through(queue, lambda m: m.get("state") == "error", timeout=8)
        assert failure[-1]["message"] == AZURE_EXPIRED
        assert app.state.hub.status(cluster.id) == ("error", AZURE_EXPIRED)


async def test_account_removed_cluster_unavailable_plain(cloud_cluster, monkeypatch):
    app, cluster, account = cloud_cluster

    async def missing_account(store, account_id):
        # Store.delete also removes cluster rows. Simulate an in-flight read holding a cloud ref.
        assert account_id == account.id
        raise KeyError(account_id)

    monkeypatch.setattr(CloudAccountStore, "config", missing_account)
    with pytest.raises(ClusterUnavailable) as exc_info:
        async with app.state.connections.api(cluster.id):
            pytest.fail("the cluster connection opened without its account")
    assert exc_info.value.message == ACCOUNT_REMOVED


async def test_forgetting_account_retires_a_token_fetch_in_flight(cloud_cluster, monkeypatch):
    app, cluster, account = cloud_cluster
    services = app.state.cloud
    broker = services.broker
    source = await broker.tokens_for(cluster.id)
    assert source is not None
    original_config = services.store.config
    config_read, release = asyncio.Event(), asyncio.Event()
    requested = []
    adapter = services.adapters[account.provider]
    token_fetch = adapter.token_fetch

    async def delayed_config(account_id):
        config = await original_config(account_id)
        config_read.set()
        await release.wait()
        return config

    def tracked_token_fetch(*args):
        requested.append(True)
        return token_fetch(*args)

    monkeypatch.setattr(services.store, "config", delayed_config)
    monkeypatch.setattr(adapter, "token_fetch", tracked_token_fetch)
    pending = asyncio.create_task(source())
    try:
        await asyncio.wait_for(config_read.wait(), 5)
        assert await services.store.delete(account.id) == [cluster.id]
        broker.forget_account(account.id)
    finally:
        release.set()
        with pytest.raises(ClusterUnavailable) as exc_info:
            await asyncio.wait_for(pending, 5)
    assert exc_info.value.message == ACCOUNT_REMOVED
    assert requested == []
    with pytest.raises(ClusterUnavailable, match="account this cluster belonged to was removed"):
        await source()


@pytest.mark.parametrize(
    "server",
    [
        "http://not-a-fake.example.test:6443",
        "https://synthetic-credential@cluster.example.test",
        "https://cluster.example.test?token=synthetic-credential",
        "https://cluster.example.test#synthetic-credential",
    ],
)
async def test_cloud_cluster_registry_rejects_unsafe_endpoint(cloud_cluster, server):
    app, cluster, _ = cloud_cluster
    registry = app.state.registry
    ref = await registry.cloud_ref(cluster.id)
    found = DiscoveredCluster(
        ref.resource_id, ref.name, ref.region, None, (), None, {}, False, None, ref.details
    )
    with pytest.raises(ValueError) as exc_info:
        await registry.upsert_cloud_cluster(
            ref, found, server=server, ca_data=None, environment=cluster.environment
        )
    assert "synthetic-credential" not in str(exc_info.value)
    assert (await registry.get(cluster.id)).server == cluster.server


def test_http_cluster_endpoint_requires_its_own_provider_fake():
    server = "http://127.0.0.1:6443"
    endpoints = CloudEndpoints.from_json('{"gcp_container":"http://127.0.0.1:9876"}')
    endpoints.validate_cluster_server("gcp", server)
    with pytest.raises(ValueError):
        endpoints.validate_cluster_server("azure", server)


@pytest.mark.parametrize("cloud_cluster", ["azure"], indirect=True)
async def test_tokens_never_logged(cloud_pods_watch, fake_cloud, caplog):
    with caplog.at_level(logging.DEBUG):
        async with cloud_pods_watch() as queue:
            messages = await _receive_through(
                queue, lambda m: m["type"] == "upsert" or m.get("state") == "error"
            )
    assert messages[-1]["type"] == "upsert", messages[-1]
    assert fake_cloud.azure.issued_tokens
    payload = json.dumps(messages)
    for token in fake_cloud.azure.issued_tokens:
        assert token not in caplog.text
        assert token not in payload


async def test_replacement_token_waits_for_retired_refresh(cloud_cluster, monkeypatch):
    app, cluster, account = cloud_cluster
    services = app.state.cloud
    adapter = services.adapters[account.provider]
    original = adapter.token_fetch
    started, release, replacement_started = asyncio.Event(), asyncio.Event(), asyncio.Event()
    calls = 0

    def controlled_fetch(config, ref):
        async def fetch():
            nonlocal calls
            calls += 1
            if calls == 1:
                started.set()
                await release.wait()
            else:
                replacement_started.set()
            return await original(config, ref)()

        return fetch

    monkeypatch.setattr(adapter, "token_fetch", controlled_fetch)
    old = await services.broker.tokens_for(cluster.id)
    assert old is not None
    first = asyncio.create_task(old())

    async def replacement():
        source = await services.broker.tokens_for(cluster.id)
        assert source is not None and source is not old
        return await source()

    await asyncio.wait_for(started.wait(), 5)
    services.broker.forget(cluster.id)
    second = asyncio.create_task(replacement())
    try:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(replacement_started.wait(), 0.25)
    finally:
        release.set()
        previous, token = await asyncio.wait_for(
            asyncio.gather(first, second, return_exceptions=True), 5
        )
    assert isinstance(previous, ClusterUnavailable)
    assert token.value and calls == 2


async def test_cloud_lifespan_drains_refresh_after_waiter_cancellation(
    cloud_cluster_context, monkeypatch
):
    started, release, exiting = asyncio.Event(), asyncio.Event(), asyncio.Event()
    completed = asyncio.Event()
    observed = []
    original_close = None

    async def run_app():
        nonlocal original_close
        async with cloud_cluster_context("azure") as (app, cluster, account):
            services = app.state.cloud
            adapter = services.adapters[account.provider]
            original_fetch = adapter.token_fetch
            original_close = services.http.close

            def delayed_fetch(config, ref):
                async def fetch():
                    started.set()
                    await release.wait()
                    try:
                        return await original_fetch(config, ref)()
                    finally:
                        observed.append("refresh finished")
                        completed.set()

                return fetch

            async def record_close():
                observed.append("HTTP closed")
                await original_close()

            monkeypatch.setattr(adapter, "token_fetch", delayed_fetch)
            monkeypatch.setattr(services.http, "close", record_close)
            source = await services.broker.tokens_for(cluster.id)
            assert source is not None
            waiter = asyncio.create_task(source())
            await asyncio.wait_for(started.wait(), 5)
            waiter.cancel()
            with pytest.raises(asyncio.CancelledError):
                await waiter
            exiting.set()

    task = asyncio.create_task(run_app())
    try:
        await asyncio.wait_for(exiting.wait(), 5)
        await asyncio.sleep(0.1)  # the app can reach shutdown while the provider is still blocked
    finally:
        release.set()
        await asyncio.wait_for(task, 5)
        await asyncio.wait_for(completed.wait(), 5)
        assert original_close is not None
        await original_close()  # also closes a session reopened by the old implementation on RED

    assert observed == ["refresh finished", "HTTP closed"]
