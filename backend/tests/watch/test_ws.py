import pytest
from starlette.websockets import WebSocketDisconnect


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


def test_ws_repeated_connects_release_everything(app_with_fake_sources):
    # The client's disconnect races with the server cancelling the handler; cleanup must survive both.
    client = app_with_fake_sources
    hub = client.app.state.hub
    for _ in range(50):
        with client.websocket_connect("/api/watch?kind=pods") as ws:
            ws.receive_json()
    assert hub._subscriptions == set()
    assert [len(c._subscribers) for c in hub._caches.values()] == [0, 0]
