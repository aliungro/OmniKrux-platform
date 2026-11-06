"""WS /api/logs and the download route: the handler is driven directly over a fake WebSocket
(the fake Kubernetes API shares the test's event loop), routing and the origin guard through
Starlette's TestClient, the download through httpx."""

import asyncio
import json
import logging

import httpx
import pytest
import yaml
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.logs.api import MAX_SELECTOR_PODS, QUEUE_LIMIT, LineBuffer, logs, send_batches
from omnikrux.main import create_app
from tests.fakekube import kubeconfig_for
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


class FakeWebSocket:
    """Records what the handler sends; `hold` stalls the first `lines` send (a slow client)."""

    def __init__(self, app=None, hold: asyncio.Event | None = None):
        self.app = app
        self.headers = {"host": "testserver"}
        self.sent: list[dict] = []
        self.closed: tuple[int, str | None] | None = None
        self.gone = asyncio.Event()
        self.hold = hold
        self.holding = asyncio.Event()

    async def accept(self): ...

    async def close(self, code=1000, reason=None):
        self.closed = (code, reason)

    async def send_text(self, text):
        msg = json.loads(text)
        if msg["type"] == "lines" and self.hold is not None and not self.holding.is_set():
            self.holding.set()
            await self.hold.wait()
        self.sent.append(msg)

    async def receive(self):
        await self.gone.wait()
        return {"type": "websocket.disconnect"}

    def lines(self) -> list[dict]:
        return [line for m in self.sent if m["type"] == "lines" for line in m["lines"]]


async def run(app, cluster_id, ws=None, **params) -> FakeWebSocket:
    ws = ws or FakeWebSocket(app)
    await asyncio.wait_for(logs(ws, cluster=cluster_id, namespace="demo", **params), 10)
    return ws


def statuses(ws: FakeWebSocket) -> list[tuple[str, str | None]]:
    return [(m["state"], m["message"]) for m in ws.sent if m["type"] == "status"]


async def test_selector_interleaves_pods_with_labels(app, fake_api, caplog):
    app_, cluster_id = app
    web = {"app": "web"}
    fake_api.pods[("demo", "web-a")] = pod("web-a", labels=web)
    fake_api.pods[("demo", "web-b")] = pod("web-b", containers=("sidecar", "app"), labels=web)
    fake_api.pods[("demo", "web-c")] = pod("web-c", containers=("main",), labels=web)
    fake_api.pods[("demo", "db")] = pod("db", labels={"app": "db"})
    for name, container in [("web-a", "app"), ("web-b", "app"), ("web-c", "main"), ("db", "app")]:
        fake_api.logs[("demo", name, container, False)] = [f"{name} says hi", f"{name} bye"]

    with caplog.at_level(logging.INFO, logger="omnikrux.logs.api"):
        ws = await run(app_, cluster_id, selector="app=web", container="app", follow=False)

    got = {(line["pod"], line["container"], line["text"]) for line in ws.lines()}
    assert got == {
        (p, c, f"{p} {word}")
        for p, c in [("web-a", "app"), ("web-b", "app"), ("web-c", "main")]
        for word in ("says hi", "bye")
    }
    assert statuses(ws) == [("streaming", None), ("ended", None)]
    assert ws.closed[0] == 1000
    assert "selector=app=web" in caplog.text and "says hi" not in caplog.text


async def test_selector_pod_failure_is_a_marker_not_the_end(app, fake_api):
    app_, cluster_id = app
    fake_api.pods[("demo", "web-a")] = pod("web-a", labels={"app": "web"})
    fake_api.pods[("demo", "web-b")] = pod("web-b", labels={"app": "web"})
    fake_api.logs[("demo", "web-a", "app", True)] = ["previous of a"]

    ws = await run(app_, cluster_id, selector="app=web", previous=True, follow=False)

    items = ws.lines()
    assert {"pod": "web-a", "container": "app", "ts": "2026-01-01T00:00:00.000000000Z",
            "text": "previous of a"} in items  # fmt: skip
    [marker] = [i for i in items if "marker" in i]
    assert marker["marker"].startswith('web-b: No previous run of container "app"')
    assert statuses(ws)[-1] == ("ended", None)


