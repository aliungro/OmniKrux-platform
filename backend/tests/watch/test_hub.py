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
