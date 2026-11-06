import asyncio
import logging

from omnikrux.resources.rows import pod_row
from omnikrux.watch.cache import WatchCache
from omnikrux.watch.source import Expired, WatchEvent
from tests.resources.test_rows import c, pod

# scripted: list results + event batches/exceptions per call
from tests.watch.fakes import FakeSource


def p(uid, name="p"):
    x = pod(statuses=[c()])
    x["metadata"].update(uid=uid, name=name)
    return x


async def drain(q, n):
    return [await asyncio.wait_for(q.get(), 1) for _ in range(n)]


async def test_snapshot_then_deltas():
    src = FakeSource(lists=[([p("a")], "1")], watches=[[WatchEvent("ADDED", p("b")), WatchEvent("DELETED", p("a"))]])
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 5)
    assert [m["type"] for m in msgs] == ["cluster_status", "cluster_status", "snapshot", "upsert", "delete"]
    assert msgs[1]["state"] == "ready" and [r["uid"] for r in msgs[2]["rows"]] == ["a"]
    assert set(cache.rows) == {"b"}
    await cache.stop()


async def test_expired_watch_relists_and_drops_ghosts():
    src = FakeSource(lists=[([p("a"), p("b")], "1"), ([p("b")], "9")], watches=[Expired(), []])
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 4)
    snaps = [m for m in msgs if m["type"] == "snapshot"]
    assert [r["uid"] for r in snaps[-1]["rows"]] == ["b"] and set(cache.rows) == {"b"}
    await cache.stop()


async def test_source_failure_sets_error_and_retries():
    from omnikrux.kube.client import ClusterUnavailable

    src = FakeSource(
        factory_errors=[ClusterUnavailable("This cluster signs in with 'kubelogin', which isn't installed in the console.")],
        lists=[([p("a")], "1")],
        watches=[[]],
    )
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 4)
    assert msgs[1] == {
        "type": "cluster_status",
        "cluster_id": "cl",
        "state": "error",
        "message": "This cluster signs in with 'kubelogin', which isn't installed in the console.",
    }
    assert any(m["type"] == "cluster_status" and m["state"] == "ready" for m in msgs)
    await cache.stop()


async def test_snapshot_is_chunked_at_500():
    src = FakeSource(lists=[([p(str(i)) for i in range(1201)], "1")], watches=[[]])
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = [m for m in await drain(q, 5) if m["type"] == "snapshot"]
    assert [len(m["rows"]) for m in msgs] == [500, 500, 201] and [m["last"] for m in msgs] == [False, False, True]
    await cache.stop()


async def test_late_subscriber_gets_status_and_full_snapshot():
    src = FakeSource(lists=[([p("a")], "1")], watches=[[]])
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    await cache.start()
    await asyncio.sleep(0.05)
    msgs = await drain(cache.subscribe(), 2)
    assert msgs[0]["state"] == "ready" and msgs[1]["type"] == "snapshot"
    await cache.stop()


# --- additional coverage -------------------------------------------------------


async def assert_quiet(q):
    await asyncio.sleep(0.05)
    assert q.empty(), [q.get_nowait() for _ in range(q.qsize())]


async def test_initial_status_is_syncing_and_messages_are_json_ready():
    src = FakeSource(lists=[([p("a")], "1")], watches=[[WatchEvent("MODIFIED", p("a", name="renamed"))]])
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    assert (cache.state, cache.message) == ("syncing", None)
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 4)
    assert msgs[0] == {"type": "cluster_status", "cluster_id": "cl", "state": "syncing", "message": None}
    assert msgs[2]["part"] == 0 and msgs[2]["last"] is True and msgs[2]["cluster_id"] == "cl"
    assert isinstance(msgs[2]["rows"][0]["created_at"], str)
    assert msgs[3] == {"type": "upsert", "cluster_id": "cl", "row": msgs[3]["row"]}
    assert msgs[3]["row"]["name"] == "renamed" and cache.rows["a"]["name"] == "renamed"
    await assert_quiet(q)
    await cache.stop()


async def test_empty_cluster_sends_one_empty_last_part():
    src = FakeSource(lists=[([], "1")], watches=[[]])
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 3)
    assert msgs[2] == {"type": "snapshot", "cluster_id": "cl", "rows": [], "part": 0, "last": True}
    await cache.stop()


async def test_expired_relist_keeps_ready_without_status_message():
    src = FakeSource(lists=[([p("a")], "1"), ([p("b")], "9")], watches=[Expired(), []])
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 4)
    assert [m["type"] for m in msgs] == ["cluster_status", "cluster_status", "snapshot", "snapshot"]
    assert cache.state == "ready"
    await assert_quiet(q)
    assert src.watched_from == ["1", "9", "9"]
    await cache.stop()


