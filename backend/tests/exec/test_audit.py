"""Audit records for the cluster-touching operations outside the action pipeline: shell sessions,
debug containers and node shells."""

import asyncio
import logging

import httpx
import pytest
import yaml
from aiohttp import web
from sqlalchemy import text

from omnikrux.actions import authz
from omnikrux.actions.authz import NotAllowed
from omnikrux.audit.store import AuditEntry
from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.exec import api as exec_api
from omnikrux.exec import debug
from omnikrux.exec.api import DEFAULT_COMMAND
from omnikrux.main import create_app
from tests.exec.test_api import until_stdout
from tests.exec.test_debug import node_shell, start_shell
from tests.exec.test_session import BrowserSocket, FakeExecChannel
from tests.fakekube import kubeconfig_for, status_body
from tests.logs.test_stream import pod


@pytest.fixture(autouse=True)
def fast_polls(monkeypatch):
    monkeypatch.setattr(debug, "POLL_SECONDS", 0.01)


@pytest.fixture
async def app(fake_api, tmp_path):
    """The real app and registry, with one uploaded cluster pointing at the fake API."""
    app = create_app(
        Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
    )
    async with app.router.lifespan_context(app):
        [info] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(kubeconfig_for(fake_api)), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        yield app, info.id


@pytest.fixture
async def http(app):
    app_, cluster_id = app
    transport = httpx.ASGITransport(app=app_)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client, cluster_id


@pytest.fixture
def fake_channel(monkeypatch):
    """Exec opens a FakeExecChannel instead of a real stream; the test drives it."""
    channel = FakeExecChannel()
    channel.opens = []  # one entry per KubeExecChannel.open call

    async def open_channel(*args, **kwargs):
        channel.opens.append(args)
        return channel

    monkeypatch.setattr(exec_api.KubeExecChannel, "open", open_channel)
    return channel


def start(app, ws, name: str, namespace: str = "demo", **params) -> asyncio.Task:
    _, cluster_id = app
    params = {"container": None, "command": None} | params
    return asyncio.create_task(
        asyncio.wait_for(
            exec_api.exec_shell(ws, cluster=cluster_id, namespace=namespace, pod=name, **params),
            10,
        )
    )


async def records(app) -> list:
    return (await app[0].state.audit.list()).records


async def wait_for_record(app) -> None:
    for _ in range(500):
        if await records(app):
            return
        await asyncio.sleep(0.01)
    raise AssertionError("no audit record was written")


async def test_exec_session_audited_open_and_end(app, fake_api):
    _, cluster_id = app
    fake_api.pods[("demo", "web-a")] = pod("web-a", containers=("app", "sidecar"))
    ws = BrowserSocket(app[0])
    handler = start(app, ws, "web-a")
    ws.type({"type": "stdin", "data": "echo hi\r"})
    await until_stdout(ws, "echo hi")

    [record] = await records(app)  # written once the shell opened
    assert (record.action, record.outcome, record.finished_at) == ("shell", "started", None)
    assert (record.cluster_id, record.namespace, record.kind, record.name) == (
        cluster_id,
        "demo",
        "pods",
        "web-a",
    )
    assert record.details == {"container": "app", "command": DEFAULT_COMMAND}
    assert record.actor == "local"

    ws.type({"type": "stdin", "data": "exit 7"})
    await handler

    [record] = await records(app)
    assert (record.outcome, record.message) == ("ended", "exit 7")
    assert record.finished_at is not None
    assert "echo hi" not in str(record)  # what was typed is not recorded


async def test_exec_session_ended_by_browser_or_failure(app, fake_api, fake_channel):
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    ws = BrowserSocket(app[0])
    handler = start(app, ws, "web-a", command=["sh"])
    ws.type({"type": "stdin", "data": "ls\r"})
    await asyncio.wait_for(fake_channel.got_input.wait(), 5)
    ws.leave()
    await handler

    [record] = await records(app)
    assert (record.outcome, record.message) == ("ended", "The browser closed the shell.")
    assert record.details == {"container": "app", "command": ["sh"]}


async def test_exec_session_broken_stream_is_failed(app, fake_api, fake_channel):
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    ws = BrowserSocket(app[0])
    handler = start(app, ws, "web-a")
    await wait_for_record(app)
    fake_channel.outbox.put_nowait(ConnectionResetError("reset"))
    await handler

    [record] = await records(app)
    assert record.outcome == "failed"
    assert record.message == (
        "The connection to the shell broke (ConnectionResetError). Reconnect to start a new shell."
    )


