"""`describe_resource`: what the inspector shows for every kind other than a pod, with links."""

import base64
import json

from omnikrux.kube.discovery import ApiResource
from omnikrux.resources.describe import Link
from omnikrux.resources.describe_any import (
    GENERIC_NOTE,
    Cell,
    SecretKey,
    Section,
    describe_resource,
)
from omnikrux.resources.kinds import HELM_RELEASES, KINDS, generic_spec


def fields(d) -> dict[str, str | None]:
    return {f.label: f.value for f in d.fields}


def section(d, title: str) -> Section:
    [found] = [s for s in d.sections if s.title == title]
    return found


def texts(s: Section) -> list[list[str | None]]:
    return [[c.text for c in row] for row in s.rows]


def owned(uid: str) -> list[dict]:
    return [{"apiVersion": "apps/v1", "kind": "ReplicaSet", "uid": uid, "controller": True}]


def pod(name: str, owner_uid: str, *, waiting: str | None = None, node: str = "kind-worker"):
    state = {"waiting": {"reason": waiting}} if waiting else {"running": {}}
    return {
        "metadata": {
            "name": name,
            "namespace": "demo",
            "uid": f"u-{name}",
            "ownerReferences": [
                {"apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "x", "uid": owner_uid}
            ]
            if owner_uid
            else [],
        },
        "spec": {"nodeName": node, "containers": [{"name": "app"}]},
        "status": {
            "phase": "Running",
            "containerStatuses": [
                {"name": "app", "ready": not waiting, "restartCount": 2, "state": state}
            ],
        },
    }


def deployment() -> dict:
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": "web",
            "namespace": "demo",
            "uid": "u-web",
            "resourceVersion": "9",
            "creationTimestamp": "2026-11-01T10:00:00Z",
            "labels": {"app": "web"},
            "annotations": {"deployment.kubernetes.io/revision": "2"},
        },
        "spec": {
            "replicas": 3,
            "selector": {"matchLabels": {"app": "web"}},
            "strategy": {
                "type": "RollingUpdate",
                "rollingUpdate": {"maxSurge": "25%", "maxUnavailable": 1},
            },
            "template": {
                "spec": {
                    "containers": [
                        {"name": "app", "image": "nginx:1.27"},
                        {"name": "sidecar", "image": "busybox:1.36"},
                    ]
                }
            },
        },
        "status": {
            "replicas": 3,
            "updatedReplicas": 3,
            "readyReplicas": 2,
            "availableReplicas": 2,
            "conditions": [
                {"type": "Available", "status": "True", "reason": "MinimumReplicasAvailable"}
            ],
        },
    }


def replicaset(name: str, uid: str, revision: str, owner_uid: str, replicas: int) -> dict:
    return {
        "metadata": {
            "name": name,
            "namespace": "demo",
            "uid": uid,
            "creationTimestamp": f"2026-11-0{revision}T10:00:00Z",
            "annotations": {"deployment.kubernetes.io/revision": revision},
            "ownerReferences": [
                {
                    "apiVersion": "apps/v1",
                    "kind": "Deployment",
                    "uid": owner_uid,
                    "controller": True,
                }
            ],
        },
        "spec": {"replicas": replicas},
        "status": {"replicas": replicas, "readyReplicas": max(replicas - 1, 0)},
    }


def test_deployment_describe_lists_replicasets_and_pods():
    related = {
        "replicasets.apps": [
            replicaset("web-old", "u-rs1", "1", "u-web", 0),
            replicaset("web-new", "u-rs2", "2", "u-web", 3),
            replicaset("someone-else", "u-rs9", "5", "u-other", 1),
        ],
        "pods": [
            pod("web-new-a", "u-rs2"),
            pod("web-new-b", "u-rs2", waiting="CrashLoopBackOff"),
            pod("stranger", "u-rs9"),
        ],
    }
    d = describe_resource(KINDS["deployments.apps"], deployment(), [], related)

    assert (d.kind_key, d.kind, d.name, d.namespace) == (
        "deployments.apps",
        "Deployment",
        "web",
        "demo",
    )
    assert (d.uid, d.resource_version, d.created_at) == ("u-web", "9", "2026-11-01T10:00:00Z")
    assert fields(d) == {
        "Replicas": "3 desired, 3 updated, 2 ready, 2 available",
        "Strategy": "RollingUpdate (max surge 25%, max unavailable 1)",
        "Selector": "app=web",
        "Images": "nginx:1.27, busybox:1.36",
    }
    rs = section(d, "Replica sets")
    assert rs.columns == ["Name", "Revision", "Ready", "Created"]
    assert texts(rs) == [
        ["web-new", "2", "2/3", "2026-11-02T10:00:00Z"],
        ["web-old", "1", "0/0", "2026-11-01T10:00:00Z"],
    ]
    assert rs.rows[0][0].link == Link(kind_key="replicasets.apps", namespace="demo", name="web-new")
    pods = section(d, "Pods")
    assert pods.columns == ["Name", "Status", "Ready", "Restarts", "Node"]
    assert texts(pods) == [
        ["web-new-a", "Running", "1/1", "2", "kind-worker"],
        ["web-new-b", "CrashLoopBackOff", "0/1", "2", "kind-worker"],
    ]
    assert [r[1].cls for r in pods.rows] == ["ok", "bad"]
    assert pods.rows[0][0].link == Link(kind_key="pods", namespace="demo", name="web-new-a")
    assert pods.rows[0][4].link == Link(kind_key="nodes", namespace=None, name="kind-worker")
    assert [c.type for c in d.conditions] == ["Available"]
    assert d.labels == {"app": "web"} and d.secret_keys is None and d.owner is None


