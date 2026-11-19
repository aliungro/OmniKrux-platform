import asyncio
import logging

from omnikrux.resources.rows import pod_row
from omnikrux.watch.cache import WatchCache
from omnikrux.watch.source import Expired, WatchEvent
from tests.resources.test_rows import c, pod

# scripted: list results + event batches/exceptions per call
from tests.watch.fakes import FakeSource, Hold


def p(uid, name="p"):
    x = pod(statuses=[c()])
    x["metadata"].update(uid=uid, name=name)
    return x


async def drain(q, n):
    return [await asyncio.wait_for(q.get(), 1) for _ in range(n)]


async def test_snapshot_then_deltas():
    src = FakeSource(
        lists=[([p("a")], "1")],
        watches=[[WatchEvent("ADDED", p("b")), WatchEvent("DELETED", p("a"))]],
    )
    cache = WatchCache("cl", src.factory, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 5)
    assert [m["type"] for m in msgs] == [
        "cluster_status",
        "cluster_status",
        "snapshot",
        "upsert",
        "delete",
    ]
    assert msgs[1]["state"] == "ready" and [r["uid"] for r in msgs[2]["rows"]] == ["a"]
    assert set(cache.rows) == {"b"}
    await cache.stop()


async def test_expired_watch_relists_and_drops_ghosts():
    src = FakeSource(lists=[([p("a"), p("b")], "1"), ([p("b")], "9")], watches=[Expired(), []])
    cache = WatchCache("cl", src.factory, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 4)
    snaps = [m for m in msgs if m["type"] == "snapshot"]
    assert [r["uid"] for r in snaps[-1]["rows"]] == ["b"] and set(cache.rows) == {"b"}
    await cache.stop()


async def test_source_failure_sets_error_and_retries():
    from omnikrux.kube.client import ClusterUnavailable

    src = FakeSource(
        factory_errors=[
            ClusterUnavailable(
                "This cluster signs in with 'kubelogin', which isn't installed in the console."
            )
        ],
        lists=[([p("a")], "1")],
        watches=[[]],
    )
    cache = WatchCache("cl", src.factory, backoff=(0,))
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
    cache = WatchCache("cl", src.factory, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = [m for m in await drain(q, 5) if m["type"] == "snapshot"]
    assert [len(m["rows"]) for m in msgs] == [500, 500, 201] and [m["last"] for m in msgs] == [
        False,
        False,
        True,
    ]
    await cache.stop()


async def test_late_subscriber_gets_status_and_full_snapshot():
    src = FakeSource(lists=[([p("a")], "1")], watches=[[]])
    cache = WatchCache("cl", src.factory, backoff=(0,))
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
    src = FakeSource(
        lists=[([p("a")], "1")], watches=[[WatchEvent("MODIFIED", p("a", name="renamed"))]]
    )
    cache = WatchCache("cl", src.factory, backoff=(0,))
    assert (cache.state, cache.message) == ("syncing", None)
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 4)
    assert msgs[0] == {
        "type": "cluster_status",
        "cluster_id": "cl",
        "state": "syncing",
        "message": None,
    }
    assert msgs[2]["part"] == 0 and msgs[2]["last"] is True and msgs[2]["cluster_id"] == "cl"
    assert isinstance(msgs[2]["rows"][0]["created_at"], str)
    assert msgs[3] == {"type": "upsert", "cluster_id": "cl", "row": msgs[3]["row"]}
    assert msgs[3]["row"]["name"] == "renamed" and cache.rows["a"]["name"] == "renamed"
    await assert_quiet(q)
    await cache.stop()


async def test_empty_cluster_sends_one_empty_last_part():
    src = FakeSource(lists=[([], "1")], watches=[[]])
    cache = WatchCache("cl", src.factory, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 3)
    assert msgs[2] == {"type": "snapshot", "cluster_id": "cl", "rows": [], "part": 0, "last": True}
    await cache.stop()


async def test_expired_relist_keeps_ready_without_status_message():
    src = FakeSource(lists=[([p("a")], "1"), ([p("b")], "9")], watches=[Expired(), []])
    cache = WatchCache("cl", src.factory, backoff=(0,), min_watch_interval=0)
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
    cache = WatchCache("cl", src.factory, backoff=(0,), min_watch_interval=0)
    q = cache.subscribe()
    await cache.start()
    await drain(q, 4)
    await assert_quiet(q)
    assert src.watched_from == ["1", "7", "7"]
    await cache.stop()


