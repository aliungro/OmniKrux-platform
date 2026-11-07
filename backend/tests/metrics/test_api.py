"""GET /api/metrics/{kind} and the per-pod and per-node metrics routes."""

import asyncio

import httpx
import pytest
import yaml

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.main import create_app
from tests.fakekube import kubeconfig_for, serve_fake_api
from tests.metrics.test_cache import pod_metric, stamp


@pytest.fixture
async def client(fake_api, tmp_path):
    app = create_app(
        Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
    )
    async with app.router.lifespan_context(app):
        [info] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(kubeconfig_for(fake_api)), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            yield http, info.id, app


async def test_metrics_for_every_cluster(client, fake_api):
    http, cluster_id, _ = client
    fake_api.pod_metrics[("demo", "web-1")] = pod_metric()
    body = (await http.get("/api/metrics/pods")).json()
    assert body["kind"] == "pods"
    got = body["clusters"][cluster_id]
    assert got["state"] == "ok"
    assert got["items"]["demo/web-1"]["cpu_m"] == 250
    assert (await http.get("/api/metrics/widgets")).status_code == 422


async def test_slow_cluster_gets_error_the_others_answer(client, fake_api):
    http, cluster_id, app = client
    fake_api.pod_metrics[("demo", "web-1")] = pod_metric()
    async with serve_fake_api() as slow:
        slow.metrics_delay = 5
        config = kubeconfig_for(slow)
        config["contexts"][0]["name"] = config["current-context"] = "slow"
        [other] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(config), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        app.state.metrics.timeout = 0.3
        body = (await http.get("/api/metrics/pods")).json()
        assert body["clusters"][cluster_id]["state"] == "ok"
        assert body["clusters"][other.id]["state"] == "error"
        assert body["clusters"][other.id]["items"] == {}


async def test_pod_metrics_containers_with_requests_limits(client, fake_api):
    http, cluster_id, _ = client
    fake_api.pods[("demo", "web-1")] = {
        "metadata": {"name": "web-1", "namespace": "demo", "uid": "u1"},
        "spec": {
            "containers": [
                {
                    "name": "app",
                    "resources": {
                        "requests": {"cpu": "100m", "memory": "32Mi"},
                        "limits": {"cpu": "1", "memory": "128Mi"},
                    },
                },
                {"name": "side"},
            ]
        },
    }
    fake_api.pod_metrics[("demo", "web-1")] = {
        "timestamp": stamp(),
        "window": "30s",
        "containers": [
            {"name": "app", "usage": {"cpu": "250m", "memory": "64Mi"}},
            {"name": "side", "usage": {"cpu": "5m", "memory": "8Mi"}},
        ],
    }
    body = (await http.get(f"/api/clusters/{cluster_id}/pods/demo/web-1/metrics")).json()
    assert body["state"] == "ok" and body["stale"] is False and body["window_s"] == 30
    app_c, side = body["containers"]
    assert app_c == {
        "name": "app",
        "cpu_m": 250,
        "memory_b": 64 * 2**20,
        "cpu_request_m": 100,
        "cpu_limit_m": 1000,
        "memory_request_b": 32 * 2**20,
        "memory_limit_b": 128 * 2**20,
    }
    assert side["cpu_request_m"] is None and side["memory_limit_b"] is None


async def test_pod_metrics_stale_and_unavailable(client, fake_api):
    http, cluster_id, _ = client
    url = f"/api/clusters/{cluster_id}/pods/demo/web-1/metrics"
    fake_api.pod_metrics[("demo", "web-1")] = pod_metric(seconds_ago=400)
    assert (await http.get(url)).json()["stale"] is True
    fake_api.metrics_mode = "unavailable"
    body = (await http.get(url)).json()
    assert body["state"] == "unavailable" and body["containers"] == []
    assert "isn't answering" in body["message"]
    fake_api.metrics_mode = "missing"
    assert "isn't installed" in (await http.get(url)).json()["message"]
    assert (await http.get("/api/clusters/nope/pods/demo/web-1/metrics")).status_code == 404


async def test_pod_without_metrics_yet_is_not_called_not_installed(client, fake_api):
    http, cluster_id, _ = client
    body = (await http.get(f"/api/clusters/{cluster_id}/pods/demo/web-1/metrics")).json()
    assert body["state"] == "error" and body["containers"] == []
    assert "isn't installed" not in body["message"]


async def test_node_metrics_with_allocatable(client, fake_api):
    http, cluster_id, _ = client
    fake_api.objects["nodes"][("", "n1")] = {
        "metadata": {"name": "n1", "uid": "un1"},
        "status": {
            "capacity": {"cpu": "4", "memory": "8Gi"},
            "allocatable": {"cpu": "3900m", "memory": "7Gi"},
        },
    }
    fake_api.node_metrics["n1"] = {
        "timestamp": stamp(),
        "window": "30s",
        "usage": {"cpu": "500m", "memory": "2Gi"},
    }
    url = f"/api/clusters/{cluster_id}/nodes/n1/metrics"
    body = (await http.get(url)).json()
    assert body["state"] == "ok" and body["stale"] is False
    assert (body["cpu_m"], body["memory_b"]) == (500, 2 * 2**30)
    assert (body["allocatable_cpu_m"], body["allocatable_memory_b"]) == (3900, 7 * 2**30)
    assert (body["capacity_cpu_m"], body["capacity_memory_b"]) == (4000, 8 * 2**30)
    fake_api.metrics_mode = "unavailable"
    down = (await http.get(url)).json()
    assert down["state"] == "unavailable" and down["cpu_m"] is None
    assert down["allocatable_cpu_m"] == 3900


async def test_shutdown_leaves_no_fetch_running(client, fake_api):
    http, _, app = client
    fake_api.metrics_delay = 5
    task = asyncio.create_task(http.get("/api/metrics/pods"))
    await asyncio.sleep(0.2)
    assert app.state.metrics.in_flight == 1
    await app.state.metrics.close()
    assert app.state.metrics.in_flight == 0
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
