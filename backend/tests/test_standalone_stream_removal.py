"""R70 repros using actual app routes and loopback Kubernetes, without a watch socket."""

import asyncio
import json
from contextlib import asynccontextmanager
from urllib.parse import urlencode

import aiohttp
import httpx
import pytest
import yaml
from aiohttp import web

from omnikrux.audit.store import AuditEntry, AuditUnavailable
from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.exec import session as exec_session
from omnikrux.main import create_app
from tests.exec.test_debug import node_shell
from tests.fakekube import kubeconfig_for, serve_fake_api
from tests.logs.test_stream import pod


@asynccontextmanager
async def browser_socket(app, stream, cluster_id, *, namespace="demo", name="web-1", **options):
    """Drive Starlette's real WebSocket over ASGI on the loop used by the fake Kubernetes API."""
    incoming = asyncio.Queue()
    outgoing = asyncio.Queue()
    incoming.put_nowait({"type": "websocket.connect"})
    scope = {
        "type": "websocket",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "scheme": "ws",
        "path": f"/api/{stream}",
        "root_path": "",
        "query_string": urlencode(
            {"cluster": cluster_id, "namespace": namespace, "pod": name, **options}
        ).encode(),
        "headers": [(b"host", b"testserver"), (b"origin", b"http://testserver")],
        "subprotocols": [],
    }
    handler = asyncio.create_task(app(scope, incoming.get, outgoing.put))
    try:
        assert (await asyncio.wait_for(outgoing.get(), 3))["type"] == "websocket.accept"
        yield incoming, outgoing, handler
    finally:
        incoming.put_nowait({"type": "websocket.disconnect", "code": 1001})
        await asyncio.wait_for(handler, 3)


async def message_from(socket, predicate, *, timeout=3):
    _, outgoing, _ = socket
    async with asyncio.timeout(timeout):
        while True:
            event = await outgoing.get()
            if event["type"] == "websocket.send":
                message = json.loads(event["text"])
                if predicate(message):
                    return message
            else:
                pytest.fail(f"Unexpected WebSocket event before the expected message: {event}")


async def expect_server_close(socket):
    _, outgoing, handler = socket
    try:
        async with asyncio.timeout(1):
            while (event := await outgoing.get())["type"] != "websocket.close":
                assert event["type"] == "websocket.send", event
    except TimeoutError:
        pytest.fail(
            f"Successful removal sent no WebSocket close without a watch client "
            f"(handler completed: {handler.done()})",
            pytrace=False,
        )
    await asyncio.wait_for(asyncio.shield(handler), 3)


async def send_stdin(socket, value):
    incoming, _, _ = socket
    await incoming.put(
        {"type": "websocket.receive", "text": json.dumps({"type": "stdin", "data": value})}
    )


async def expect_live_message(socket, stream, kube, value):
    if stream == "logs":
        await kube.follow_lines.put(value)
        await message_from(
            socket,
            lambda m: (
                m["type"] == "lines" and any(line.get("text") == value for line in m["lines"])
            ),
        )
    else:
        await send_stdin(socket, value)
        await message_from(socket, lambda m: m["type"] == "stdout" and m["data"] == value)


async def import_cluster(app, kube, context):
    config = kubeconfig_for(kube)
    config["current-context"] = context
    config["contexts"][0]["name"] = context
    [cluster] = await app.state.registry.upsert_from_kubeconfig(
        yaml.safe_dump(config), rewrite_loopback=False, source=SOURCE_UPLOAD
    )
    return cluster


@pytest.fixture(params=("cluster", "account"))
async def environment(request, tmp_settings, fake_api, cloud_cluster_context):
    async with serve_fake_api() as other_kube:
        other_kube.pods["demo", "web-1"] = pod("web-1")
        fake_api.pods["demo", "web-1"] = pod("web-1")

        @asynccontextmanager
        async def start():
            if request.param == "account":
                async with cloud_cluster_context("gcp") as (app, cluster, account):
                    yield app, cluster, f"/api/cloud/accounts/{account.id}"
            else:
                app = create_app(tmp_settings.model_copy(update={"rewrite_loopback": False}))
                async with app.router.lifespan_context(app):
                    cluster = await import_cluster(app, fake_api, "remove-me")
                    yield app, cluster, f"/api/clusters/{cluster.id}"

        async with start() as (app, cluster, remove_path):
            other = await import_cluster(app, other_kube, "keep-me")
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://testserver"
            ) as http:
                try:
                    yield app, http, cluster.id, other.id, remove_path, fake_api, other_kube
                finally:
                    fake_api.follow_lines.put_nowait(None)
                    other_kube.follow_lines.put_nowait(None)