def test_workload_pods_owned_directly_and_controller_link():
    sts = {
        "metadata": {
            "name": "db",
            "namespace": "demo",
            "uid": "u-db",
            "ownerReferences": [
                {
                    "apiVersion": "example.dev/v1",
                    "kind": "Cluster",
                    "name": "pg",
                    "controller": True,
                }
            ],
        },
        "spec": {"replicas": 2, "selector": {"matchLabels": {"app": "db"}}},
        "status": {"replicas": 2, "readyReplicas": 1, "currentReplicas": 2},
    }
    d = describe_resource(
        KINDS["statefulsets.apps"], sts, [], {"pods": [pod("db-0", "u-db"), pod("x", "u-rs2")]}
    )
    assert texts(section(d, "Pods"))[0][0] == "db-0" and len(section(d, "Pods").rows) == 1
    assert fields(d)["Replicas"] == "2 desired, 2 current, 1 ready"
    assert fields(d)["Controlled by"] == "Cluster pg"
    assert d.owner is None  # a kind Omnikrux can't name has no link

    rs = replicaset("web-new", "u-rs2", "2", "u-web", 3)
    rs["metadata"]["ownerReferences"][0]["name"] = "web"
    d = describe_resource(KINDS["replicasets.apps"], rs, [], {"pods": [pod("a", "u-rs2")]})
    assert d.owner == Link(kind_key="deployments.apps", namespace="demo", name="web")
    [controlled] = [f for f in d.fields if f.label == "Controlled by"]
    assert controlled.value == "Deployment web" and controlled.link == d.owner


def node() -> dict:
    return {
        "apiVersion": "v1",
        "kind": "Node",
        "metadata": {
            "name": "kind-worker",
            "uid": "u-node",
            "labels": {"node-role.kubernetes.io/worker": "", "kubernetes.io/os": "linux"},
        },
        "spec": {
            "unschedulable": True,
            "taints": [
                {"key": "dedicated", "value": "gpu", "effect": "NoSchedule"},
                {"key": "node.kubernetes.io/unschedulable", "effect": "NoSchedule"},
            ],
        },
        "status": {
            "addresses": [
                {"type": "InternalIP", "address": "172.18.0.3"},
                {"type": "Hostname", "address": "kind-worker"},
            ],
            "nodeInfo": {
                "osImage": "Debian GNU/Linux 12 (bookworm)",
                "kernelVersion": "6.6.87",
                "kubeletVersion": "v1.31.0",
                "containerRuntimeVersion": "containerd://1.7.18",
                "operatingSystem": "linux",
                "architecture": "amd64",
            },
            "capacity": {"cpu": "8", "memory": "16Gi", "pods": "110"},
            "allocatable": {"cpu": "7800m", "memory": "15Gi", "pods": "110"},
            "conditions": [{"type": "Ready", "status": "True", "reason": "KubeletReady"}],
        },
    }


