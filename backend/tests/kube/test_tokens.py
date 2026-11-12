import asyncio
import json
import sys
from contextlib import aclosing
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import yaml
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.x509.oid import NameOID
from kubernetes_asyncio.client import CoreV1Api

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.exec.session import KubeExecChannel
from omnikrux.kube import tokens
from omnikrux.kube.client import ClusterUnavailable, make_api_client
from omnikrux.kube.connections import ClusterConnections
from omnikrux.main import create_app
from tests.fakekube import CUT, kubeconfig_for
from tests.kube.test_connections import FakeRegistry
from tests.logs.test_stream import make, next_item, pod
from tests.portforward.conftest import echo, free_ports, make_env
from tests.portforward.conftest import pod as forward_pod
from tests.watch.test_ws import RecordingWebSocket, watch

EPOCH = datetime(2026, 1, 1, tzinfo=UTC)


@pytest.fixture
def plugin(fake_api, tmp_path):
    state = tmp_path / "counter"
    config = kubeconfig_for(fake_api)
    config["users"][0]["user"] = {
        "exec": {
            "command": sys.executable,
            "apiVersion": "client.authentication.k8s.io/v1beta1",
            "args": [str(Path(__file__).with_name("fake_exec_plugin.py"))],
            "env": [
                {"name": "FAKE_PLUGIN_STATE", "value": str(state)},
                {"name": "FAKE_PLUGIN_TTL", "value": "2"},
            ],
        }
    }
    return config, state


@pytest.fixture
def connections(plugin):
    config, _ = plugin
    return ClusterConnections(FakeRegistry({"c1": config}))


def accept_latest(fake_api, plugin):
    _, state = plugin
    seen = []

    def check(header):
        seen.append(header)
        return state.exists() and header == f"Bearer exec-{state.read_text()}"

    fake_api.token_check = check
    return seen


async def request_version(api):
    response = await api.call_api(
        "/version", "GET", auth_settings=["BearerToken"], _preload_content=False
    )
    assert response.status == 200
    response.release()


def test_refresh_due_rule():
    from omnikrux.kube.tokens import BearerToken, refresh_due

    for lifetime, margin in ((3600, 120), (240, 60), (None, 300)):
        expiry = EPOCH + timedelta(seconds=lifetime) if lifetime else None
        token = BearerToken("sample-token", expiry)
        due_at = expiry - timedelta(seconds=margin) if expiry else EPOCH + timedelta(seconds=margin)
        assert not refresh_due(token, EPOCH, due_at - timedelta(seconds=1))
        assert refresh_due(token, EPOCH, due_at)
        assert "sample-token" not in repr(token)


@pytest.mark.parametrize("fails", [False, True])
async def test_cached_token_single_flight(fails):
    from omnikrux.kube.tokens import BearerToken, CachedToken

    calls = 0
    entered, release = asyncio.Event(), asyncio.Event()
    token = BearerToken("sample-token", None)

    async def fetch():
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        if fails and calls == 1:
            raise ValueError("login failed")
        return token

    cache = CachedToken(fetch)
    tasks = [asyncio.create_task(cache()) for _ in range(10)]
    await asyncio.wait_for(entered.wait(), 5)
    release.set()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    assert calls == 1
    if fails:
        assert all(isinstance(result, ValueError) for result in results)
        assert await cache() is token
        assert calls == 2
    else:
        assert results == [token] * 10
        cache.invalidate()
        assert await cache() is token
        assert calls == 2


async def test_token_source_sets_bearer_and_refreshes_per_request(fake_api, plugin):
    from omnikrux.kube.tokens import BearerToken

    config, state = plugin
    config["users"][0]["user"].update(token="ignored", **{"auth-provider": {"name": "ignored"}})
    seen = []

    def check(header):
        seen.append(header)
        return True

    fake_api.token_check = check
    next_value = "t1"

    async def token():
        return BearerToken(next_value, None)

    async with await make_api_client(config, token=token) as api:
        await request_version(api)
        next_value = "t2"
        await request_version(api)
    assert seen == ["Bearer t1", "Bearer t2"]
    assert not state.exists()
    assert "exec" in config["users"][0]["user"]