@pytest.mark.parametrize("stream", ("logs", "exec"))
async def test_removed_cluster_closes_only_its_standalone_streams(environment, stream, monkeypatch):
    app, http, removed, other, remove_path, removed_kube, other_kube = environment
    kube_closed = asyncio.Event()
    follow_transports = {}
    original_exec = removed_kube._exec

    async def record_exec(request, key):
        try:
            return await original_exec(request, key)
        finally:
            kube_closed.set()

    monkeypatch.setattr(removed_kube, "_exec", record_exec)
    if stream == "logs":
        for kube in (removed_kube, other_kube):
            instrument_follow(monkeypatch, kube, follow_transports)

    async with (
        browser_socket(app, stream, removed) as removed_socket,
        browser_socket(app, stream, other) as other_socket,
    ):
        await expect_live_message(removed_socket, stream, removed_kube, "removed before DELETE")
        await expect_live_message(other_socket, stream, other_kube, "peer before DELETE")
        assert app.state.hub.status(removed) == ("unknown", None)
        assert (await http.delete(remove_path)).status_code == 204
        assert {cluster["id"] for cluster in (await http.get("/api/clusters")).json()} == {other}

        await expect_server_close(removed_socket)
        await expect_live_message(other_socket, stream, other_kube, "peer after DELETE")

        if stream == "exec":
            await asyncio.wait_for(kube_closed.wait(), 3)
            records = {
                row.cluster_id: row
                for row in (await app.state.audit.list()).records
                if row.action == "shell"
            }
            assert records[removed].outcome == "ended"
            assert records[removed].finished_at is not None
            assert records[other].outcome == "started"
        else:
            removed_transport = follow_transports[removed_kube]
            other_transport = follow_transports[other_kube]
            async with asyncio.timeout(3):
                while not removed_transport.is_closing():
                    await asyncio.sleep(0.01)
            assert not other_transport.is_closing()


def instrument_follow(monkeypatch, kube, follow_transports):
    """Expose the peer's actual TCP transport and leave its HTTP response open after each line."""
    original_log = kube._log

    async def record_log(request, key):
        if request.query.get("follow") != "true":
            return await original_log(request, key)
        transport = request.transport
        assert transport is not None
        assert kube not in follow_transports, "the test requires the original upstream response"
        follow_transports[kube] = transport
        response = web.StreamResponse(headers={"Content-Type": "text/plain"})
        await response.prepare(request)
        while (line := await kube.follow_lines.get()) is not None and not transport.is_closing():
            await response.write(f"{line}\n".encode())
        return response

    monkeypatch.setattr(kube, "_log", record_log)


async def test_removed_cluster_deletes_active_node_shell_and_finishes_both_records(environment):
    app, http, cluster, _, remove_path, kube, _ = environment
    name = "omnikrux-node-shell-abcde"
    kube.pods["default", name] = node_shell(name)
    node_audit_id = await app.state.audit.begin(
        AuditEntry("local", "node_shell", cluster, "default", "pods", name)
    )

    async with browser_socket(
        app, "exec", cluster, namespace="default", name=name, cleanup_pod="true"
    ) as socket:
        await expect_live_message(socket, "exec", kube, "node shell before DELETE")
        assert (await http.delete(remove_path)).status_code == 204
        await expect_server_close(socket)

    assert ("default", name) in kube.deleted
    assert ("default", name) not in kube.pods
    records = {row.action: row for row in (await app.state.audit.list()).records}
    node = records["node_shell"]
    assert (node.id, node.outcome, node.message) == (node_audit_id, "ended", "Pod deleted")
    assert node.finished_at is not None
    assert records["shell"].outcome == "ended"
    assert records["shell"].finished_at is not None