async def test_exec_command_that_cannot_run_is_failed(app, fake_api, fake_channel):
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    ws = BrowserSocket(app[0])
    handler = start(app, ws, "web-a")
    await wait_for_record(app)
    fake_channel.finish(
        {
            "status": "Failure",
            "message": "exec: no such file",
            "details": {"causes": [{"reason": "ExitCode", "message": "127"}]},
        }
    )
    await handler

    [record] = await records(app)
    assert record.outcome == "failed"
    assert record.message.startswith("The command couldn't run in the container (exit 127")


async def test_exec_refused_when_audit_unavailable(app, fake_api, fake_channel):
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    async with app[0].state.engine.begin() as conn:
        await conn.execute(text("DROP TABLE audit"))
    ws = BrowserSocket(app[0])

    await start(app, ws, "web-a", command=["sh", "-c", "touch /tmp/ran"])

    assert ws.sent == [
        {
            "type": "error",
            "message": "Nothing was changed: the audit log can't be written "
            "(no such table: audit).",
        }
    ]
    assert ws.closed == (1011, None)
    # No audit, no change: the command never reached the cluster.
    assert fake_channel.opens == [] and fake_api.execs == []


async def test_exec_audited_before_the_channel_opens(app, fake_api, monkeypatch):
    """The record exists before the command can start; a channel that then won't open
    finishes it `failed` with the words the browser gets."""
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    seen = []
    real_open = exec_api.KubeExecChannel.open

    async def open_after_audit(*args, **kwargs):
        seen.append([(r.action, r.outcome) for r in await records(app)])
        return await real_open(*args, **kwargs)

    async def refuse(request, key):
        return web.json_response(status_body(403, "Forbidden", "nope"), status=403)

    monkeypatch.setattr(exec_api.KubeExecChannel, "open", open_after_audit)
    monkeypatch.setattr(fake_api, "_exec", refuse)
    ws = BrowserSocket(app[0])

    await start(app, ws, "web-a")

    assert seen == [[("shell", "started")]]
    message = "Not allowed to open a shell in pod demo/web-a: forbidden"
    assert ws.sent == [{"type": "error", "message": message}]
    [record] = await records(app)
    assert (record.outcome, record.message) == ("failed", message)


async def test_exec_into_stopped_container_writes_no_record(app, fake_api, fake_channel):
    fake_api.pods[("demo", "web-a")] = pod("web-a", state={"waiting": {"reason": "Error"}})
    ws = BrowserSocket(app[0])

    await start(app, ws, "web-a")

    assert ws.sent[0]["type"] == "error" and ws.closed == (1011, None)
    assert fake_channel.opens == [] and await records(app) == []


async def test_exec_not_allowed(app, fake_api, fake_channel, monkeypatch):
    calls = []

    async def refusing(*args):
        calls.append(args)
        raise NotAllowed("Not allowed to open a shell here.")

    monkeypatch.setattr(authz, "authorize", refusing)
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    ws = BrowserSocket(app[0])

    await start(app, ws, "web-a")

    assert ws.sent == [{"type": "error", "message": "Not allowed to open a shell here."}]
    assert ws.closed == (4403, None)
    assert calls == [("local", "shell", app[1], "demo", "pods", "web-a")]
    assert fake_channel.stdin == [] and await records(app) == []


async def test_refused_node_shell_session_still_deletes_its_pod(
    app, fake_api, fake_channel, monkeypatch
):
    record_id = await app[0].state.audit.begin(
        AuditEntry(
            actor="local",
            action="node_shell",
            cluster_id=app[1],
            namespace="default",
            kind="pods",
            name="omnikrux-node-shell-abcde",
            details={"node": "worker-1"},
        )
    )
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = node_shell()

    async def refusing(*args):
        raise NotAllowed("Not allowed to open a shell here.")

    monkeypatch.setattr(authz, "authorize", refusing)
    ws = BrowserSocket(app[0])

    await start_shell(app, ws, "omnikrux-node-shell-abcde", cleanup_pod=True)

    assert ws.closed == (4403, None) and fake_channel.opens == []
    assert fake_api.deleted == [("default", "omnikrux-node-shell-abcde")]
    [record] = await records(app)
    assert (record.id, record.outcome, record.message) == (record_id, "ended", "Pod deleted")


async def test_debug_failure_with_structured_detail_still_finishes(
    http, app, fake_api, monkeypatch
):
    from fastapi import HTTPException

    from omnikrux.resources import api as resources_api

    async def structured(*args, **kwargs):
        raise HTTPException(status_code=502, detail={"reason": "odd"})

    monkeypatch.setattr(resources_api, "_call", structured)
    client, cluster_id = http
    r = await client.post(f"/api/clusters/{cluster_id}/pods/demo/web-a/debug", json={})

    assert r.status_code == 502
    [record] = await records(app)
    assert (record.outcome, record.message) == ("failed", "{'reason': 'odd'}")


