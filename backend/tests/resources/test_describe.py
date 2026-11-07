import json

from omnikrux.resources.describe import describe_pod


def oom_pod() -> dict:
    return {
        "metadata": {
            "name": "oom",
            "namespace": "demo",
            "uid": "u-oom",
            "resourceVersion": "77",
            "labels": {"app": "oom"},
            "annotations": {"note": "x"},
            "ownerReferences": [
                {"kind": "Node", "name": "not-the-controller"},
                {"kind": "ReplicaSet", "name": "oom-5d4f", "controller": True},
            ],
        },
        "spec": {
            "nodeName": "kind-control-plane",
            "serviceAccountName": "default",
            "containers": [
                {
                    "name": "app",
                    "image": "busybox:1.36",
                    "resources": {
                        "requests": {"memory": "16Mi", "cpu": "10m"},
                        "limits": {"memory": "32Mi"},
                    },
                    "ports": [{"containerPort": 8080}, {"containerPort": 53, "protocol": "UDP"}],
                    "livenessProbe": {"httpGet": {"path": "/healthz", "port": 8080}},
                    "readinessProbe": {"tcpSocket": {"port": 8080}, "periodSeconds": 5},
                    "startupProbe": {"exec": {"command": ["cat", "/tmp/ready"]}},
                    "volumeMounts": [
                        {"name": "data", "mountPath": "/data"},
                        {"name": "token", "mountPath": "/var/run/token", "readOnly": True},
                    ],
                }
            ],
        },
        "status": {
            "phase": "Running",
            "podIP": "10.244.0.7",
            "hostIP": "172.18.0.2",
            "qosClass": "Burstable",
            "startTime": "2026-11-06T10:00:00Z",
            "conditions": [
                {"type": "Ready", "status": "False", "reason": "ContainersNotReady"},
                {"type": "PodScheduled", "status": "True"},
            ],
            "containerStatuses": [
                {
                    "name": "app",
                    "ready": False,
                    "restartCount": 4,
                    "state": {"waiting": {"reason": "CrashLoopBackOff"}},
                    "lastState": {
                        "terminated": {
                            "reason": "OOMKilled",
                            "exitCode": 137,
                            "finishedAt": "2026-11-06T10:05:00Z",
                        }
                    },
                }
            ],
        },
    }


def test_oomkilled_last_state_and_limit_hit():
    d = describe_pod(oom_pod(), [])
    [c] = d.containers
    assert c.last_state == "Terminated: OOMKilled (exit 137)"
    assert c.last_finished_at == "2026-11-06T10:05:00Z"
    assert c.limit_hit == ["memory"]
    assert c.requests == {"memory": "16Mi", "cpu": "10m"} and c.limits == {"memory": "32Mi"}
    assert c.restarts == 4 and c.ready is False and c.image == "busybox:1.36"
    assert c.ports == ["8080/TCP", "53/UDP"]
    assert c.probes == {
        "liveness": "GET :8080/healthz every 10s",
        "readiness": "TCP :8080 every 5s",
        "startup": "exec cat /tmp/ready every 10s",
    }
    assert c.mounts == ["/data from data", "/var/run/token from token (ro)"]
    p = d.pod
    assert (p.name, p.namespace, p.status, p.status_class) == (
        "oom",
        "demo",
        "CrashLoopBackOff",
        "bad",
    )
    assert (p.node, p.pod_ip, p.host_ip, p.qos, p.service_account) == (
        "kind-control-plane",
        "10.244.0.7",
        "172.18.0.2",
        "Burstable",
        "default",
    )
    assert p.owner is not None and (p.owner.kind, p.owner.name) == ("ReplicaSet", "oom-5d4f")
    assert p.started_at == "2026-11-06T10:00:00Z" and p.resource_version == "77"
    assert [(x.type, x.status, x.reason) for x in d.conditions] == [
        ("Ready", "False", "ContainersNotReady"),
        ("PodScheduled", "True", None),
    ]
    assert d.labels == {"app": "oom"} and d.annotations == {"note": "x"}


def test_waiting_crashloop_state_text():
    [c] = describe_pod(oom_pod(), []).containers
    assert (c.state, c.state_class) == ("Waiting: CrashLoopBackOff", "bad")

    pod = oom_pod()
    status = pod["status"]["containerStatuses"][0]
    status["state"] = {"running": {"startedAt": "2026-11-06T10:06:00Z"}}
    status["ready"] = True
    [c] = describe_pod(pod, []).containers
    assert (c.state, c.state_class) == ("Running", "ok")

    status["state"] = {"terminated": {"reason": "Error", "exitCode": 1}}
    [c] = describe_pod(pod, []).containers
    assert (c.state, c.state_class) == ("Terminated: Error (exit 1)", "bad")

    status["state"] = {"waiting": {"reason": "ContainerCreating"}}
    [c] = describe_pod(pod, []).containers
    assert (c.state, c.state_class) == ("Waiting: ContainerCreating", "warn")