async def test_stalled_exec_close_cannot_block_removal_and_node_shell_cleanup(
    environment, monkeypatch
):
    app, http, cluster, _, remove_path, kube, _ = environment
    name = "omnikrux-node-shell-abcde"
    kube.pods["default", name] = node_shell(name)
    await app.state.audit.begin(AuditEntry("local", "node_shell", cluster, "default", "pods", name))
    release_peer = asyncio.Event()
    opened = []
    original_open = exec_session.KubeExecChannel.open

    async def capture_open(cls, *args, **kwargs):
        channel = await original_open(*args, **kwargs)
        opened.append(channel)
        return channel

    async def stall_close_ack(request, key):
        ws = web.WebSocketResponse(protocols=("v4.channel.k8s.io",), autoclose=False)
        await ws.prepare(request)
        message = await ws.receive()
        assert message.type == aiohttp.WSMsgType.BINARY and message.data[0] == 0
        await ws.send_bytes(bytes([1]) + message.data[1:])
        await ws.receive()
        await release_peer.wait()
        return ws

    monkeypatch.setattr(exec_session.KubeExecChannel, "open", classmethod(capture_open))
    monkeypatch.setattr(kube, "_exec", stall_close_ack)
    monkeypatch.setattr(exec_session, "CLOSE_SECONDS", 0.2, raising=False)
    async with browser_socket(
        app, "exec", cluster, namespace="default", name=name, cleanup_pod="true"
    ) as socket:
        await expect_live_message(socket, "exec", kube, "shell before backpressure")
        [channel] = opened
        ws = channel._ws
        # The built-in timeout only covers reading the ACK, after the close frame drains.
        ws._timeout = aiohttp.ClientWSTimeout(ws_close=0.05)
        writer = ws._writer
        writer._output_size = writer._limit
        writer.protocol.pause_writing()
        removal = asyncio.create_task(http.delete(remove_path))
        try:
            async with asyncio.timeout(1):
                while writer.protocol._drain_waiter is None:
                    await asyncio.sleep(0)
            done, _ = await asyncio.wait((removal,), timeout=1)
            assert removal in done, "DELETE stayed blocked sending the Kubernetes WebSocket close"
            assert removal.result().status_code == 204
            assert ws._response.closed and writer.transport.is_closing()
            assert kube.deleted == [("default", name)]
            await expect_server_close(socket)
        finally:
            if writer.protocol._paused:
                writer.protocol.resume_writing()
            release_peer.set()
            await asyncio.wait_for(removal, 3)

    records = {row.action: row for row in (await app.state.audit.list()).records}
    assert records["node_shell"].message == "Pod deleted"
    assert records["shell"].outcome == "ended"


async def test_removal_without_audit_leaves_active_node_shell_running(environment, monkeypatch):
    app, http, cluster, _, remove_path, kube, _ = environment
    name = "omnikrux-node-shell-abcde"
    kube.pods["default", name] = node_shell(name)
    original_begin = app.state.audit.begin

    async def refuse_removal(entry):
        if entry.action in {"cluster_remove", "cloud_account_remove"}:
            raise AuditUnavailable("test unavailable")
        return await original_begin(entry)

    monkeypatch.setattr(app.state.audit, "begin", refuse_removal)
    async with browser_socket(
        app, "exec", cluster, namespace="default", name=name, cleanup_pod="true"
    ) as socket:
        await expect_live_message(socket, "exec", kube, "node shell before refused DELETE")
        assert (await http.delete(remove_path)).status_code == 503
        await expect_live_message(socket, "exec", kube, "node shell after refused DELETE")
        assert kube.deleted == []
        assert (await app.state.registry.get(cluster)).id == cluster


@pytest.mark.parametrize("stream", ("logs", "exec"))
async def test_removal_rejects_new_streams_while_node_shell_cleanup_runs(
    environment, stream, monkeypatch
):
    app, http, cluster, _, remove_path, kube, _ = environment
    name = "omnikrux-node-shell-abcde"
    kube.pods["default", name] = node_shell(name)
    await app.state.audit.begin(AuditEntry("local", "node_shell", cluster, "default", "pods", name))
    cleanup_started = asyncio.Event()
    cleanup_release = asyncio.Event()
    original_route = kube._route

    async def hold_cleanup(request):
        if request.method == "DELETE" and request.path == "/api/v1/namespaces/default/pods":
            cleanup_started.set()
            await cleanup_release.wait()
        return await original_route(request)

    monkeypatch.setattr(kube, "_route", hold_cleanup)
    async with browser_socket(
        app, "exec", cluster, namespace="default", name=name, cleanup_pod="true"
    ) as active:
        await expect_live_message(active, "exec", kube, "node shell before DELETE")
        deletion = asyncio.create_task(http.delete(remove_path))
        try:
            try:
                await asyncio.wait_for(cleanup_started.wait(), 1)
            except TimeoutError:
                pytest.fail(
                    "DELETE did not reach node-shell cleanup before removing its credentials"
                )
            assert (await app.state.registry.get(cluster)).id == cluster
            assert not deletion.done()

            async with browser_socket(app, stream, cluster) as opening:
                await expect_server_close(opening)
            assert len(kube.execs) == 1  # only the original node shell opened
            assert not any(path.endswith("/log") for path in kube.paths)
        finally:
            cleanup_release.set()
            response = await asyncio.wait_for(deletion, 3)
        assert response.status_code == 204
        await expect_server_close(active)