async def test_exec_plugin_runs_once_per_token_lifetime(connections, plugin, fake_api):
    seen = accept_latest(fake_api, plugin)
    for _ in range(3):
        async with connections.api("c1") as api:
            await request_version(api)
    assert seen == ["Bearer exec-1"] * 3


async def test_exec_plugin_rerun_after_expiry_on_long_lived_client(connections, fake_api, plugin):
    seen = accept_latest(fake_api, plugin)
    async with connections.api("c1") as api:
        await request_version(api)
        await asyncio.sleep(2)
        await request_version(api)
    assert seen == ["Bearer exec-1", "Bearer exec-2"]


async def test_plugin_without_expiry_cached_five_minutes(plugin):
    from omnikrux.kube.tokens import CachedToken, ExecPluginToken, RunPlugin

    config, state = plugin
    current = EPOCH
    fetch = ExecPluginToken(RunPlugin(config["users"][0]["user"]["exec"], {"FAKE_PLUGIN_TTL": "0"}))
    cache = CachedToken(fetch, clock=lambda: current)
    assert (await cache()).expires_at is None
    current += timedelta(seconds=299)
    await cache()
    assert state.read_text() == "1"
    current += timedelta(seconds=1)
    await cache()
    assert state.read_text() == "2"


async def test_plugin_failure_plain_message(connections, monkeypatch, caplog):
    monkeypatch.setenv("FAKE_PLUGIN_FAIL", "1")
    with pytest.raises(ClusterUnavailable) as exc:
        async with connections.api("c1"):
            pass
    assert str(exc.value) == (
        f"This cluster signs in with '{sys.executable}', which failed: "
        "the login command exited with status 1"
    )
    assert "boom: no login" not in caplog.text


async def test_plugin_output_errors_hide_stdout(connections, monkeypatch, caplog):
    monkeypatch.setenv(
        "FAKE_PLUGIN_OUTPUT",
        json.dumps(
            {
                "apiVersion": "client.authentication.k8s.io/v1beta1",
                "kind": "ExecCredential",
                "status": {
                    "token": "stdout-sentinel",
                    "expirationTimestamp": "0001-01-01T00:00:00+01:00",
                },
            }
        ),
    )
    with pytest.raises(ClusterUnavailable) as exc:
        async with connections.api("c1"):
            pass
    assert str(exc.value) == (
        f"This cluster signs in with '{sys.executable}', which failed: "
        "the login command returned invalid credentials"
    )
    assert exc.value.__context__ is None
    assert "stdout-sentinel" not in caplog.text


async def test_log_follow_reconnect_after_expiry_uses_fresh_token(connections, fake_api, plugin):
    seen = accept_latest(fake_api, plugin)
    fake_api.pods[("demo", "crasher")] = pod()
    async with aclosing(make(connections, follow=True).lines()) as lines:
        await fake_api.follow_lines.put("before")
        assert (await next_item(lines))["text"] == "before"
        await asyncio.sleep(2)
        await fake_api.follow_lines.put(CUT)
        await fake_api.follow_lines.put("after")
        assert (await next_item(lines))["text"] == "after"
    await fake_api.follow_lines.put(None)
    assert set(seen) == {"Bearer exec-1", "Bearer exec-2"}


async def test_exec_ws_carries_current_token(connections, fake_api, plugin):
    seen = accept_latest(fake_api, plugin)
    async with connections.api("c1") as api:
        await request_version(api)
    before_expiry = await KubeExecChannel.open(connections, "c1", "demo", "web-1", "app", ["sh"])
    await before_expiry.close()
    await asyncio.sleep(2)
    channel = await KubeExecChannel.open(connections, "c1", "demo", "web-1", "app", ["sh"])
    try:
        assert seen == ["Bearer exec-1", "Bearer exec-1", "Bearer exec-2"]
    finally:
        await channel.close()


async def test_port_forward_new_connection_uses_current_token(fake_api, tmp_path, plugin):
    config, _ = plugin
    seen = accept_latest(fake_api, plugin)
    fake_api.pods[("demo", "web-1")] = forward_pod("web-1")
    async with make_env(fake_api, tmp_path, free_ports(2), kubeconfig=config) as env:
        out = await env.forwards.start(env.request(), "local")
        assert await echo(out.local_port) == b"ping"
        await asyncio.sleep(2)
        assert await echo(out.local_port) == b"ping"
    assert seen == ["Bearer exec-1", "Bearer exec-1", "Bearer exec-2"]