async def test_generic_error_message_and_backoff_resets_after_a_watch_delivers_an_event():
    # backoff (0, 60): the first wait is 0s; a second wait of 60s would stall the test,
    # so reaching "ready" twice proves the step counter reset once the watch delivered an event.
    src = FakeSource(
        factory_errors=[RuntimeError("dns lookup failed")],
        lists=[([p("a")], "1"), ([p("a")], "2")],
        watches=[[WatchEvent("ADDED", p("b"))], RuntimeError("connection reset")],
    )
    cache = WatchCache("cl", src.factory, backoff=(0, 60), min_watch_interval=0)
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 10)
    statuses = [(m["state"], m["message"]) for m in msgs if m["type"] == "cluster_status"]
    assert statuses == [
        ("syncing", None),
        ("error", "Can't reach this cluster: dns lookup failed"),
        ("syncing", "Retrying — Can't reach this cluster: dns lookup failed"),
        ("ready", None),
        ("error", "Can't reach this cluster: connection reset"),
        ("syncing", "Retrying — Can't reach this cluster: connection reset"),
        ("ready", None),
    ]
    await cache.stop()


async def test_a_failure_to_word_the_error_still_publishes_a_safe_status():
    async def broken(exc: Exception) -> str:
        raise RuntimeError("registry offline")

    src = FakeSource(factory_errors=[RuntimeError("dial 10.20.30.40:443")] * 5)
    cache = WatchCache("cl", src.factory, backoff=(60,), describe_error=broken)
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 2)
    statuses = [(m["state"], m["message"]) for m in msgs if m["type"] == "cluster_status"]
    assert statuses == [
        ("syncing", None),
        ("error", "Can't reach this cluster. Check the cluster, then try again."),
    ]
    await cache.stop()


async def test_retry_keeps_the_last_error_visible_until_the_next_outcome():
    from omnikrux.kube.client import ClusterUnavailable

    src = FakeSource(
        factory_errors=[
            ClusterUnavailable("The cluster rejected the console's credentials: Unauthorized")
        ]
    )
    cache = WatchCache("cl", src.factory, backoff=(0, 60))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 3)
    assert [(m["state"], m["message"]) for m in msgs] == [
        ("syncing", None),
        ("error", "The cluster rejected the console's credentials: Unauthorized"),
        ("syncing", "Retrying — The cluster rejected the console's credentials: Unauthorized"),
    ]
    await asyncio.sleep(0.05)  # the retry is now blocked listing: the reason stays on the cluster
    assert (cache.state, cache.message) == (
        "syncing",
        "Retrying — The cluster rejected the console's credentials: Unauthorized",
    )
    await cache.stop()


async def test_backoff_keeps_growing_when_list_works_but_watch_fails_at_once():
    # LIST is allowed but WATCH is not: a successful list alone must not reset the backoff.
    src = FakeSource(
        lists=[([p("a")], "1"), ([p("a")], "2"), ([p("a")], "3")],
        watches=[RuntimeError("watch forbidden"), RuntimeError("watch forbidden")],
    )
    cache = WatchCache("cl", src.factory, backoff=(0, 60), min_watch_interval=0)
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 8)
    assert [m.get("state") for m in msgs] == [
        "syncing",
        "ready",
        None,
        "error",
        "syncing",
        "ready",
        None,
        "error",
    ]
    await assert_quiet(q)  # now waiting the 60s step instead of listing again
    assert len(src.lists) == 1 and cache.state == "error"
    await cache.stop()


async def test_backoff_resets_after_the_watch_stayed_up_long_enough():
    src = FakeSource(
        factory_errors=[RuntimeError("dns lookup failed")],
        lists=[([p("a")], "1"), ([p("a")], "2")],
        watches=[Hold(0.1, RuntimeError("connection reset"))],
    )
    cache = WatchCache(
        "cl", src.factory, backoff=(0, 60), stable_seconds=0.05, min_watch_interval=0
    )
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 9)
    assert [m["state"] for m in msgs if m["type"] == "cluster_status"][-1] == "ready"
    assert len(src.lists) == 0
    await cache.stop()


async def test_watches_that_end_at_once_are_restarted_no_faster_than_the_minimum_interval():
    src = FakeSource(lists=[([p("a")], "1")], watches=[[], [], []])
    cache = WatchCache("cl", src.factory, backoff=(0,), min_watch_interval=0.2)
    await cache.start()
    await asyncio.sleep(0.5)
    await cache.stop()
    gaps = [b - a for a, b in zip(src.watch_times, src.watch_times[1:], strict=False)]
    assert len(src.watch_times) == 3 and all(g >= 0.18 for g in gaps), src.watch_times


async def test_backoff_steps_and_retry_now_skips_the_wait():
    src = FakeSource(
        factory_errors=[RuntimeError("one"), RuntimeError("two")],
        lists=[([p("a")], "1")],
        watches=[[]],
    )
    cache = WatchCache("cl", src.factory, backoff=(0, 60))
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
        to_row=to_row,
    )
    cache = WatchCache("cl", src.factory, backoff=(0,))
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
    cache = WatchCache("cl", src.factory, backoff=(0,))
    q = cache.subscribe()
    cache.unsubscribe(q)
    await cache.start()
    await asyncio.sleep(0.05)
    assert [q.get_nowait()["state"] for _ in range(q.qsize())] == ["syncing"]
    await cache.stop()


