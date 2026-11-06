import asyncio

import pytest

from omnikrux.watch.hub import WatchHub
from tests.watch.fakes import FakeSource
from tests.watch.test_cache import p


async def collect(sub, n):
    out = []
    async for m in sub:
        out.append(m)
        if len(out) == n:
            return out


async def test_one_bad_cluster_does_not_block_others(fake_registry_two_clusters):
    good = FakeSource(lists=[([p("a")], "1")], watches=[[]])
    bad = FakeSource(factory_errors=[RuntimeError("dial tcp: i/o timeout")] * 100)
    sources = {"good": good, "bad": bad}
    hub = WatchHub(
        fake_registry_two_clusters, lambda cid, spec: sources[cid].factory(), idle_seconds=0.1
    )
    msgs = await asyncio.wait_for(collect(await hub.subscribe("pods"), 5), 2)
    assert any(m["type"] == "snapshot" and m["cluster_id"] == "good" for m in msgs)
    assert hub.status("bad") == ("error", "Can't reach this cluster: dial tcp: i/o timeout")
    await hub.close()


async def test_caches_are_shared_and_evicted_when_idle(fake_registry_two_clusters):
    calls = {"n": 0}

    async def source_for(cid, spec):
        calls["n"] += 1
        return await FakeSource(lists=[([], "1")], watches=[[]]).factory()

    hub = WatchHub(fake_registry_two_clusters, source_for, idle_seconds=0.1)
    s1, s2 = await hub.subscribe("pods", ["good"]), await hub.subscribe("pods", ["good"])
    await asyncio.sleep(0.05)
    assert calls["n"] == 1
    await s1.close()
    await s2.close()
    await asyncio.sleep(0.3)
    assert hub.status("good") == ("unknown", None)
    await hub.close()


async def test_unknown_kind(fake_registry_two_clusters):
    hub = WatchHub(fake_registry_two_clusters, None)
    with pytest.raises(KeyError):
        await hub.subscribe("nope")


def _counting_source_for(calls):
    async def source_for(cid, spec):
        calls[cid] = calls.get(cid, 0) + 1
        return await FakeSource(lists=[([p("a")], "1")], watches=[[]]).factory()

    return source_for


async def test_resubscribe_within_grace_keeps_the_cache(fake_registry_two_clusters):
    calls = {}
    hub = WatchHub(fake_registry_two_clusters, _counting_source_for(calls), idle_seconds=0.1)
    s1 = await hub.subscribe("pods", ["good"])
    await asyncio.wait_for(collect(s1, 3), 2)
    await s1.close()
    await asyncio.sleep(0.05)
    s2 = await hub.subscribe("pods", ["good"])
    await asyncio.sleep(0.2)  # past the first eviction deadline
    assert hub.status("good") == ("ready", None) and calls == {"good": 1}
    # The surviving cache replays its state to the new subscriber.
    assert [m["type"] for m in await asyncio.wait_for(collect(s2, 2), 2)] == [
        "cluster_status",
        "snapshot",
    ]
    await hub.close()


async def test_closing_a_subscription_unsubscribes_and_ends_iteration(fake_registry_two_clusters):
    hub = WatchHub(fake_registry_two_clusters, _counting_source_for({}), idle_seconds=60)
    s1, s2 = await hub.subscribe("pods"), await hub.subscribe("pods")
    await asyncio.wait_for(collect(s1, 6), 2)
    caches = list(hub._caches.values())
    assert [len(c._subscribers) for c in caches] == [2, 2]
    await s1.close()
    assert [len(c._subscribers) for c in caches] == [1, 1]
    assert await asyncio.wait_for(collect(s1, 1), 1) is None  # iteration ends after close
    await hub.close()
    assert (
        await asyncio.wait_for(collect(s2, 1), 1) is None
    )  # hub.close() closes open subscriptions
    assert hub.status("good") == ("unknown", None)


