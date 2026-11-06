"""WS /api/exec: the handler is driven directly over a fake browser socket against the fake
Kubernetes API (its exec route is a small echo shell); routing and the origin guard go through
Starlette's TestClient."""

import asyncio
import logging

import pytest
import yaml
from aiohttp import web
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.exec.api import DEFAULT_COMMAND, exec_shell
from omnikrux.main import create_app
from tests.exec.test_session import BrowserSocket
from tests.fakekube import kubeconfig_for, status_body
from tests.logs.test_stream import pod


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


def start(app, cluster_id, ws: BrowserSocket, pod_name: str, **params) -> asyncio.Task:
    params = {"container": None, "command": None} | params
    return asyncio.create_task(
        asyncio.wait_for(
            exec_shell(ws, cluster=cluster_id, namespace="demo", pod=pod_name, **params), 10
        )
    )


async def until_stdout(ws: BrowserSocket, text: str) -> None:
    for _ in range(500):
        if text in ws.output("stdout"):
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"{text!r} never arrived: {ws.sent}")


async def test_shell_round_trip(app, fake_api, caplog):
    app_, cluster_id = app
    fake_api.pods[("demo", "web-a")] = pod("web-a", containers=("app", "sidecar"))
    ws = BrowserSocket(app_)

    with caplog.at_level(logging.INFO, logger="omnikrux.exec.api"):
        handler = start(app_, cluster_id, ws, "web-a")
        ws.type({"type": "resize", "cols": 100, "rows": 30})
        ws.type({"type": "stdin", "data": "echo secret-ish ünïcode\r"})
        await until_stdout(ws, "ünïcode")
        ws.type({"type": "stdin", "data": "exit 7"})
        await handler

    assert ws.output("stdout") == "echo secret-ish ünïcode\r"
    assert ws.sent[-1] == {"type": "exit", "code": 7, "message": None}
    assert ws.closed == (1000, None)
    [call] = fake_api.execs
    assert call == {
        "command": DEFAULT_COMMAND,
        "container": "app",  # the pod's first container
        "flags": {"stdin": True, "stdout": True, "stderr": True, "tty": True},
        "protocol": "v4.channel.k8s.io",
    }
    assert fake_api.exec_resizes == [{"Width": 100, "Height": 30}]
    opened = f"exec opened cluster={cluster_id} ns=demo pod=web-a container=app"
    assert opened in caplog.messages
    assert "secret-ish" not in caplog.text and "command" not in caplog.text


async def test_named_ephemeral_container_and_command(app, fake_api):
    app_, cluster_id = app
    debugged = pod("web-a")
    debugged["spec"]["ephemeralContainers"] = [{"name": "debugger-x1"}]
    debugged["status"]["ephemeralContainerStatuses"] = [
        {"name": "debugger-x1", "state": {"running": {}}}
    ]
    fake_api.pods[("demo", "web-a")] = debugged
    ws = BrowserSocket(app_)
    handler = start(app_, cluster_id, ws, "web-a", container="debugger-x1", command=["sh"])
    ws.type({"type": "stdin", "data": "exit 0"})
    await handler

    assert ws.sent == [{"type": "exit", "code": 0, "message": None}]
    [call] = fake_api.execs
    assert (call["container"], call["command"]) == ("debugger-x1", ["sh"])


@pytest.mark.parametrize(
    ("state", "shown"),
    [
        (
            {"waiting": {"reason": "CrashLoopBackOff", "message": "back-off 5m0s"}},
            "CrashLoopBackOff",
        ),
        ({"waiting": {}}, "waiting"),
        ({"terminated": {"reason": "Error", "exitCode": 1}}, "Error"),
        ({}, "not started"),
    ],
)
async def test_exec_into_crashing_container_reports_plainly(app, fake_api, state, shown):
    app_, cluster_id = app
    fake_api.pods[("demo", "crasher")] = pod("crasher", state=state, restarts=5)
    ws = BrowserSocket(app_)

    await start(app_, cluster_id, ws, "crasher")

    assert ws.sent == [
        {
            "type": "error",
            "message": f"Can't open a shell: container app isn't running ({shown}). "
            "Start a debug container to look inside the pod.",
        }
    ]
    assert ws.closed == (1011, None)
    assert fake_api.execs == []  # exec was not attempted


async def test_missing_container_or_pod_is_plain(app, fake_api):
    app_, cluster_id = app
    fake_api.pods[("demo", "crasher")] = pod("crasher")
    ws = BrowserSocket(app_)
    await start(app_, cluster_id, ws, "crasher", container="nope")
    assert ws.sent == [{"type": "error", "message": "Container nope isn't in pod crasher."}]
    assert ws.closed == (1011, None)

    ws = BrowserSocket(app_)
    await start(app_, cluster_id, ws, "ghost")
    [error] = ws.sent
    assert error["type"] == "error" and "demo/ghost not found" in error["message"]
    assert "{" not in error["message"]
    assert ws.closed == (1011, None)
    assert fake_api.execs == []


async def test_failed_upgrade_is_plain(app, fake_api, monkeypatch):
    app_, cluster_id = app
    fake_api.pods[("demo", "web-a")] = pod("web-a")

    async def refuse(request, key):  # the pod can be read, but exec is not allowed
        return web.json_response(status_body(403, "Forbidden", "nope"), status=403)

    monkeypatch.setattr(fake_api, "_exec", refuse)
    ws = BrowserSocket(app_)
    await start(app_, cluster_id, ws, "web-a")

    assert ws.sent == [
        {"type": "error", "message": "Not allowed to open a shell in pod demo/web-a: forbidden"}
    ]
    assert ws.closed == (1011, None)


def test_cross_origin_rejected_4403(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    with (
        TestClient(app) as client,
        pytest.raises(WebSocketDisconnect) as e,
        client.websocket_connect(
            "/api/exec?cluster=c&namespace=demo&pod=p", headers={"origin": "http://evil.example"}
        ) as ws,
    ):
        ws.receive_json()
    assert e.value.code == 4403


def test_unknown_cluster_closes_4404(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    with (
        TestClient(app) as client,
        client.websocket_connect("/api/exec?cluster=nope&namespace=demo&pod=p") as ws,
    ):
        assert ws.receive_json() == {"type": "error", "message": "Unknown cluster"}
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_json()
    assert e.value.code == 4404


@pytest.mark.parametrize(
    "query",
    [
        "cluster=c&namespace=demo",
        "cluster=c&namespace=demo&pod=",
        "cluster=c&namespace=demo&pod=p&command=",
    ],
)
def test_bad_params_close_1008(tmp_path, query):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    with (
        TestClient(app) as client,
        pytest.raises(WebSocketDisconnect) as e,
        client.websocket_connect(f"/api/exec?{query}") as ws,
    ):
        while True:
            ws.receive_json()
    assert e.value.code == 1008