async def test_disconnect_of_delete_caller_after_commit_does_not_leave_shell_open(
    environment, monkeypatch
):
    app, http, cluster, _, remove_path, kube, _ = environment
    committed = asyncio.Event()
    forget_release = asyncio.Event()
    original_forget = app.state.hub.forget

    async def hold_forget(cluster_id):
        with pytest.raises(KeyError):
            await app.state.registry.get(cluster_id)
        committed.set()
        await forget_release.wait()
        await original_forget(cluster_id)

    monkeypatch.setattr(app.state.hub, "forget", hold_forget)
    async with browser_socket(app, "exec", cluster) as socket:
        await expect_live_message(socket, "exec", kube, "shell before DELETE")
        deletion = asyncio.create_task(http.delete(remove_path))
        try:
            await asyncio.wait_for(committed.wait(), 3)
            deletion.cancel()
            await asyncio.sleep(0)  # let the DELETE handler receive cancellation before release
        finally:
            forget_release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(deletion, 3)
        await expect_server_close(socket)

    [shell] = [
        record for record in (await app.state.audit.list()).records if record.action == "shell"
    ]
    assert shell.outcome == "ended" and shell.finished_at is not None


@pytest.mark.parametrize("environment", ("account",), indirect=True)
@pytest.mark.parametrize("account_first", (False, True), ids=("cluster-first", "account-first"))
async def test_overlapping_cluster_and_account_removals_share_node_shell_cleanup(
    environment, account_first, monkeypatch
):
    app, http, cluster, _, account_path, kube, _ = environment
    cluster_path = f"/api/clusters/{cluster}"
    first_path, second_path = (
        (account_path, cluster_path) if account_first else (cluster_path, account_path)
    )
    second_action = "cluster_remove" if account_first else "cloud_account_remove"
    name = "omnikrux-node-shell-abcde"
    kube.pods["default", name] = node_shell(name)
    await app.state.audit.begin(AuditEntry("local", "node_shell", cluster, "default", "pods", name))
    cleanup_started = asyncio.Event()
    cleanup_release = asyncio.Event()
    second_audited = asyncio.Event()
    original_route = kube._route
    original_begin = app.state.audit.begin

    async def hold_cleanup(request):
        if request.method == "DELETE" and request.path == "/api/v1/namespaces/default/pods":
            cleanup_started.set()
            await cleanup_release.wait()
        return await original_route(request)

    async def record_begin(entry):
        audit_id = await original_begin(entry)
        if entry.action == second_action:
            second_audited.set()
        return audit_id

    monkeypatch.setattr(kube, "_route", hold_cleanup)
    monkeypatch.setattr(app.state.audit, "begin", record_begin)
    async with browser_socket(
        app, "exec", cluster, namespace="default", name=name, cleanup_pod="true"
    ) as socket:
        await expect_live_message(socket, "exec", kube, "shell before both DELETEs")
        first = asyncio.create_task(http.delete(first_path))
        second = None
        try:
            await asyncio.wait_for(cleanup_started.wait(), 3)
            second = asyncio.create_task(http.delete(second_path))
            await asyncio.wait_for(second_audited.wait(), 3)
            done, _ = await asyncio.wait((first, second), timeout=0.1)
            assert not done
            assert (await app.state.registry.get(cluster)).id == cluster
        finally:
            cleanup_release.set()
            first_response = await asyncio.wait_for(first, 3)
            if second is not None:
                second_response = await asyncio.wait_for(second, 3)
        account, cluster_response = (
            (first_response, second_response)
            if account_first
            else (second_response, first_response)
        )
        assert account.status_code == 204
        assert cluster_response.status_code in (204, 404)
        await expect_server_close(socket)

    assert kube.deleted == [("default", name)]
    records = {row.action: row for row in (await app.state.audit.list()).records}
    assert records["node_shell"].message == "Pod deleted"
    assert records["shell"].outcome == "ended"