async def test_stop_before_start_and_twice_is_safe():
    cache = WatchCache("cl", FakeSource().factory, backoff=(0,))
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
    src = ClosingSource(
        lists=[([p("a")], "1"), ([p("a")], "2")], watches=[RuntimeError("connection reset")]
    )
    cache = WatchCache("cl", src.factory, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 7)
    assert [m.get("state") for m in msgs] == [
        "syncing",
        "ready",
        None,
        "error",
        "syncing",
        "ready",
        None,
    ]
    assert src.acloses == 1  # the failed attempt's source, before the factory ran again
    await cache.stop()
    assert src.acloses == 2


async def test_source_aclose_errors_are_swallowed(caplog):
    src = ClosingSource(
        lists=[([p("a")], "1"), ([p("a")], "2")],
        watches=[RuntimeError("connection reset")],
        aclose_error=RuntimeError("close failed"),
    )
    cache = WatchCache("cl", src.factory, backoff=(0,))
    q = cache.subscribe()
    with caplog.at_level(logging.DEBUG, logger="omnikrux.watch.cache"):
        await cache.start()
        await drain(q, 7)
        await cache.stop()
    assert cache.state == "ready" and src.acloses == 2
    closes = [r for r in caplog.records if "close failed" in str(r.exc_info and r.exc_info[1])]
    assert [r.levelno for r in closes] == [logging.DEBUG, logging.DEBUG]


async def test_absent_kind_sets_absent_state_with_message(monkeypatch):
    from omnikrux.resources.catalog import KindNotServed
    from omnikrux.watch import cache as cache_mod

    monkeypatch.setattr(cache_mod, "ABSENT_RECHECK_SECONDS", 60)
    key = "widgets.example.omnikrux.dev"
    src = FakeSource(
        factory_errors=[KindNotServed(key), KindNotServed(key)],
        lists=[([p("a")], "1")],
        watches=[[]],
    )
    cache = WatchCache("cl", src.factory, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 2)
    assert msgs[1] == {
        "type": "cluster_status",
        "cluster_id": "cl",
        "state": "absent",
        "message": f"This cluster doesn't serve {key}.",
    }
    assert cache.rows == {}
    await assert_quiet(q)  # waits ABSENT_RECHECK_SECONDS, not the error backoff
    await cache.retry_now()  # asks again: still absent, and says nothing new
    await assert_quiet(q)
    assert cache.state == "absent"
    late = cache.subscribe()  # a late subscriber reads absent, with no snapshot
    assert [m["state"] for m in await drain(late, 1)] == ["absent"]
    await assert_quiet(late)
    await cache.retry_now()  # now served (the CRD was installed)
    msgs = await drain(q, 3)
    assert [(m["type"], m.get("state")) for m in msgs] == [
        ("cluster_status", "syncing"),
        ("cluster_status", "ready"),
        ("snapshot", None),
    ]
    await cache.stop()


async def test_rows_come_from_the_current_sources_to_row():
    from omnikrux.resources.rows import ResourceRow

    def widget_row(obj, cluster_id):
        md = obj["metadata"]
        return ResourceRow(
            uid=md["uid"],
            cluster_id=cluster_id,
            kind="Widget",
            namespace=None,
            name=md["name"],
            created_at=None,
            columns={},
        )

    src = FakeSource(lists=[([p("a")], "1")], watches=[[]], to_row=widget_row)
    cache = WatchCache("cl", src.factory, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 3)
    assert [r["kind"] for r in msgs[2]["rows"]] == ["Widget"]
    await cache.stop()


async def test_a_kind_that_goes_absent_clears_subscribers_rows():
    # Watched and ready, then the CRD is deleted: the watch fails and the factory says absent.
    from omnikrux.resources.catalog import KindNotServed

    key = "widgets.example.omnikrux.dev"
    src = FakeSource(lists=[([p("a")], "1")], watches=[RuntimeError("the server could not find")])
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        if calls > 1:
            raise KindNotServed(key)
        return src

    cache = WatchCache("cl", factory, backoff=(0,))
    q = cache.subscribe()
    await cache.start()
    msgs = await drain(q, 7)
    assert [(m["type"], m.get("state")) for m in msgs] == [
        ("cluster_status", "syncing"),
        ("cluster_status", "ready"),
        ("snapshot", None),
        ("cluster_status", "error"),
        ("cluster_status", "syncing"),
        ("cluster_status", "absent"),
        ("snapshot", None),
    ]
    assert [r["uid"] for r in msgs[2]["rows"]] == ["a"]
    assert msgs[6]["rows"] == [] and msgs[6]["last"] is True  # never stale rows
    assert cache.rows == {}
    await cache.stop()