async def test_selector_without_matches_is_an_error(app, fake_api):
    app_, cluster_id = app
    ws = await run(app_, cluster_id, selector="app=nope")
    assert statuses(ws) == [("error", "No pods match app=nope in demo")]
    assert ws.closed[0] == 1011


async def test_batches_at_most_500_and_flush_100ms(app, fake_api):
    app_, cluster_id = app
    fake_api.pods[("demo", "chatty")] = pod("chatty")
    seeded = [f"line {i}" for i in range(1200)]
    fake_api.logs[("demo", "chatty", "app", False)] = seeded

    ws = await run(app_, cluster_id, pod="chatty", follow=False, tail_lines=5000)

    batches = [m["lines"] for m in ws.sent if m["type"] == "lines"]
    assert all(0 < len(b) <= 500 for b in batches)
    assert [line["text"] for line in ws.lines()] == seeded
    assert ws.sent[0] == {"type": "status", "state": "streaming", "message": None}
    assert ws.sent[-1] == {"type": "status", "state": "ended", "message": None}
    assert ws.closed[0] == 1000

    # The sender on its own: a lone line waits ~100 ms for company; 500 go at once.
    loop = asyncio.get_running_loop()
    buffer, out = LineBuffer(), FakeWebSocket()
    sender = asyncio.create_task(send_batches(out, buffer))
    start = loop.time()
    buffer.put({"marker": "lone"})
    while not out.sent:
        assert loop.time() - start < 2
        await asyncio.sleep(0.005)
    assert 0.09 <= loop.time() - start < 0.5
    start = loop.time()
    for i in range(1100):
        buffer.put({"marker": str(i)})
    while len(out.sent) < 3:
        assert loop.time() - start < 2
        await asyncio.sleep(0.005)
    assert loop.time() - start < 0.09  # two full batches did not wait for the timer
    buffer.finish()
    await asyncio.wait_for(sender, 2)
    assert [len(m["lines"]) for m in out.sent] == [1, 500, 500, 100]


async def test_slow_client_gets_dropped_marker(app, fake_api):
    app_, cluster_id = app
    assert QUEUE_LIMIT == 10_000
    total = 12_000
    fake_api.pods[("demo", "firehose")] = pod("firehose")
    fake_api.logs[("demo", "firehose", "app", False)] = [f"line {i}" for i in range(total)]
    release = asyncio.Event()
    ws = FakeWebSocket(app_, hold=release)

    handler = asyncio.create_task(
        run(app_, cluster_id, ws, pod="firehose", follow=False, tail_lines=total)
    )
    await asyncio.wait_for(ws.holding.wait(), 5)
    await asyncio.sleep(1)  # the client is stuck on the first batch while lines keep coming
    release.set()
    await handler

    kinds = [m["type"] for m in ws.sent]
    dropped = [m["count"] for m in ws.sent if m["type"] == "dropped"]
    assert dropped and sum(dropped) > 0
    assert kinds.index("dropped") == 2  # streaming, the stuck batch, then the announcement
    texts = [line["text"] for line in ws.lines()]
    assert len(texts) + sum(dropped) == total
    assert len(texts) <= QUEUE_LIMIT + 500
    assert texts[-1] == f"line {total - 1}"  # the oldest lines were dropped, not the newest


async def test_unknown_pod_status_error_plain(app, fake_api):
    app_, cluster_id = app
    ws = await run(app_, cluster_id, pod="ghost")
    [(state, message)] = statuses(ws)
    assert state == "error"
    assert "demo/ghost" in message and "not found" in message
    assert "{" not in message and "Traceback" not in message
    assert ws.closed[0] == 1011


