"""MetricsCache against the fake Kubernetes API: parsing, the two failure copies, never serving
old numbers, one fetch per (cluster, kind) per TTL, and one slow cluster not holding up another."""

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from omnikrux.kube.connections import ClusterConnections
from omnikrux.metrics import cache as cache_module
from omnikrux.metrics import client as metrics_client
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


async def test_node_sizes_unreadable_quantities_are_none(fake_api):
    fake_api.objects["nodes"][("", "worker")] = {
        "metadata": {"name": "worker"},
        "status": {"allocatable": {"cpu": "junk", "memory": "8Gi"}},
    }
    fake_api.objects["nodes"][("", "empty")] = {"metadata": {"name": "empty"}}
    fake_api.objects["nodes"][("", "broken")] = {
        "metadata": {"name": "broken"},
        "status": {"allocatable": {"cpu": "1e999999999", "memory": "invalid"}},
    }
    cache = cache_for(fake_api)
    try:
        got = await cache.get("a", "pods")
        assert {name: size.model_dump() for name, size in got.nodes.items()} == {
            "worker": {"cpu_m": None, "memory_b": 8589934592},
            "empty": {"cpu_m": None, "memory_b": None},
            "broken": {"cpu_m": None, "memory_b": None},
        }
    finally:
        await cache.close()


async def test_node_metrics_do_not_list_node_sizes(fake_api):
    cache = cache_for(fake_api)
    try:
        got = await cache.get("a", "nodes")
        assert got.state == "ok" and got.nodes == {}
        assert "/api/v1/nodes" not in fake_api.paths
    finally:
        await cache.close()


async def test_node_sizes_cached_per_cluster_for_300_seconds(fake_api, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(cache_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    fake_api.objects["nodes"][("", "worker")] = {
        "metadata": {"name": "worker"},
        "status": {"allocatable": {"cpu": "4"}},
    }
    async with serve_fake_api() as other:
        other.objects["nodes"][("", "worker")] = {
            "metadata": {"name": "worker"},
            "status": {"allocatable": {"cpu": "2"}},
        }
        cache = MetricsCache(ClusterConnections(Registry(a=fake_api, b=other)), ttl=0)
        try:
            assert (await cache.get("a", "pods")).nodes["worker"].cpu_m == 4000
            fake_api.objects["nodes"][("", "worker")]["status"]["allocatable"]["cpu"] = "8"
            clock[0] += 299
            assert (await cache.get("a", "pods")).nodes["worker"].cpu_m == 4000
            assert (await cache.get("b", "pods")).nodes["worker"].cpu_m == 2000
            assert fake_api.paths.count("/api/v1/nodes") == 1
            clock[0] += 1
            assert (await cache.get("a", "pods")).nodes["worker"].cpu_m == 8000
            assert fake_api.paths.count("/api/v1/nodes") == 2
            assert other.paths.count("/api/v1/nodes") == 1
        finally:
            await cache.close()


@pytest.mark.parametrize("timeout,budget", [(0.4, 0.2), (20, 5)])
async def test_node_sizes_and_usage_fetched_concurrently(fake_api, monkeypatch, timeout, budget):
    usage_started, nodes_started = asyncio.Event(), asyncio.Event()
    call_json = metrics_client.call_json

    async def synchronized_call(api, method, path, **kwargs):
        if path == "/api/v1/nodes":
            assert kwargs["timeout"] == budget
            nodes_started.set()
            await usage_started.wait()
        else:
            usage_started.set()
            await nodes_started.wait()
        return await call_json(api, method, path, **kwargs)

    monkeypatch.setattr(metrics_client, "call_json", synchronized_call)
    fake_api.pod_metrics[("demo", "web-1")] = pod_metric()
    fake_api.objects["nodes"][("", "worker")] = {
        "metadata": {"name": "worker"},
        "status": {"allocatable": {"cpu": "4"}},
    }
    cache = cache_for(fake_api, timeout=timeout)
    try:
        got = await asyncio.wait_for(cache.get("a", "pods"), 1)
        assert got.state == "ok" and got.items
        assert got.nodes["worker"].cpu_m == 4000
    finally:
        await cache.close()


@pytest.mark.parametrize("failure", ["timeout", "exception", "forbidden"])
async def test_optional_node_failure_is_bounded_logged_safely_and_retries_next_poll(
    fake_api, monkeypatch, caplog, failure
):
    clock = [1000.0]
    monkeypatch.setattr(cache_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    calls = []
    failing = [True]
    call_json = metrics_client.call_json

    async def failing_nodes(api, method, path, **kwargs):
        if path == "/api/v1/nodes":
            calls.append(path)
            if failing[0] and failure == "timeout":
                await asyncio.Event().wait()
            if failing[0] and failure == "exception":
                raise RuntimeError("credential-sensitive details")
        return await call_json(api, method, path, **kwargs)

    monkeypatch.setattr(metrics_client, "call_json", failing_nodes)
    fake_api.forbidden_kinds.add("nodes")
    fake_api.objects["nodes"][("", "worker")] = {
        "metadata": {"name": "worker"},
        "status": {"allocatable": {"cpu": "4"}},
    }
    fake_api.pod_metrics[("demo", "web-1")] = pod_metric()
    cache = cache_for(fake_api, ttl=0, timeout=0.4)
    try:
        with caplog.at_level(logging.INFO, logger="omnikrux.metrics.cache"):
            first = await cache.get("a", "pods")
        assert first.state == "ok" and first.items["demo/web-1"].cpu_m == 250
        assert first.nodes == {}
        exception_type = {
            "timeout": "TimeoutError",
            "exception": "RuntimeError",
            "forbidden": "ApiException",
        }[failure]
        assert exception_type in caplog.text
        assert "credential-sensitive" not in caplog.text and "forbidden" not in caplog.text
        assert len(calls) == 1
        failing[0] = False
        fake_api.forbidden_kinds.clear()
        recovered = await cache.get("a", "pods")
        assert recovered.state == "ok" and recovered.nodes["worker"].cpu_m == 4000
        assert len(calls) == 2
        assert (await cache.get("a", "pods")).nodes["worker"].cpu_m == 4000
        assert len(calls) == 2
    finally:
        await cache.close()


async def test_successful_empty_node_list_is_cached(fake_api):
    cache = cache_for(fake_api, ttl=0)
    try:
        assert (await cache.get("a", "pods")).nodes == {}
        assert (await cache.get("a", "pods")).nodes == {}
        assert fake_api.paths.count("/api/v1/nodes") == 1
    finally:
        await cache.close()