def test_secret_env_value_never_included():
    pod = oom_pod()
    pod["spec"]["containers"][0]["env"] = [
        {"name": "MODE", "value": "fast"},
        {
            "name": "DB_PASSWORD",
            "valueFrom": {"secretKeyRef": {"name": "db", "key": "password"}},
        },
        {
            "name": "LEVEL",
            "valueFrom": {"configMapKeyRef": {"name": "payments-config", "key": "level"}},
        },
        {"name": "NODE", "valueFrom": {"fieldRef": {"fieldPath": "spec.nodeName"}}},
        {"name": "MEM", "valueFrom": {"resourceFieldRef": {"resource": "limits.memory"}}},
    ]
    pod["spec"]["containers"][0]["envFrom"] = [
        {"secretRef": {"name": "api-keys"}},
        {"configMapRef": {"name": "settings"}},
    ]
    # Even if a (malformed) secret reference also carried a literal value, it must not leak.
    pod["spec"]["containers"][0]["env"][1]["value"] = "hunter2"
    [c] = describe_pod(pod, []).containers
    assert [(e.name, e.value, e.source) for e in c.env] == [
        ("MODE", "fast", None),
        ("DB_PASSWORD", None, "Secret db key password"),
        ("LEVEL", None, "ConfigMap payments-config key level"),
        ("NODE", None, "Field spec.nodeName"),
        ("MEM", None, "Resource limits.memory"),
        ("(all keys)", None, "Secret api-keys"),
        ("(all keys)", None, "ConfigMap settings"),
    ]
    assert "hunter2" not in json.dumps(describe_pod(pod, []).model_dump())


def event(reason, count=None, *, type_="Warning", message="Back-off restarting", **extra):
    ev = {
        "type": type_,
        "reason": reason,
        "message": message,
        "involvedObject": {"uid": "u-oom"},
        **extra,
    }
    if count is not None:
        ev["count"] = count
    return ev


def test_events_grouped_warnings_first():
    events = [
        event("Pulled", 1, type_="Normal", message="pulled", lastTimestamp="2026-11-06T10:09:00Z"),
        event("BackOff", 20, lastTimestamp="2026-11-06T10:01:00Z"),
        event("BackOff", 30, lastTimestamp="2026-11-06T10:03:00Z"),
        event(
            "BackOff",
            series={"count": 8, "lastObservedTime": "2026-11-06T10:04:00.000000Z"},
            eventTime="2026-11-06T10:00:00.000000Z",
        ),
        event("Failed", message="other", lastTimestamp="2026-11-06T10:02:00Z"),
        event("Scheduled", type_="Normal", message="assigned", eventTime="2026-11-06T09:59:00Z"),
    ]
    out = describe_pod(oom_pod(), events).events
    assert [(e.type, e.reason, e.count, e.last_seen) for e in out] == [
        ("Warning", "BackOff", 58, "2026-11-06T10:04:00.000000Z"),
        ("Warning", "Failed", 1, "2026-11-06T10:02:00Z"),
        ("Normal", "Pulled", 1, "2026-11-06T10:09:00Z"),
        ("Normal", "Scheduled", 1, "2026-11-06T09:59:00Z"),
    ]
    assert out[0].message == "Back-off restarting"


def test_init_and_ephemeral_containers_listed():
    pod = oom_pod()
    pod["spec"]["initContainers"] = [{"name": "migrate", "image": "migrate:1"}]
    pod["spec"]["ephemeralContainers"] = [{"name": "debugger-abc", "image": "busybox:1.36"}]
    pod["status"]["initContainerStatuses"] = [
        {
            "name": "migrate",
            "ready": True,
            "restartCount": 0,
            "state": {"terminated": {"reason": "Completed", "exitCode": 0}},
        }
    ]
    pod["status"]["ephemeralContainerStatuses"] = [
        {"name": "debugger-abc", "state": {"running": {}}, "ready": False, "restartCount": 0}
    ]
    d = describe_pod(pod, [])
    assert [c.name for c in d.containers] == ["app"]
    [init] = d.init_containers
    assert (init.name, init.image, init.state, init.state_class) == (
        "migrate",
        "migrate:1",
        "Terminated: Completed (exit 0)",
        "done",
    )
    [eph] = d.ephemeral_containers
    assert (eph.name, eph.image, eph.state) == ("debugger-abc", "busybox:1.36", "Running")


def test_missing_fields_do_not_crash():
    d = describe_pod({}, [{}])
    assert d.pod.name == "" and d.pod.resource_version == ""
    assert d.pod.owner is None and d.pod.node is None and d.pod.started_at is None
    assert d.containers == d.init_containers == d.ephemeral_containers == []
    assert d.conditions == [] and d.labels == {} and d.annotations == {}
    assert [(e.type, e.reason, e.count, e.last_seen) for e in d.events] == [("Normal", "", 1, None)]

    bare = {"metadata": {"name": "p"}, "spec": {"containers": [{"name": "c"}]}, "status": None}
    [c] = describe_pod(bare, []).containers
    assert (c.name, c.image, c.state, c.ready, c.restarts) == ("c", "", "Waiting", False, 0)
    assert c.last_state is None and c.last_finished_at is None and c.limit_hit == []
    assert c.requests == c.limits == {} and c.ports == [] and c.probes == {}
    assert c.env == [] and c.mounts == []


def test_running_ephemeral_container_is_ok_though_never_ready():
    pod = oom_pod()
    pod["spec"]["ephemeralContainers"] = [{"name": "debug-abcde", "image": "busybox:1.36"}]
    pod["status"]["ephemeralContainerStatuses"] = [
        {"name": "debug-abcde", "state": {"running": {}}, "ready": False, "restartCount": 0}
    ]
    [eph] = describe_pod(pod, []).ephemeral_containers
    assert (eph.state, eph.state_class) == ("Running", "ok")


def test_terminated_without_reason_invents_none():
    pod = oom_pod()
    status = pod["status"]["containerStatuses"][0]
    status["state"] = {"terminated": {"exitCode": 2}}
    status["lastState"] = {"terminated": {"exitCode": 0}}
    [c] = describe_pod(pod, []).containers
    assert (c.state, c.state_class) == ("Terminated (exit 2)", "bad")
    assert c.last_state == "Terminated (exit 0)"

    status["state"] = {"terminated": {}}
    [c] = describe_pod(pod, []).containers
    assert c.state == "Terminated"
