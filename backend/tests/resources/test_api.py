import httpx
import pytest
import yaml

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.main import create_app
from omnikrux.resources import api as resources_api
from omnikrux.resources.kinds import object_name_problem
from tests.fakekube import EVENTS_FORBIDDEN, FORBIDDEN, kubeconfig_for
from tests.resources.test_describe_any import (
    deployment,
    endpoint_slice,
    node,
    replicaset,
    service,
)
from tests.resources.test_describe_any import pod as workload_pod

CRASHER = {
    "metadata": {
        "name": "crasher",
        "namespace": "demo",
        "uid": "u-crasher",
        "resourceVersion": "101",
        "managedFields": [{"manager": "kubectl", "operation": "Apply"}],
        "ownerReferences": [
            {
                "apiVersion": "apps/v1",
                "kind": "ReplicaSet",
                "name": "crasher-7c9",
                "controller": True,
            }
        ],
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


@pytest.mark.parametrize("params", [{}, {"expected_uid": "u-crasher"}])
async def test_describe_route_returns_describe(client, fake_api, params):
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
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/describe", params=params)
    assert r.status_code == 200
    body = r.json()
    assert body["pod"]["name"] == "crasher" and body["pod"]["status"] == "CrashLoopBackOff"
    assert body["pod"]["owner"] == {
        "kind": "ReplicaSet",
        "name": "crasher-7c9",
        "selector": None,
        "link": {"kind_key": "replicasets.apps", "namespace": "demo", "name": "crasher-7c9"},
    }
    assert body["pod"]["resource_version"] == "101"
    assert body["containers"][0]["state"] == "Waiting: CrashLoopBackOff"
    assert body["containers"][0]["env"] == [
        {
            "name": "DB_PASSWORD",
            "value": None,
            "source": "Secret db key password",
            "link": {"kind_key": "secrets", "namespace": "demo", "name": "db"},
        }
    ]
    assert [(e["reason"], e["count"]) for e in body["events"]] == [("BackOff", 5)]
    assert body["events_error"] is None
    [events_call] = [q for _, path, q in fake_api.requests if path.endswith("/events")]
    assert events_call["fieldSelector"] == "involvedObject.uid=u-crasher"


async def test_describe_expected_uid_rejects_a_replacement_before_related_reads(client, fake_api):
    http, cluster_id = client
    r = await http.get(
        f"/api/clusters/{cluster_id}/pods/demo/crasher/describe",
        params={"expected_uid": "u-original-crasher"},
    )
    assert r.status_code == 404
    assert r.json() == {"detail": "This Pod is no longer available"}
    assert [(method, path) for method, path, _ in fake_api.requests] == [
        ("GET", "/api/v1/namespaces/demo/pods/crasher"),
    ]


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


async def test_describe_survives_forbidden_events(client, fake_api):
    http, cluster_id = client
    fake_api.mode = "events_forbidden"
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/describe")
    assert r.status_code == 200
    body = r.json()
    assert body["pod"]["name"] == "crasher" and body["pod"]["status"] == "CrashLoopBackOff"
    assert body["containers"][0]["state"] == "Waiting: CrashLoopBackOff"
    assert body["events"] == []
    assert body["events_error"] == (
        f"Not allowed to list events for pod demo/crasher: {EVENTS_FORBIDDEN}"
    )


async def test_describe_hung_cluster_times_out_plainly(client, fake_api, monkeypatch):
    http, cluster_id = client
    monkeypatch.setattr(resources_api, "REQUEST_TIMEOUT", 0.2)
    fake_api.mode = "hang"
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/describe")
    assert r.status_code == 502
    assert r.json() == {
        "detail": "The cluster didn't answer while trying to describe pod demo/crasher."
    }


async def test_describe_owner_selector_from_the_owning_workload(client, fake_api):
    http, cluster_id = client
    fake_api.objects["replicasets.apps"][("demo", "crasher-7c9")] = {
        "metadata": {"name": "crasher-7c9", "namespace": "demo"},
        "spec": {"selector": {"matchLabels": {"app": "crasher", "pod-template-hash": "7c9"}}},
    }
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/describe")
    assert r.status_code == 200
    assert r.json()["pod"]["owner"] == {
        "kind": "ReplicaSet",
        "name": "crasher-7c9",
        "selector": "app=crasher,pod-template-hash=7c9",
        "link": {"kind_key": "replicasets.apps", "namespace": "demo", "name": "crasher-7c9"},
    }
    assert ("GET", "/apis/apps/v1/namespaces/demo/replicasets/crasher-7c9") in [
        (m, p) for m, p, _ in fake_api.requests
    ]


async def test_describe_owner_without_selector_is_none(client, fake_api):
    http, cluster_id = client
    # A static pod's owner is its Node: there is no workload to read.
    node_owned = {
        **CRASHER,
        "metadata": {
            **CRASHER["metadata"],
            "name": "etcd",
            "ownerReferences": [
                {
                    "apiVersion": "v1",
                    "kind": "Node",
                    "name": "kind-control-plane",
                    "controller": True,
                }
            ],
        },
    }
    fake_api.pods[("demo", "etcd")] = node_owned
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/etcd/describe")
    assert r.status_code == 200
    assert r.json()["pod"]["owner"] == {
        "kind": "Node",
        "name": "kind-control-plane",
        "selector": None,
        "link": {"kind_key": "nodes", "namespace": None, "name": "kind-control-plane"},
    }
    assert not [p for _, p, _ in fake_api.requests if p.startswith("/apis/")]


async def test_describe_survives_an_unreadable_owner(client, fake_api):
    http, cluster_id = client
    # No replicaset seeded: reading the owner answers 404, describe still answers.
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/describe")
    assert r.status_code == 200
    assert r.json()["pod"]["owner"]["selector"] is None
    fake_api.objects["replicasets.apps"][("demo", "crasher-7c9")] = {
        "spec": {"selector": {"matchExpressions": [{"key": "app", "operator": "Exists"}]}}
    }
    r = await http.get(f"/api/clusters/{cluster_id}/pods/demo/crasher/describe")
    assert r.status_code == 200
    assert r.json()["pod"]["owner"]["selector"] is None


# --- any kind: describe and YAML -----------------------------------------------------------


def resource_url(cluster_id: str, kind_key: str, name: str, what: str) -> str:
    return f"/api/clusters/{cluster_id}/resources/{kind_key}/{name}/{what}"


async def test_describe_kind_not_served_404_plain(client):
    http, cluster_id = client
    for what in ("describe", "yaml"):
        url = resource_url(cluster_id, "certificates.cert-manager.io", "web", what)
        r = await http.get(url, params={"namespace": "demo"})
        assert r.status_code == 404
        assert r.json() == {"detail": "This cluster doesn't serve certificates.cert-manager.io."}

        r = await http.get(resource_url("nope", "deployments.apps", "web", what))
        assert r.status_code == 404 and r.json() == {"detail": "Unknown cluster"}

    r = await http.get(
        resource_url(cluster_id, "deployments.apps", "ghost", "describe"),
        params={"namespace": "demo"},
    )
    assert r.status_code == 404
    assert r.json() == {
        "detail": "describe Deployment demo/ghost: not found (it may have just been deleted)."
    }


async def test_describe_namespace_must_match_the_kind(client):
    http, cluster_id = client
    r = await http.get(resource_url(cluster_id, "deployments.apps", "web", "describe"))
    assert r.status_code == 422
    assert r.json() == {"detail": "Choose the namespace of Deployment web."}
    r = await http.get(
        resource_url(cluster_id, "nodes", "kind-worker", "yaml"), params={"namespace": "demo"}
    )
    assert r.status_code == 422 and r.json() == {"detail": "Node objects have no namespace."}


def test_object_name_problem_allows_kubernetes_names_only():
    for name in ("web", "web-1.abc", "system:controller:attachdetach-controller", "a"):
        assert object_name_problem(name, "demo") is None, name
    assert object_name_problem("kind-worker", None) is None
    for name in ("web?x", "web#x", "web/x", "web%2F", ".", "..", "-web", "web ", "", "a" * 254):
        assert object_name_problem(name, "demo") is not None, name
    for namespace in ("Demo", "de mo", "de.mo", "", "-demo", "d" * 64):
        assert object_name_problem("web", namespace) is not None, namespace
    # `$` would let a trailing newline through: the name would then not be the object's.
    assert object_name_problem("web\n", "demo") is not None
    assert object_name_problem("web", "demo\n") is not None


def seed_web(fake_api) -> None:
    rs = replicaset("web-new", "u-rs2", "2", "u-web", 3)
    rs["metadata"]["labels"] = {"app": "web"}
    web = deployment()
    web["metadata"]["managedFields"] = [{"manager": "kubectl"}]
    fake_api.objects["deployments.apps"][("demo", "web")] = web
    fake_api.objects["replicasets.apps"][("demo", "web-new")] = rs
    for name, waiting in (("web-new-a", None), ("web-new-b", "CrashLoopBackOff")):
        p = workload_pod(name, "u-rs2", waiting=waiting)
        p["metadata"]["labels"] = {"app": "web"}
        fake_api.pods[("demo", name)] = p
    fake_api.events.append(
        {
            "metadata": {"name": "web.1", "namespace": "demo"},
            "type": "Normal",
            "reason": "ScalingReplicaSet",
            "message": "Scaled up replica set web-new to 3",
            "involvedObject": {"uid": "u-web"},
        }
    )


async def test_resource_describe_reads_related_through_the_cluster(client, fake_api):
    http, cluster_id = client
    seed_web(fake_api)
    r = await http.get(
        resource_url(cluster_id, "deployments.apps", "web", "describe"),
        params={"namespace": "demo"},
    )
    assert r.status_code == 200
    body = r.json()
    assert (body["kind"], body["name"], body["namespace"]) == ("Deployment", "web", "demo")
    assert [s["title"] for s in body["sections"]] == ["Replica sets", "Pods"]
    pods = body["sections"][1]
    assert [row[0]["text"] for row in pods["rows"]] == ["web-new-a", "web-new-b"]
    assert pods["rows"][0][0]["link"] == {
        "kind_key": "pods",
        "namespace": "demo",
        "name": "web-new-a",
    }
    assert [e["reason"] for e in body["events"]] == ["ScalingReplicaSet"]
    assert body["events_error"] is None and body["secret_keys"] is None

    lists = {path: q for m, path, q in fake_api.requests if m == "GET"}
    assert lists["/apis/apps/v1/namespaces/demo/replicasets"]["labelSelector"] == "app=web"
    assert lists["/api/v1/namespaces/demo/pods"]["labelSelector"] == "app=web"
    assert lists["/api/v1/namespaces/demo/events"]["fieldSelector"] == "involvedObject.uid=u-web"


async def test_resource_describe_survives_unreadable_related_and_events(client, fake_api):
    http, cluster_id = client
    seed_web(fake_api)
    fake_api.forbidden_kinds.add("pods")
    fake_api.mode = "events_forbidden"
    r = await http.get(
        resource_url(cluster_id, "deployments.apps", "web", "describe"),
        params={"namespace": "demo"},
    )
    assert r.status_code == 200
    body = r.json()
    pods = body["sections"][1]
    assert pods["rows"] == []
    assert pods["note"].startswith("Not allowed to list pods in demo:")
    assert body["events"] == []
    assert body["events_error"].startswith("Not allowed to list events for Deployment demo/web")


async def test_node_describe_reads_its_pods_and_events_cluster_wide(client, fake_api):
    http, cluster_id = client
    fake_api.objects["nodes"][("", "kind-worker")] = node()
    fake_api.pods[("demo", "web-new-a")] = workload_pod("web-new-a", "u-rs2")
    fake_api.pods[("demo", "elsewhere")] = workload_pod(
        "elsewhere", "u-rs2", node="kind-control-plane"
    )
    fake_api.events.append(
        {
            "metadata": {"name": "kind-worker.1", "namespace": "default"},
            "type": "Normal",
            "reason": "NodeReady",
            "message": "Node kind-worker status is now: NodeReady",
            "involvedObject": {"kind": "Node", "name": "kind-worker", "uid": "kind-worker"},
        }
    )
    r = await http.get(resource_url(cluster_id, "nodes", "kind-worker", "describe"))
    assert r.status_code == 200
    body = r.json()
    [pods] = [s for s in body["sections"] if s["title"] == "Pods"]
    assert [row[0]["text"] for row in pods["rows"]] == ["web-new-a"]
    # The kubelet records a node's events under the node's name as uid: both are asked for.
    assert [e["reason"] for e in body["events"]] == ["NodeReady"]
    pod_lists = [q for _, p, q in fake_api.requests if p == "/api/v1/pods"]
    assert pod_lists == [{"fieldSelector": "spec.nodeName=kind-worker"}]
    event_lists = [q["fieldSelector"] for _, p, q in fake_api.requests if p == "/api/v1/events"]
    assert sorted(event_lists) == ["involvedObject.uid=kind-worker", "involvedObject.uid=u-node"]


async def test_service_describe_reads_endpoint_slices(client, fake_api):
    http, cluster_id = client
    fake_api.objects["services"][("demo", "web")] = service()
    for name in ("web", "api"):
        key = ("demo", f"{name}-abc")
        fake_api.objects["endpointslices.discovery.k8s.io"][key] = endpoint_slice(name)
    r = await http.get(
        resource_url(cluster_id, "services", "web", "describe"), params={"namespace": "demo"}
    )
    assert r.status_code == 200
    [endpoints] = [s for s in r.json()["sections"] if s["title"] == "Endpoints"]
    assert [row[0]["text"] for row in endpoints["rows"]] == ["10.244.0.5", "10.244.0.6"]
    [query] = [
        q
        for _, p, q in fake_api.requests
        if p == "/apis/discovery.k8s.io/v1/namespaces/demo/endpointslices"
    ]
    assert query == {"labelSelector": "kubernetes.io/service-name=web"}


async def test_resource_yaml_without_managed_fields(client, fake_api):
    http, cluster_id = client
    seed_web(fake_api)
    r = await http.get(
        resource_url(cluster_id, "deployments.apps", "web", "yaml"), params={"namespace": "demo"}
    )
    assert r.status_code == 200
    text = r.json()["yaml"]
    assert "managedFields" not in text
    doc = yaml.safe_load(text)
    assert doc["metadata"]["resourceVersion"] == "9" and doc["status"]["replicas"] == 3
    assert list(doc) == ["apiVersion", "kind", "metadata", "spec", "status"]

    r = await http.get(
        resource_url(cluster_id, "pods", "crasher", "yaml"), params={"namespace": "demo"}
    )
    assert r.status_code == 200 and "managedFields" not in r.json()["yaml"]