def test_node_describe_capacity_taints_and_pods():
    other = pod("elsewhere", "u-rs2", node="kind-control-plane")
    system = pod("kube-proxy-x", "", node="kind-worker")
    system["metadata"]["namespace"] = "kube-system"
    related = {"pods": [pod("web-new-a", "u-rs2"), other, system]}
    d = describe_resource(KINDS["nodes"], node(), [], related)

    assert d.namespace is None
    assert fields(d) == {
        "Roles": "worker",
        "Addresses": "InternalIP 172.18.0.3, Hostname kind-worker",
        "OS image": "Debian GNU/Linux 12 (bookworm)",
        "Kernel": "6.6.87",
        "Kubelet": "v1.31.0",
        "Container runtime": "containerd://1.7.18",
        "Platform": "linux/amd64",
        "Scheduling": "Cordoned: new pods aren't scheduled here",
    }
    cap = section(d, "Capacity")
    assert cap.columns == ["Resource", "Capacity", "Allocatable"]
    assert texts(cap) == [["cpu", "8", "7800m"], ["memory", "16Gi", "15Gi"], ["pods", "110", "110"]]
    taints = section(d, "Taints")
    assert texts(taints) == [
        ["dedicated", "gpu", "NoSchedule"],
        ["node.kubernetes.io/unschedulable", None, "NoSchedule"],
    ]
    pods = section(d, "Pods")
    assert pods.columns == ["Name", "Namespace", "Status", "Ready", "Restarts"]
    assert texts(pods) == [
        ["web-new-a", "demo", "Running", "1/1", "2"],
        ["kube-proxy-x", "kube-system", "Running", "1/1", "2"],
    ]
    assert pods.rows[1][0].link == Link(
        kind_key="pods", namespace="kube-system", name="kube-proxy-x"
    )
    assert pods.rows[0][2].cls == "ok"
    assert [c.type for c in d.conditions] == ["Ready"]

    bare = node()
    del bare["spec"]
    d = describe_resource(KINDS["nodes"], bare, [], {"pods": []})
    assert section(d, "Taints").rows == [] and section(d, "Taints").note == "No taints."
    assert fields(d)["Scheduling"] == "Schedulable"
    assert section(d, "Pods").note == "No pods run on this node."


def service() -> dict:
    return {
        "apiVersion": "v1",
        "kind": "Service",
        "metadata": {"name": "web", "namespace": "demo", "uid": "u-svc"},
        "spec": {
            "type": "NodePort",
            "clusterIP": "10.96.0.10",
            "clusterIPs": ["10.96.0.10"],
            "selector": {"app": "web"},
            "sessionAffinity": "None",
            "ports": [
                {
                    "name": "http",
                    "port": 80,
                    "targetPort": 8080,
                    "nodePort": 30080,
                    "protocol": "TCP",
                },
                {"port": 9090, "targetPort": "metrics"},
            ],
        },
    }


def endpoint_slice(service_name: str) -> dict:
    return {
        "metadata": {
            "name": f"{service_name}-abc",
            "namespace": "demo",
            "labels": {"kubernetes.io/service-name": service_name},
        },
        "addressType": "IPv4",
        "ports": [{"name": "http", "port": 8080, "protocol": "TCP"}],
        "endpoints": [
            {
                "addresses": ["10.244.0.5"],
                "conditions": {"ready": True},
                "nodeName": "kind-worker",
                "targetRef": {"kind": "Pod", "name": "web-new-a", "namespace": "demo"},
            },
            {
                "addresses": ["10.244.0.6"],
                "conditions": {"ready": False},
                "targetRef": {"kind": "Pod", "name": "web-new-b", "namespace": "demo"},
            },
        ],
    }


def test_service_describe_ports_and_endpoints():
    related = {"endpointslices.discovery.k8s.io": [endpoint_slice("web"), endpoint_slice("api")]}
    d = describe_resource(KINDS["services"], service(), [], related)

    assert fields(d) == {
        "Type": "NodePort",
        "Cluster IPs": "10.96.0.10",
        "External": None,
        "Selector": "app=web",
        "Session affinity": "None",
    }
    ports = section(d, "Ports")
    assert ports.columns == ["Name", "Port", "Target port", "Node port", "Protocol"]
    assert texts(ports) == [
        ["http", "80", "8080", "30080", "TCP"],
        [None, "9090", "metrics", None, "TCP"],
    ]
    endpoints = section(d, "Endpoints")
    assert endpoints.columns == ["Address", "Ready", "Pod", "Node", "Ports"]
    assert texts(endpoints) == [
        ["10.244.0.5", "Ready", "web-new-a", "kind-worker", "http 8080/TCP"],
        ["10.244.0.6", "Not ready", "web-new-b", None, "http 8080/TCP"],
    ]
    assert [r[1].cls for r in endpoints.rows] == ["ok", "warn"]
    assert endpoints.rows[0][2].link == Link(kind_key="pods", namespace="demo", name="web-new-a")
    assert endpoints.rows[0][3].link == Link(kind_key="nodes", namespace=None, name="kind-worker")

    d = describe_resource(KINDS["services"], service(), [], {"endpointslices.discovery.k8s.io": []})
    assert section(d, "Endpoints").rows == [] and section(d, "Endpoints").note == "No endpoints."


