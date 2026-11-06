import asyncio
from types import SimpleNamespace

import pytest
from starlette.websockets import WebSocketDisconnect

from omnikrux.watch.api import watch
from omnikrux.watch.hub import WatchHub
from tests.watch.fakes import FakeSource
from tests.watch.test_cache import p


def test_ws_streams_snapshot(app_with_fake_sources):  # fixture: app whose hub uses FakeSource per cluster
    client = app_with_fake_sources
    types = set()
    with client.websocket_connect("/api/watch?kind=pods") as ws:
        # Two clusters send 3 messages each (syncing, ready, snapshot); their interleaving is not fixed.
        for _ in range(6):
            types.add(ws.receive_json()["type"])
            if "snapshot" in types:
                break
    assert "snapshot" in types


def test_ws_unknown_kind_closes_4404(app_with_fake_sources):
    with pytest.raises(WebSocketDisconnect) as e, app_with_fake_sources.websocket_connect("/api/watch?kind=nope") as ws:
        ws.receive_json()
    assert e.value.code == 4404 and e.value.reason == "Unknown kind"


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