async def test_debug_container_audited(http, app, fake_api):
    client, cluster_id = http
    fake_api.pods[("demo", "web-a")] = pod("web-a")

    r = await client.post(
        f"/api/clusters/{cluster_id}/pods/demo/web-a/debug", json={"target": "app"}
    )

    assert r.status_code == 200
    [record] = await records(app)
    assert (record.action, record.namespace, record.kind, record.name) == (
        "debug_container",
        "demo",
        "pods",
        "web-a",
    )
    assert record.details == {"container": r.json()["container"], "target": "app"}
    assert record.outcome == "succeeded" and record.finished_at is not None

    r = await client.post(
        f"/api/clusters/{cluster_id}/pods/demo/web-a/debug", json={"target": "nope"}
    )
    assert r.status_code == 502
    failed, _ = await records(app)
    assert (failed.outcome, failed.message) == ("failed", r.json()["detail"])

    r = await client.post("/api/clusters/nope/pods/demo/web-a/debug", json={})
    assert r.status_code == 404 and len(await records(app)) == 2  # unknown cluster: no record


async def test_debug_container_refused_without_audit(http, app, fake_api):
    client, cluster_id = http
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    async with app[0].state.engine.begin() as conn:
        await conn.execute(text("DROP TABLE audit"))

    r = await client.post(f"/api/clusters/{cluster_id}/pods/demo/web-a/debug", json={})

    assert r.status_code == 503
    assert r.json() == {
        "detail": "Nothing was changed: the audit log can't be written (no such table: audit)."
    }
    assert fake_api.patches == []


async def test_node_shell_audited_until_deleted(http, app, fake_api, fake_channel):
    client, cluster_id = http

    r = await client.post(f"/api/clusters/{cluster_id}/nodes/worker-1/shell")

    assert r.status_code == 200
    name = r.json()["pod"]
    [record] = await records(app)
    assert (record.action, record.outcome) == ("node_shell", "started")
    assert (record.cluster_id, record.namespace, record.kind, record.name) == (
        cluster_id,
        "default",
        "pods",
        name,
    )
    assert record.details == {"node": "worker-1"}

    ws = BrowserSocket(app[0])
    handler = start_shell(app, ws, name, cleanup_pod=True)
    await asyncio.wait_for(fake_channel_opened(app), 5)
    fake_channel.finish({"metadata": {}, "status": "Success"})
    await handler

    by_action = {r.action: r for r in await records(app)}
    node = by_action["node_shell"]
    assert (node.outcome, node.message) == ("ended", "Pod deleted")
    assert by_action["shell"].outcome == "ended"
    assert fake_api.deleted == [("default", name)]


async def fake_channel_opened(app) -> None:
    while len(await records(app)) < 2:  # the node shell's record, then the session's
        await asyncio.sleep(0.01)


async def test_node_shell_that_never_starts_is_failed(http, app, fake_api, monkeypatch):
    client, cluster_id = http
    monkeypatch.setattr(debug, "START_SECONDS", 0.1)
    fake_api.start_states = [{"waiting": {"reason": "ErrImagePull"}}]

    r = await client.post(f"/api/clusters/{cluster_id}/nodes/worker-1/shell")

    assert r.status_code == 502
    [record] = await records(app)
    assert (record.action, record.outcome, record.message) == (
        "node_shell",
        "failed",
        r.json()["detail"],
    )


@pytest.mark.parametrize("seen", ["gone", "error"])
async def test_node_shell_cleanup_that_deletes_nothing_or_fails(
    app, fake_api, fake_channel, monkeypatch, caplog, seen
):
    caplog.set_level(logging.INFO, logger="omnikrux.exec.api")
    audit = app[0].state.audit
    record_id = await audit.begin(
        AuditEntry(
            actor="local",
            action="node_shell",
            cluster_id=app[1],
            namespace="default",
            kind="pods",
            name="omnikrux-node-shell-abcde",
            details={"node": "worker-1"},
        )
    )
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = node_shell()
    if seen == "gone":

        async def nothing(api, ns, name):
            return 0

        monkeypatch.setattr(exec_api, "delete_node_shell_pod", nothing)
    else:

        async def broken(api, ns, name):
            raise ConnectionResetError("reset")

        monkeypatch.setattr(exec_api, "delete_node_shell_pod", broken)
    ws = BrowserSocket(app[0])
    handler = start_shell(app, ws, "omnikrux-node-shell-abcde", cleanup_pod=True)
    await asyncio.wait_for(fake_channel_opened(app), 5)
    fake_channel.finish({"metadata": {}, "status": "Success"})
    await handler

    record = next(r for r in await records(app) if r.id == record_id)
    if seen == "gone":
        assert (record.outcome, record.message) == ("ended", "The pod was already gone.")
        assert "nothing matched" in caplog.text
    else:
        assert record.outcome == "failed"
        assert record.message.startswith("Couldn't delete node-shell pod")