def test_related_list_that_failed_is_a_note():
    d = describe_resource(
        KINDS["services"],
        service(),
        [],
        {},
        related_errors={"endpointslices.discovery.k8s.io": "Not allowed to list endpoint slices"},
    )
    endpoints = section(d, "Endpoints")
    assert endpoints.rows == [] and endpoints.note == "Not allowed to list endpoint slices"


def test_configmap_describe_shows_values():
    cm = {
        "metadata": {"name": "settings", "namespace": "demo", "uid": "u-cm"},
        "data": {"mode": "fast", "nginx.conf": "server {}\n"},
        "binaryData": {"logo.png": base64.b64encode(b"\x89PN").decode()},
    }
    d = describe_resource(KINDS["configmaps"], cm, [], {})
    data = section(d, "Data")
    assert data.columns == ["Key", "Value"]
    assert texts(data) == [
        ["mode", "fast"],
        ["nginx.conf", "server {}\n"],
        ["logo.png", "3 bytes of binary data"],
    ]
    assert d.secret_keys is None


SECRET_VALUE = "hunter2-value"
SECRET_B64 = base64.b64encode(SECRET_VALUE.encode()).decode()


def secret() -> dict:
    last_applied = json.dumps({"kind": "Secret", "data": {"password": SECRET_B64}})
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "type": "Opaque",
        "metadata": {
            "name": "db",
            "namespace": "demo",
            "uid": "u-db",
            "labels": {"owner": "helm"},
            "annotations": {
                "kubectl.kubernetes.io/last-applied-configuration": last_applied,
                "team": "data",
            },
        },
        "data": {"password": SECRET_B64, "blob": base64.b64encode(b"\x00\x01").decode()},
        "stringData": {"extra": SECRET_VALUE},
    }


def test_secret_describe_lists_keys_without_values():
    for key in ("secrets", HELM_RELEASES):  # the same Secret objects under either key
        d = describe_resource(KINDS[key], secret(), [], {})

        assert d.secret_keys == [
            SecretKey(key="blob", size=2),
            SecretKey(key="extra", size=len(SECRET_VALUE)),
            SecretKey(key="password", size=len(SECRET_VALUE)),
        ]
        assert fields(d) == {"Type": "Opaque"}
        assert d.sections == []
        assert d.annotations == {"team": "data"}  # last-applied carries the values
        body = d.model_dump_json()
        assert SECRET_VALUE not in body and SECRET_B64 not in body


def widget() -> dict:
    return {
        "apiVersion": "example.omnikrux.dev/v1",
        "kind": "Widget",
        "metadata": {
            "name": "sprocket",
            "namespace": "demo",
            "uid": "u-w",
            "resourceVersion": "5",
            "creationTimestamp": "2026-11-05T08:00:00Z",
            "finalizers": ["example.omnikrux.dev/cleanup"],
            "ownerReferences": [
                {"apiVersion": "apps/v1", "kind": "Deployment", "name": "web", "controller": True}
            ],
        },
        "spec": {"size": 3},
        "status": {
            "conditions": [
                {"type": "Ready", "status": "False", "reason": "Pending", "message": "waiting"}
            ]
        },
    }


def test_generic_describe_for_crd():
    spec = generic_spec(
        ApiResource(
            "example.omnikrux.dev", "v1", "widgets", "Widget", True, frozenset({"get"}), ()
        ),
        None,
    )
    d = describe_resource(spec, widget(), [], {})

    assert (d.kind_key, d.kind, d.name, d.namespace) == (
        "widgets.example.omnikrux.dev",
        "Widget",
        "sprocket",
        "demo",
    )
    assert d.owner == Link(kind_key="deployments.apps", namespace="demo", name="web")
    assert [(f.label, f.value, f.link) for f in d.fields] == [
        ("Controlled by", "Deployment web", d.owner),
        ("Finalizers", "example.omnikrux.dev/cleanup", None),
    ]
    assert [(c.type, c.status, c.reason, c.message) for c in d.conditions] == [
        ("Ready", "False", "Pending", "waiting")
    ]
    assert d.sections == [Section(title="Spec and status", columns=[], rows=[], note=GENERIC_NOTE)]
    assert GENERIC_NOTE == "The YAML tab shows the full object."