async def test_messages_from_one_cluster_keep_their_order(fake_registry_two_clusters):
    from omnikrux.watch.source import WatchEvent

    def source(cid):
        return FakeSource(
            lists=[([p(f"{cid}0")], "1")],
            watches=[[WatchEvent("ADDED", p(f"{cid}{i}")) for i in range(1, 6)]],
        )

    sources = {cid: source(cid) for cid in ("good", "bad")}
    hub = WatchHub(fake_registry_two_clusters, lambda cid, spec: sources[cid].factory())
    msgs = await asyncio.wait_for(collect(await hub.subscribe("pods"), 16), 2)
    for cid in ("good", "bad"):
        mine = [m for m in msgs if m["cluster_id"] == cid]
        assert [m["type"] for m in mine] == ["cluster_status", "cluster_status", "snapshot"] + [
            "upsert"
        ] * 5
        assert [m["row"]["uid"] for m in mine[3:]] == [f"{cid}{i}" for i in range(1, 6)]
    await hub.close()


async def test_retry_reconnects_without_waiting_for_backoff(fake_registry_two_clusters):
    src = FakeSource(factory_errors=[RuntimeError("boom")], lists=[([p("a")], "1")], watches=[[]])
    hub = WatchHub(fake_registry_two_clusters, lambda cid, spec: src.factory())
    sub = await hub.subscribe("pods", ["good"])
    msgs = await asyncio.wait_for(collect(sub, 2), 1)
    assert msgs[1]["state"] == "error"
    await hub.retry("good")  # the first backoff step is 1s; retry skips it
    msgs = await asyncio.wait_for(collect(sub, 3), 0.5)
    assert [m["type"] for m in msgs] == ["cluster_status", "cluster_status", "snapshot"]
    assert hub.status("good") == ("ready", None)
    await hub.close()


def _drain(sub):
    """Messages already forwarded to `sub`, without waiting."""
    out = []
    while not sub._out.empty():
        out.append(sub._out.get_nowait())
    return out


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)


async def test_new_cluster_joins_live_all_scope_subscription(fake_registry_two_clusters):
    from tests.conftest import _cluster

    hub = WatchHub(fake_registry_two_clusters, _counting_source_for({}), idle_seconds=60)
    sub = await hub.subscribe("pods")
    await asyncio.wait_for(collect(sub, 6), 2)
    fake_registry_two_clusters._infos.append(_cluster("new"))
    await hub.clusters_changed()
    await hub.clusters_changed()  # already attached: nothing more
    msgs = await asyncio.wait_for(collect(sub, 3), 2)
    assert [(m["type"], m["cluster_id"]) for m in msgs] == [
        ("cluster_status", "new"),
        ("cluster_status", "new"),
        ("snapshot", "new"),
    ]
    assert len(hub._caches[("new", "pods")]._subscribers) == 1
    assert hub._refs[("new", "pods")] == 1
    await sub.close()
    assert hub._refs == {key: 0 for key in hub._caches} and set(hub._evictions) == set(hub._caches)
    await hub.close()


async def test_new_cluster_joins_a_subscription_that_started_with_none():
    from tests.conftest import FakeRegistry, _cluster

    registry = FakeRegistry([])
    hub = WatchHub(registry, _counting_source_for({}), idle_seconds=60)
    sub = await hub.subscribe("pods")
    registry._infos.append(_cluster("new"))
    await hub.clusters_changed()
    msgs = await asyncio.wait_for(collect(sub, 3), 2)
    assert [m["cluster_id"] for m in msgs] == ["new"] * 3 and msgs[-1]["type"] == "snapshot"
    await hub.close()


async def test_explicit_scope_subscription_does_not_grow(fake_registry_two_clusters):
    from tests.conftest import _cluster

    calls = {}
    hub = WatchHub(fake_registry_two_clusters, _counting_source_for(calls), idle_seconds=60)
    sub = await hub.subscribe("pods", ["good"])
    await asyncio.wait_for(collect(sub, 3), 2)
    fake_registry_two_clusters._infos.append(_cluster("new"))
    await hub.clusters_changed()
    await _settle()
    assert list(hub._caches) == [("good", "pods")] and list(sub._queues) == [("good", "pods")]
    assert _drain(sub) == [] and calls == {"good": 1}
    await hub.close()


