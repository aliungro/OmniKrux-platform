import httpx
import pytest
import yaml

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.main import create_app
from omnikrux.resources import api as resources_api
from tests.fakekube import FORBIDDEN, kubeconfig_for

CRASHER = {
    "metadata": {
        "name": "crasher",
        "namespace": "demo",
        "uid": "u-crasher",
        "resourceVersion": "101",
        "managedFields": [{"manager": "kubectl", "operation": "Apply"}],
        "ownerReferences": [{"kind": "ReplicaSet", "name": "crasher-7c9", "controller": True}],
    },
    "spec": {
        "nodeName": "kind-control-plane",
        "containers": [
            {
                "name": "app",
                "image": "busybox:1.36",
                "env": [
                    {
                        "name": "DB_PASSWORD",
                        "valueFrom": {"secretKeyRef": {"name": "db", "key": "password"}},
                    }
                ],
            }
        ],
    },
    "status": {
        "phase": "Running",
        "containerStatuses": [
            {
                "name": "app",
                "ready": False,
                "restartCount": 3,
                "state": {"waiting": {"reason": "CrashLoopBackOff"}},
            }
        ],
    },
}


@pytest.fixture
async def client(fake_api, tmp_path):
    """The real app and registry, with one uploaded cluster pointing at the fake API."""
    app = create_app(
        Settings(data_dir=tmp_path, kubeconfig="", in_container=False, rewrite_loopback=False)
    )
    async with app.router.lifespan_context(app):
        [info] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(kubeconfig_for(fake_api)), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        fake_api.pods[("demo", "crasher")] = CRASHER
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as http:
            yield http, info.id


async def test_describe_route_returns_describe(client, fake_api):
    http, cluster_id = client
    fake_api.events.extend(
        [
            {
                "type": "Warning",
                "reason": "BackOff",
                "message": "Back-off restarting failed container",
                "count": 5,
                "involvedObject": {"uid": "u-crasher"},
            },
            {"type": "Normal", "reason": "Other", "involvedObject": {"uid": "someone-else"}},
        ]
    )
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/describe")
    assert r.status_code == 200
    body = r.json()
    assert body["pod"]["name"] == "crasher" and body["pod"]["status"] == "CrashLoopBackOff"
    assert body["pod"]["owner"] == {"kind": "ReplicaSet", "name": "crasher-7c9"}
    assert body["pod"]["resource_version"] == "101"
    assert body["containers"][0]["state"] == "Waiting: CrashLoopBackOff"
    assert body["containers"][0]["env"] == [
        {"name": "DB_PASSWORD", "value": None, "source": "Secret db key password"}
    ]
    assert [(e["reason"], e["count"]) for e in body["events"]] == [("BackOff", 5)]
    [events_call] = [q for _, path, q in fake_api.requests if path.endswith("/events")]
    assert events_call["fieldSelector"] == "involvedObject.uid=u-crasher"


async def test_yaml_strips_managed_fields(client):
    http, cluster_id = client
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/yaml")
    assert r.status_code == 200
    text = r.json()["yaml"]
    assert "managedFields" not in text
    doc = yaml.safe_load(text)
    assert doc["metadata"]["name"] == "crasher" and doc["metadata"]["resourceVersion"] == "101"
    assert list(doc) == ["metadata", "spec", "status"]  # the API's order, not sorted


async def test_describe_unknown_pod_404_plain(client):
    http, cluster_id = client
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/missing/describe")
    assert r.status_code == 404
    assert r.json() == {
        "detail": "describe pod demo/missing: not found (it may have just been deleted)."
    }
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/missing/yaml")
    assert r.status_code == 404
    assert r.json()["detail"].startswith("read pod demo/missing as YAML: not found")

    r = await http.get("/api/clusters/nope/pods/demo/crasher/describe")
    assert r.status_code == 404 and r.json() == {"detail": "Unknown cluster"}


async def test_describe_forbidden_plain_message(client, fake_api):
    http, cluster_id = client
    fake_api.mode = "forbidden"
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/describe")
    assert r.status_code == 502
    assert r.json() == {"detail": f"Not allowed to describe pod demo/crasher: {FORBIDDEN}"}
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/yaml")
    assert r.status_code == 502
    assert r.json() == {"detail": f"Not allowed to read pod demo/crasher as YAML: {FORBIDDEN}"}


async def test_describe_hung_cluster_times_out_plainly(client, fake_api, monkeypatch):
    http, cluster_id = client
    monkeypatch.setattr(resources_api, "REQUEST_TIMEOUT", 0.2)
    fake_api.mode = "hang"
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/describe")
    assert r.status_code == 502
    assert r.json() == {
        "detail": "The cluster didn't answer while trying to describe pod demo/crasher."
    }