def test_ingress_rules_link_backend_services():
    ingress = {
        "metadata": {"name": "web", "namespace": "demo", "uid": "u-ing"},
        "spec": {
            "ingressClassName": "nginx",
            "tls": [{"hosts": ["web.example"], "secretName": "web-tls"}],
            "rules": [
                {
                    "host": "web.example",
                    "http": {
                        "paths": [
                            {
                                "path": "/",
                                "pathType": "Prefix",
                                "backend": {"service": {"name": "web", "port": {"number": 80}}},
                            },
                            {
                                "path": "/api",
                                "pathType": "Prefix",
                                "backend": {"service": {"name": "api", "port": {"name": "http"}}},
                            },
                        ]
                    },
                }
            ],
        },
        "status": {"loadBalancer": {"ingress": [{"ip": "172.18.0.10"}]}},
    }
    d = describe_resource(KINDS["ingresses.networking.k8s.io"], ingress, [], {})
    assert fields(d) == {"Class": "nginx", "Address": "172.18.0.10", "Default backend": None}
    rules = section(d, "Rules")
    assert rules.columns == ["Host", "Path", "Backend"]
    assert texts(rules) == [["web.example", "/", "web:80"], ["web.example", "/api", "api:http"]]
    assert rules.rows[1][2].link == Link(kind_key="services", namespace="demo", name="api")
    tls = section(d, "TLS")
    assert texts(tls) == [["web.example", "web-tls"]]
    assert tls.rows[0][1].link == Link(kind_key="secrets", namespace="demo", name="web-tls")


def test_pvc_links_its_volume():
    pvc = {
        "metadata": {"name": "data", "namespace": "demo", "uid": "u-pvc"},
        "spec": {
            "volumeName": "pv-123",
            "accessModes": ["ReadWriteOnce"],
            "storageClassName": "standard",
            "resources": {"requests": {"storage": "1Gi"}},
            "volumeMode": "Filesystem",
        },
        "status": {"phase": "Bound", "capacity": {"storage": "2Gi"}},
    }
    d = describe_resource(KINDS["persistentvolumeclaims"], pvc, [], {})
    assert fields(d) == {
        "Status": "Bound",
        "Volume": "pv-123",
        "Capacity": "2Gi",
        "Requested": "1Gi",
        "Access modes": "ReadWriteOnce",
        "Storage class": "standard",
        "Volume mode": "Filesystem",
    }
    [volume] = [f for f in d.fields if f.label == "Volume"]
    assert volume.link == Link(kind_key="persistentvolumes", namespace=None, name="pv-123")


def test_event_links_involved_object():
    event = {
        "metadata": {"name": "web-1.abc", "namespace": "demo", "uid": "u-ev"},
        "involvedObject": {"apiVersion": "v1", "kind": "Pod", "name": "web-1", "namespace": "demo"},
        "type": "Warning",
        "reason": "BackOff",
        "message": "Back-off restarting failed container",
        "count": 4,
        "firstTimestamp": "2026-11-07T08:00:00Z",
        "lastTimestamp": "2026-11-07T09:00:00Z",
        "source": {"component": "kubelet"},
    }
    d = describe_resource(KINDS["events"], event, [], {})
    assert fields(d) == {
        "Object": "Pod web-1",
        "Type": "Warning",
        "Reason": "BackOff",
        "Message": "Back-off restarting failed container",
        "Count": "4",
        "First seen": "2026-11-07T08:00:00Z",
        "Last seen": "2026-11-07T09:00:00Z",
        "Source": "kubelet",
    }
    assert d.fields[0].link == Link(kind_key="pods", namespace="demo", name="web-1")


def test_cells_default_without_link_or_class():
    assert Cell(text="x") == Cell(text="x", link=None, cls=None)


def test_workload_describe_carries_its_pod_selector():
    """A workload's matchLabels, for its pods' logs (the `l` key); none when it selects with
    expressions, and none for kinds that aren't workloads."""
    d = describe_resource(KINDS["deployments.apps"], deployment(), [], {})
    assert d.pod_selector == "app=web"

    by_expression = deployment()
    by_expression["spec"]["selector"] = {
        "matchLabels": {"app": "web"},
        "matchExpressions": [{"key": "tier", "operator": "In", "values": ["a"]}],
    }
    assert describe_resource(KINDS["deployments.apps"], by_expression, [], {}).pod_selector is None
    assert describe_resource(KINDS["services"], service(), [], {}).pod_selector is None