async def test_forget_stops_cache_and_notifies(fake_registry_two_clusters):
    hub = WatchHub(fake_registry_two_clusters, _counting_source_for({}), idle_seconds=60)
    s1, s2 = await hub.subscribe("pods"), await hub.subscribe("pods")
    await asyncio.wait_for(collect(s1, 6), 2)
    await asyncio.wait_for(collect(s2, 6), 2)
    bad = hub._caches[("bad", "pods")]
    fake_registry_two_clusters._infos[:] = [
        c for c in fake_registry_two_clusters._infos if c.id != "bad"
    ]
    await hub.forget("bad")
    assert ("bad", "pods") not in hub._caches and bad._task is None and bad._subscribers == []
    assert ("bad", "pods") not in hub._refs and ("bad", "pods") not in hub._evictions
    [m1], [m2] = _drain(s1), _drain(s2)
    assert m1 == m2 == {"type": "cluster_removed", "cluster_id": "bad"} and m1 is not m2
    assert list(s1._queues) == list(s1._tasks) == [("good", "pods")]
    assert hub.status("bad") == ("unknown", None)
    await s1.close()
    await s2.close()
    assert set(hub._evictions) == {("good", "pods")}  # no eviction for the forgotten cluster
    await hub.close()


async def test_forget_unknown_or_unwatched_cluster_is_a_noop(fake_registry_two_clusters):
    hub = WatchHub(fake_registry_two_clusters, _counting_source_for({}), idle_seconds=60)
    await hub.forget("good")  # no caches yet (as at startup)
    sub = await hub.subscribe("pods", ["good"])
    await asyncio.wait_for(collect(sub, 3), 2)
    await hub.forget("nope")
    await _settle()
    assert _drain(sub) == [] and list(hub._caches) == [("good", "pods")]
    await hub.close()


async def test_forget_cancels_a_pending_eviction(fake_registry_two_clusters):
    hub = WatchHub(fake_registry_two_clusters, _counting_source_for({}), idle_seconds=60)
    sub = await hub.subscribe("pods", ["good"])
    await asyncio.wait_for(collect(sub, 3), 2)
    await sub.close()
    eviction = hub._evictions[("good", "pods")]
    cache = hub._caches[("good", "pods")]
    await hub.forget("good")
    assert eviction.cancelled() and hub._evictions == {} and hub._caches == {}
    assert hub._refs == {} and cache._task is None
    await hub.close()


async def test_clusters_changed_forgets_clusters_that_are_gone(fake_registry_two_clusters):
    hub = WatchHub(fake_registry_two_clusters, _counting_source_for({}), idle_seconds=60)
    sub = await hub.subscribe("pods")
    await asyncio.wait_for(collect(sub, 6), 2)
    fake_registry_two_clusters._infos[:] = [
        c for c in fake_registry_two_clusters._infos if c.id != "bad"
    ]
    await hub.clusters_changed()
    assert _drain(sub) == [{"type": "cluster_removed", "cluster_id": "bad"}]
    assert list(hub._caches) == [("good", "pods")]
    await hub.close()


async def test_concurrent_clusters_changed_attach_once(fake_registry_two_clusters):
    from tests.conftest import _cluster

    calls = {}
    hub = WatchHub(fake_registry_two_clusters, _counting_source_for(calls), idle_seconds=60)
    sub = await hub.subscribe("pods")
    await asyncio.wait_for(collect(sub, 6), 2)
    fake_registry_two_clusters._infos.append(_cluster("new"))
    await asyncio.gather(hub.clusters_changed(), hub.clusters_changed())
    await asyncio.wait_for(collect(sub, 3), 2)
    await _settle()
    assert _drain(sub) == [] and hub._refs[("new", "pods")] == 1 and calls["new"] == 1
    assert len(hub._caches[("new", "pods")]._subscribers) == 1
    await hub.close()


async def test_clusters_changed_skips_a_subscription_that_is_closing(fake_registry_two_clusters):
    from tests.conftest import _cluster

    hub = WatchHub(fake_registry_two_clusters, _counting_source_for({}), idle_seconds=60)
    sub = await hub.subscribe("pods")
    gate, real_list = asyncio.Event(), fake_registry_two_clusters.list

    async def slow_list():
        await gate.wait()
        return await real_list()

    fake_registry_two_clusters.list = slow_list
    fake_registry_two_clusters._infos.append(_cluster("new"))
    changed = asyncio.create_task(hub.clusters_changed())
    await _settle()  # clusters_changed is now reading the registry
    await sub.close()
    gate.set()
    await changed
    assert ("new", "pods") not in hub._caches and ("new", "pods") not in hub._refs
    await hub.close()