async def test_watch_rewatch_after_token_expiry_uses_fresh_token(fake_api, tmp_path, plugin):
    config, _ = plugin
    accept_latest(fake_api, plugin)
    latest = fake_api.token_check
    watch_headers = []

    def check(header):
        if fake_api.requests[-1][2].get("watch", "").lower() == "true":
            watch_headers.append(header)
        return latest(header)

    fake_api.token_check = check
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    async with app.router.lifespan_context(app):
        await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(config), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        ws = RecordingWebSocket(app)
        handler = asyncio.create_task(watch(ws, "pods"))
        messages = []

        async def receive_until(wanted):
            async with asyncio.timeout(5):
                while True:
                    message = await ws.sent.get()
                    messages.append(message)
                    if message["type"] == wanted:
                        return

        try:
            await receive_until("upsert")
            await asyncio.sleep(2)
            fake_api.mode = "instant_close"
            fake_api.release.set()
            await receive_until("upsert")
        finally:
            ws.gone.set()
            await asyncio.wait_for(handler, 5)
    assert [m["state"] for m in messages if m["type"] == "cluster_status"] == ["syncing", "ready"]
    assert watch_headers[:2] == ["Bearer exec-1", "Bearer exec-2"]


async def test_forget_drops_cached_tokens(connections, fake_api, plugin):
    seen = accept_latest(fake_api, plugin)
    async with connections.api("c1") as api:
        await request_version(api)
    connections.forget("c1")
    async with connections.api("c1") as api:
        await request_version(api)
    assert seen == ["Bearer exec-1", "Bearer exec-2"]


async def test_certificate_plugin_falls_back_without_rerunning(plugin, tmp_path, caplog):
    from omnikrux.kube.tokens import RunPlugin

    config, state = plugin
    config["clusters"][0]["cluster"]["server"] = "https://127.0.0.1"
    key = Ed25519PrivateKey.generate()
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "local test")])
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(subject)
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(now - timedelta(minutes=1))
        .not_valid_after(now + timedelta(minutes=1))
        .sign(key, algorithm=None)
    )
    cert_file, key_file = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_file.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    connections = ClusterConnections(
        FakeRegistry({"c1": config}),
        exec_resolver=lambda cfg: RunPlugin(
            cfg, {"FAKE_PLUGIN_CERT": str(cert_file), "FAKE_PLUGIN_KEY": str(key_file)}
        ),
    )
    async with connections.api("c1") as api:
        assert api.configuration.cert_file
        assert api.configuration.key_file
        assert "BearerToken" not in api.configuration.api_key
    assert state.read_text() == "1"
    assert "boom: no login" not in caplog.text


@pytest.mark.parametrize("priority", ["cluster", "resolver"])
async def test_native_token_sources_take_priority(plugin, fake_api, priority):
    from omnikrux.kube.tokens import BearerToken, NativeToken

    config, state = plugin
    calls = []

    async def mint():
        calls.append("mint")
        return BearerToken("native", None)

    async def tokens_for(cluster_id):
        assert cluster_id == "c1"
        return mint if priority == "cluster" else None

    def resolve(exec_cfg):
        assert priority == "resolver"
        assert exec_cfg == config["users"][0]["user"]["exec"]
        return NativeToken(mint)

    connections = ClusterConnections(
        FakeRegistry({"c1": config}), tokens_for=tokens_for, exec_resolver=resolve
    )
    fake_api.token_check = lambda header: header == "Bearer native"
    async with connections.api("c1") as api:
        await request_version(api)
    assert calls == (["mint", "mint"] if priority == "cluster" else ["mint"])
    assert not state.exists()


async def test_log_refresh_failure_has_the_login_message(fake_api):
    from omnikrux.kube.tokens import BearerToken
    from omnikrux.logs.stream import LogStreamError

    fake_api.pods[("demo", "crasher")] = pod()
    message = "This cluster's login has expired. Sign in again."
    reads = 0

    async def token():
        nonlocal reads
        reads += 1
        if reads == 1:  # client creation succeeds
            return BearerToken("local-fake", None)
        raise ClusterUnavailable(message)

    async def tokens_for(_):
        return token

    connections = ClusterConnections(
        FakeRegistry({"c1": kubeconfig_for(fake_api)}), tokens_for=tokens_for
    )
    with pytest.raises(LogStreamError) as exc:
        await next_item(make(connections, follow=True).lines())
    assert str(exc.value) == message


