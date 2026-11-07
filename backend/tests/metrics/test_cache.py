"""MetricsCache against the fake Kubernetes API: parsing, the two failure copies, never serving
old numbers, one fetch per (cluster, kind) per TTL, and one slow cluster not holding up another."""

import asyncio
from datetime import UTC, datetime, timedelta

from omnikrux.kube.connections import ClusterConnections
from omnikrux.metrics.cache import NOT_ANSWERING, NOT_INSTALLED, MetricsCache
from tests.fakekube import kubeconfig_for, serve_fake_api


class Registry:
    def __init__(self, **servers):
        self.servers = servers

    async def get_kubeconfig(self, cluster_id: str) -> dict:
        return kubeconfig_for(self.servers[cluster_id])


def stamp(seconds_ago: float = 5) -> str:
    return (datetime.now(UTC) - timedelta(seconds=seconds_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def pod_metric(cpu="250m", memory="64Mi", seconds_ago=5) -> dict:
    return {
        "timestamp": stamp(seconds_ago),
        "window": "30s",
        "containers": [{"name": "app", "usage": {"cpu": cpu, "memory": memory}}],
    }


def metric_requests(server) -> list[str]:
    return [p for _, p, _ in server.requests if p.startswith("/apis/metrics.k8s.io")]


def cache_for(server, **kwargs) -> MetricsCache:
    return MetricsCache(ClusterConnections(Registry(a=server)), **kwargs)


async def test_pod_and_node_usage_parsed(fake_api):
    fake_api.pod_metrics[("demo", "web-1")] = {
        "timestamp": stamp(),
        "window": "1m0s",
        "containers": [
            {"name": "app", "usage": {"cpu": "250m", "memory": "64Mi"}},
            {"name": "side", "usage": {"cpu": "1500000n", "memory": "1024Ki"}},
        ],
    }
    fake_api.node_metrics["kind-control-plane"] = {
        "timestamp": stamp(),
        "window": "30s",
        "usage": {"cpu": "2", "memory": "1Gi"},
    }
    cache = cache_for(fake_api)
    pods = await cache.get("a", "pods")
    nodes = await cache.get("a", "nodes")
    assert pods.state == "ok" and pods.message is None and pods.fetched_at
    usage = pods.items["demo/web-1"]
    assert (usage.cpu_m, usage.memory_b) == (252, 65 * 2**20)
    assert usage.window_s == 60 and usage.stale is False and usage.at
    node = nodes.items["kind-control-plane"]
    assert (node.cpu_m, node.memory_b, node.window_s) == (2000, 2**30, 30)
    await cache.close()


async def test_metrics_missing_says_not_installed(fake_api):
    fake_api.metrics_mode = "missing"
    cache = cache_for(fake_api)
    got = await cache.get("a", "pods")
    assert got.state == "unavailable" and got.items == {}
    assert got.message == "Metrics not available on this cluster: metrics-server isn't installed."
    assert got.message == NOT_INSTALLED
    await cache.close()


async def test_metrics_503_says_not_answering(fake_api):
    fake_api.metrics_mode = "unavailable"
    cache = cache_for(fake_api)
    got = await cache.get("a", "nodes")
    assert got.state == "unavailable" and got.items == {}
    assert got.message == (
        "Metrics not available on this cluster: metrics-server isn't answering. "
        "Check its pod in kube-system."
    )
    assert got.message == NOT_ANSWERING
    await cache.close()


async def test_other_failure_is_an_error_in_words(fake_api):
    fake_api.mode = "forbidden"
    cache = cache_for(fake_api)
    got = await cache.get("a", "pods")
    assert got.state == "error" and got.items == {} and got.fetched_at is None
    assert got.message.startswith("Not allowed to read metrics")
    await cache.close()


async def test_metrics_failure_never_returns_old_numbers(fake_api):
    fake_api.pod_metrics[("demo", "web-1")] = pod_metric()
    cache = cache_for(fake_api, ttl=0)
    assert (await cache.get("a", "pods")).items
    fake_api.metrics_mode = "unavailable"
    got = await cache.get("a", "pods")
    assert got.state == "unavailable" and got.items == {}
    fake_api.metrics_mode = "ok"
    fake_api.pod_metrics.clear()
    assert (await cache.get("a", "pods")).items == {}
    await cache.close()


async def test_failure_inside_the_ttl_is_not_masked_by_old_numbers(fake_api):
    fake_api.pod_metrics[("demo", "web-1")] = pod_metric()
    cache = cache_for(fake_api, ttl=0.05)
    assert (await cache.get("a", "pods")).items
    fake_api.metrics_mode = "unavailable"
    await asyncio.sleep(0.1)
    assert (await cache.get("a", "pods")).items == {}
    await cache.close()


async def test_stale_item_flagged(fake_api):
    fake_api.pod_metrics[("demo", "fresh")] = pod_metric(seconds_ago=10)
    fake_api.pod_metrics[("demo", "old")] = pod_metric(seconds_ago=300)
    cache = cache_for(fake_api)
    got = await cache.get("a", "pods")
    assert got.items["demo/fresh"].stale is False
    assert got.items["demo/old"].stale is True
    await cache.close()


async def test_shared_cache_one_fetch_per_ttl(fake_api):
    fake_api.pod_metrics[("demo", "web-1")] = pod_metric()
    fake_api.metrics_delay = 0.2
    cache = cache_for(fake_api, ttl=30)
    first, second = await asyncio.gather(cache.get("a", "pods"), cache.get("a", "pods"))
    assert first == second and first.items
    assert await cache.get("a", "pods") == first
    assert metric_requests(fake_api) == ["/apis/metrics.k8s.io/v1beta1/pods"]
    await cache.get("a", "nodes")  # another kind is its own fetch
    assert len(metric_requests(fake_api)) == 2
    await cache.close()


async def test_answer_older_than_ttl_is_fetched_again(fake_api):
    cache = cache_for(fake_api, ttl=0.05)
    await cache.get("a", "pods")
    await asyncio.sleep(0.1)
    await cache.get("a", "pods")
    assert len(metric_requests(fake_api)) == 2
    await cache.close()


async def test_caller_cancelling_does_not_cancel_the_shared_fetch(fake_api):
    fake_api.pod_metrics[("demo", "web-1")] = pod_metric()
    fake_api.metrics_delay = 0.3
    cache = cache_for(fake_api, ttl=30)
    first = asyncio.create_task(cache.get("a", "pods"))
    await asyncio.sleep(0.05)
    second = asyncio.create_task(cache.get("a", "pods"))
    await asyncio.sleep(0.05)
    first.cancel()
    got = await second
    assert got.state == "ok" and got.items
    assert len(metric_requests(fake_api)) == 1
    await cache.close()


async def test_one_cluster_failing_does_not_block_others(fake_api):
    async with serve_fake_api() as slow:
        slow.metrics_delay = 5
        fake_api.pod_metrics[("demo", "web-1")] = pod_metric()
        cache = MetricsCache(
            ClusterConnections(Registry(a=fake_api, slow=slow)), ttl=30, timeout=0.3
        )
        loop = asyncio.get_running_loop()
        started = loop.time()
        good, bad = await asyncio.gather(cache.get("a", "pods"), cache.get("slow", "pods"))
        assert loop.time() - started < 2
        assert good.state == "ok" and good.items
        assert bad.state == "error" and bad.items == {}
        assert "didn't answer" in bad.message
        await cache.close()


async def test_unknown_cluster_is_an_error_not_a_crash(fake_api):
    cache = cache_for(fake_api)
    got = await cache.get("gone", "pods")
    assert got.state == "error" and got.items == {}
    assert got.message == "Couldn't read metrics: that cluster isn't registered any more."
    await cache.close()


async def test_malformed_items_are_skipped_not_fatal(fake_api):
    fake_api.pod_metrics[("demo", "web-1")] = pod_metric()
    fake_api.pod_metrics[("demo", "")] = pod_metric()
    cache = cache_for(fake_api)
    got = await cache.get("a", "pods")
    assert got.state == "ok" and list(got.items) == ["demo/web-1"]
    await cache.close()


async def test_cached_failure_issues_one_request_within_ttl(fake_api):
    fake_api.metrics_mode = "unavailable"
    cache = cache_for(fake_api, ttl=30)
    first = await cache.get("a", "pods")
    second = await cache.get("a", "pods")
    assert first == second and first.state == "unavailable"
    assert len(metric_requests(fake_api)) == 1
    await cache.close()


async def test_close_leaves_no_task_behind(fake_api):
    fake_api.metrics_delay = 5
    cache = cache_for(fake_api, ttl=30, timeout=10)
    waiter = asyncio.create_task(cache.get("a", "pods"))
    await asyncio.sleep(0.1)
    assert cache.in_flight == 1
    await cache.close()
    waiter.cancel()
    await asyncio.gather(waiter, return_exceptions=True)
    assert cache.in_flight == 0