async def test_watch_resumes_from_latest_resource_version():
    b = p("b")
    b["metadata"]["resourceVersion"] = "7"
    src = FakeSource(lists=[([p("a")], "1")], watches=[[WatchEvent("ADDED", b)], []])
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    await drain(q, 4)
    await assert_quiet(q)
    assert src.watched_from == ["1", "7", "7"]
    await cache.stop()


async def test_generic_error_message_and_backoff_resets_after_successful_list():
    # backoff (0, 60): the first wait is 0s; a second wait of 60s would stall the test,
    # so reaching "ready" twice proves the step counter reset after the first list.
    src = FakeSource(
        factory_errors=[RuntimeError("dns lookup failed")],
        lists=[([p("a")], "1"), ([p("a")], "2")],
        watches=[RuntimeError("connection reset")],
    )
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0, 60))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 9)
    statuses = [(m["state"], m["message"]) for m in msgs if m["type"] == "cluster_status"]
    assert statuses == [
        ("syncing", None),
        ("error", "Can't reach this cluster: dns lookup failed"),
        ("syncing", None),
        ("ready", None),
        ("error", "Can't reach this cluster: connection reset"),
        ("syncing", None),
        ("ready", None),
    ]
    await cache.stop()


async def test_backoff_steps_and_retry_now_skips_the_wait():
    src = FakeSource(
        factory_errors=[RuntimeError("one"), RuntimeError("two")],
        lists=[([p("a")], "1")],
        watches=[[]],
    )
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0, 60))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 4)
    assert [m["state"] for m in msgs] == ["syncing", "error", "syncing", "error"]
    await assert_quiet(q)  # now waiting the 60s step
    await cache.retry_now()
    msgs = await drain(q, 3)
    assert [m["type"] for m in msgs] == ["cluster_status", "cluster_status", "snapshot"]
    assert cache.state == "ready"
    await cache.stop()


async def test_bad_object_is_skipped_and_logged(caplog):
    def to_row(obj, cluster_id):
        if obj["metadata"]["uid"] == "bad":
            raise ValueError("broken object")
        return pod_row(obj, cluster_id)

    src = FakeSource(
        lists=[([p("a"), p("bad")], "1")],
        watches=[[WatchEvent("ADDED", p("bad")), WatchEvent("ADDED", p("b"))]],
    )
    cache = WatchCache("cl", src.factory, to_row, backoff=(0,))
    q = cache.subscribe()
    with caplog.at_level(logging.WARNING, logger="omnikrux.watch.cache"):
        await cache.start()
        msgs = await drain(q, 4)
    assert [r["uid"] for r in msgs[2]["rows"]] == ["a"]
    assert msgs[3]["type"] == "upsert" and msgs[3]["row"]["uid"] == "b"
    assert set(cache.rows) == {"a", "b"} and cache.state == "ready"
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 2
    await cache.stop()


async def test_unsubscribe_stops_delivery():
    src = FakeSource(lists=[([p("a")], "1")], watches=[[]])
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    q = cache.subscribe()
    cache.unsubscribe(q)
    await cache.start()
    await asyncio.sleep(0.05)
    assert [q.get_nowait()["state"] for _ in range(q.qsize())] == ["syncing"]
    await cache.stop()


async def test_stop_before_start_and_twice_is_safe():
    cache = WatchCache("cl", FakeSource().factory, pod_row, backoff=(0,))
    await cache.stop()
    await cache.start()
    await cache.stop()
    await cache.stop()


class ClosingSource(FakeSource):
    """FakeSource that records ``aclose()`` calls (and can fail them)."""

    def __init__(self, *args, aclose_error=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.acloses = 0
        self.aclose_error = aclose_error

    async def aclose(self):
        self.acloses += 1
        if self.aclose_error is not None:
            raise self.aclose_error


async def test_discarded_sources_are_closed_on_retry_and_stop():
    src = ClosingSource(lists=[([p("a")], "1"), ([p("a")], "2")], watches=[RuntimeError("connection reset")])
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 7)
    assert [m.get("state") for m in msgs] == ["syncing", "ready", None, "error", "syncing", "ready", None]
    assert src.acloses == 1  # the failed attempt's source, before the factory ran again
    await cache.stop()
    assert src.acloses == 2


async def test_source_aclose_errors_are_swallowed(caplog):
    src = ClosingSource(
        lists=[([p("a")], "1"), ([p("a")], "2")],
        watches=[RuntimeError("connection reset")],
        aclose_error=RuntimeError("close failed"),
    )
    cache = WatchCache("cl", src.factory, pod_row, backoff=(0,))
    q = cache.subscribe()
    with caplog.at_level(logging.DEBUG, logger="omnikrux.watch.cache"):
        await cache.start()
        await drain(q, 7)
        await cache.stop()
    assert cache.state == "ready" and src.acloses == 2
    closes = [r for r in caplog.records if "close failed" in str(r.exc_info and r.exc_info[1])]
    assert [r.levelno for r in closes] == [logging.DEBUG, logging.DEBUG]