EXPIRED_MESSAGE = "The cluster login returned an expired token. Check the login, then try again."


@pytest.mark.parametrize("hold", ["parent", "child"])
async def test_hanging_plugin_times_out_for_every_waiter(plugin, hold, monkeypatch, caplog):
    config, state = plugin
    monkeypatch.setenv("FAKE_PLUGIN_HOLD", hold)
    monkeypatch.setattr(tokens, "EXEC_PLUGIN_TIMEOUT_SECONDS", 0.5, raising=False)
    fetch = tokens.ExecPluginToken(tokens.RunPlugin(config["users"][0]["user"]["exec"]))
    cache = tokens.CachedToken(fetch)
    waiters = [asyncio.create_task(cache()) for _ in range(3)]
    await asyncio.sleep(0)  # let all three join the shared refresh
    waiters[0].cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiters[0]
    results = await asyncio.wait_for(asyncio.gather(*waiters[1:], return_exceptions=True), 1.5)
    assert all(isinstance(result, ClusterUnavailable) for result in results)
    assert all("the login command did not finish within" in str(result) for result in results)
    assert state.read_text() == "1"
    assert "stdout sentinel" not in caplog.text
    assert "stderr sentinel" not in caplog.text
    monkeypatch.delenv("FAKE_PLUGIN_HOLD")
    assert (await cache()).value == "exec-2"


async def test_cancelled_plugin_does_not_wait_for_inherited_pipes(plugin, monkeypatch):
    config, state = plugin
    monkeypatch.setenv("FAKE_PLUGIN_HOLD", "child")
    fetch = tokens.ExecPluginToken(tokens.RunPlugin(config["users"][0]["user"]["exec"]))
    task = asyncio.create_task(fetch())
    try:
        async with asyncio.timeout(2):
            while not state.exists():
                await asyncio.sleep(0.01)
        task.cancel()
        done, _ = await asyncio.wait({task}, timeout=1)
        assert task in done
    finally:
        (result,) = await asyncio.gather(task, return_exceptions=True)
    assert isinstance(result, asyncio.CancelledError)


async def test_expired_fetch_is_not_published_or_cached():
    current = EPOCH
    issued = iter([EPOCH, EPOCH + timedelta(minutes=5)])

    async def fetch():
        return tokens.BearerToken("fake", next(issued))

    cache = tokens.CachedToken(fetch, clock=lambda: current)
    with pytest.raises(ClusterUnavailable) as exc:
        await cache()
    assert str(exc.value) == EXPIRED_MESSAGE
    usable = await cache()
    assert usable.expires_at > current
    assert await cache() is usable


async def test_client_refuses_expired_token_from_external_source(fake_api):
    current = tokens.BearerToken("valid", None)

    async def token():
        return current

    async with await make_api_client(kubeconfig_for(fake_api), token=token) as api:
        await request_version(api)
        current = tokens.BearerToken("expired", datetime.now(UTC) - timedelta(seconds=1))
        with pytest.raises(ClusterUnavailable) as exc:
            await request_version(api)
        assert str(exc.value) == EXPIRED_MESSAGE
    assert fake_api.auth == {"Bearer valid"}


async def test_reusable_ws_client_asks_for_the_current_token_on_each_upgrade(fake_api):
    current = "first"

    async def token():
        return tokens.BearerToken(current, None)

    async def tokens_for(_):
        return token

    def check(header):
        return header == f"Bearer {current}"

    connections = ClusterConnections(
        FakeRegistry({"c1": kubeconfig_for(fake_api)}), tokens_for=tokens_for
    )
    fake_api.token_check = check
    async with connections.ws_api("c1") as ws_api:
        api = CoreV1Api(ws_api)
        for current in ("first", "second"):
            connecting = await api.connect_get_namespaced_pod_exec(
                "web-1",
                "demo",
                container="app",
                command=["sh"],
                _preload_content=False,
                _headers={"sec-websocket-protocol": "v4.channel.k8s.io"},
            )
            async with connecting as ws:
                assert not ws.closed
    assert len(fake_api.execs) == 2
    assert fake_api.auth == {"Bearer first", "Bearer second"}