async def test_follow_until_the_client_leaves(app, fake_api):
    app_, cluster_id = app
    fake_api.pods[("demo", "crasher")] = pod()
    ws = FakeWebSocket(app_)
    handler = asyncio.create_task(
        logs(ws, cluster=cluster_id, namespace="demo", pod="crasher", container="app")
    )
    await fake_api.follow_lines.put("live")
    for _ in range(500):
        if ws.lines() or handler.done():
            break
        await asyncio.sleep(0.01)
    assert statuses(ws) == [("streaming", None)]
    assert ws.lines()[0]["text"] == "live"
    ws.gone.set()
    await asyncio.wait_for(handler, 5)
    assert ws.closed is None  # the client left; nothing to close
    await fake_api.follow_lines.put(None)


def test_cross_origin_rejected_4403(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    with (
        TestClient(app) as client,
        pytest.raises(WebSocketDisconnect) as e,
        client.websocket_connect(
            "/api/logs?cluster=c&namespace=demo&pod=p", headers={"origin": "http://evil.example"}
        ) as ws,
    ):
        ws.receive_json()
    assert e.value.code == 4403


def test_unknown_cluster_closes_4404(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    with (
        TestClient(app) as client,
        client.websocket_connect("/api/logs?cluster=nope&namespace=demo&pod=p") as ws,
    ):
        assert ws.receive_json() == {
            "type": "status",
            "state": "error",
            "message": "Unknown cluster",
        }
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_json()
    assert e.value.code == 4404


def test_pod_or_selector_is_required(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    with (
        TestClient(app) as client,
        client.websocket_connect("/api/logs?cluster=c&namespace=demo") as ws,
    ):
        msg = ws.receive_json()
        assert msg["state"] == "error" and "pod or a label selector" in msg["message"]
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_json()
    assert e.value.code == 1008


@pytest.fixture
async def http(app):
    app_, cluster_id = app
    transport = httpx.ASGITransport(app=app_)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client, cluster_id


async def test_download_attachment_headers(http, fake_api):
    client, cluster_id = http
    fake_api.pods[("demo", "crasher")] = pod(restarts=2)
    fake_api.logs[("demo", "crasher", "app", True)] = ["starting", "boom"]
    fake_api.logs[("demo", "crasher", "app", False)] = ["now"]
    base = f"/api/clusters/{cluster_id}/pods/demo/crasher/logs/download"

    r = await client.get(base, params={"container": "app", "previous": "true"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "text/plain; charset=utf-8"
    assert r.headers["content-disposition"] == 'attachment; filename="crasher-app-previous.log"'
    assert r.text == "starting\nboom\n"  # raw text: no timestamps

    r = await client.get(base)  # default container, current run
    assert r.headers["content-disposition"] == 'attachment; filename="crasher-app.log"'
    assert r.text == "now\n"
    query = [q for _, path, q in fake_api.requests if path.endswith("/log")][-1]
    assert query.get("follow", "false").lower() == "false"
    assert "tailLines" not in query


async def test_download_errors_are_plain(http, fake_api):
    client, cluster_id = http
    r = await client.get(f"/api/clusters/{cluster_id}/pods/demo/ghost/logs/download")
    assert r.status_code == 404 and "demo/ghost" in r.json()["detail"]
    fake_api.pods[("demo", "crasher")] = pod()
    r = await client.get(
        f"/api/clusters/{cluster_id}/pods/demo/crasher/logs/download", params={"previous": "true"}
    )
    assert r.status_code == 400  # Kubernetes said no: the request can't be served as asked
    assert r.json()["detail"].startswith('No previous run of container "app"')
    r = await client.get("/api/clusters/nope/pods/demo/crasher/logs/download")
    assert r.status_code == 404 and r.json()["detail"] == "Unknown cluster"


async def test_selector_caps_at_20_running_newest_first(app, fake_api):
    app_, cluster_id = app
    assert MAX_SELECTOR_PODS == 20
    many = {"app": "many"}
    for i in range(22):  # running, created at minute i: the 20 newest are 2..21
        p = pod(f"run-{i:02d}", labels=many)
        p["metadata"]["creationTimestamp"] = f"2026-11-07T10:{i:02d}:00Z"
        fake_api.pods[("demo", p["metadata"]["name"])] = p
    for i in range(3):  # newer, but not running
        p = pod(f"wait-{i}", labels=many, phase="Pending")
        p["metadata"]["creationTimestamp"] = f"2026-11-07T11:0{i}:00Z"
        fake_api.pods[("demo", p["metadata"]["name"])] = p
    for name in [n for _, n in fake_api.pods]:
        fake_api.logs[("demo", name, "app", False)] = [f"{name} hi"]

    ws = await run(app_, cluster_id, selector="app=many", follow=False)

    items = ws.lines()
    assert items[0] == {"marker": "Showing logs from 20 of 25 pods matching app=many"}
    assert {i["pod"] for i in items[1:]} == {f"run-{i:02d}" for i in range(2, 22)}
    assert statuses(ws)[-1] == ("ended", None)


async def until_lines(ws: FakeWebSocket) -> None:
    for _ in range(500):
        if ws.lines():
            return
        await asyncio.sleep(0.01)
    raise AssertionError(f"no lines arrived: {ws.sent}")


async def test_selector_markers_name_their_pod(app, fake_api):
    app_, cluster_id = app
    fake_api.pods[("demo", "web-a")] = pod("web-a", labels={"app": "web"})
    ws = FakeWebSocket(app_)
    handler = asyncio.create_task(
        logs(ws, cluster=cluster_id, namespace="demo", selector="app=web")
    )
    await fake_api.follow_lines.put("hello")
    await until_lines(ws)
    del fake_api.pods[("demo", "web-a")]
    await fake_api.follow_lines.put(None)
    await asyncio.wait_for(handler, 5)
    assert [i.get("marker", i.get("text")) for i in ws.lines()] == ["hello", "web-a: Pod deleted"]
    assert statuses(ws)[-1] == ("ended", None)


async def test_pod_mode_markers_are_not_prefixed(app, fake_api):
    app_, cluster_id = app
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    ws = FakeWebSocket(app_)
    handler = asyncio.create_task(logs(ws, cluster=cluster_id, namespace="demo", pod="web-a"))
    await fake_api.follow_lines.put("hello")
    await until_lines(ws)
    del fake_api.pods[("demo", "web-a")]
    await fake_api.follow_lines.put(None)
    await asyncio.wait_for(handler, 5)
    assert ws.lines()[-1] == {"marker": "Pod deleted"}


class GatedWebSocket(FakeWebSocket):
    """The first `dropped` send waits for `gate`: lines keep arriving (and being dropped)."""

    def __init__(self):
        super().__init__()
        self.gate = asyncio.Event()
        self.at_gate = asyncio.Event()

    async def send_text(self, text):
        if json.loads(text)["type"] == "dropped" and not self.at_gate.is_set():
            self.at_gate.set()
            await self.gate.wait()
        await super().send_text(text)


async def test_dropped_count_sits_right_before_the_lines_after_the_gap():
    buffer, ws = LineBuffer(limit=10), GatedWebSocket()
    sender = asyncio.create_task(send_batches(ws, buffer))
    for i in range(15):  # 0..4 dropped
        buffer.put({"text": str(i)})
    await asyncio.wait_for(ws.at_gate.wait(), 2)
    for i in range(15, 30):  # sent while the client is stuck: 15..19 dropped
        buffer.put({"text": str(i)})
    ws.gate.set()
    buffer.finish()
    await asyncio.wait_for(sender, 2)

    expected = 0  # each batch starts where the previous ended plus what was announced dropped
    for msg in ws.sent:
        if msg["type"] == "dropped":
            expected += msg["count"]
        else:
            assert int(msg["lines"][0]["text"]) == expected
            expected = int(msg["lines"][-1]["text"]) + 1
    assert expected == 30


def test_markers_are_never_dropped():
    buffer = LineBuffer(limit=3)

    async def fill():
        buffer.put({"text": "a"})
        buffer.put({"marker": "Container restarted at t, restart 1"})
        for text in "bcde":
            buffer.put({"text": text})

    asyncio.run(fill())
    assert buffer.take(10) == [
        {"marker": "Container restarted at t, restart 1"},
        {"text": "d"},
        {"text": "e"},
    ]
    assert buffer.dropped == 3
