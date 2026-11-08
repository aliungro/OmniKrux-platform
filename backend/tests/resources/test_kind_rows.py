from datetime import UTC, datetime

import pytest

from omnikrux.resources import kind_rows as kr
from omnikrux.resources.kinds import HELM_RELEASES, KINDS

MD = {"uid": "u1", "name": "web", "namespace": "demo", "creationTimestamp": "2026-11-06T10:00:00Z"}


def obj(**fields):
    return {"metadata": dict(MD), **fields}


def status_of(row):
    return row.columns["status"], row.columns["status_class"]


def deployment(replicas=3, ready=3, updated=3, available=3, conditions=()):
    return obj(
        spec={"replicas": replicas, "template": {"spec": {"containers": [{"image": "nginx:1"}]}}},
        status={
            "readyReplicas": ready,
            "updatedReplicas": updated,
            "availableReplicas": available,
            "conditions": list(conditions),
        },
    )


def test_deployment_row_ready_and_status():
    row = kr.deployment_row(deployment(ready=2), "c1")
    assert row.kind == "Deployment" and row.columns["ready"] == "2/3"
    assert row.columns["up_to_date"] == 3 and row.columns["available"] == 3
    assert row.columns["images"] == ["nginx:1"]
    assert status_of(kr.deployment_row(deployment(), "c1")) == ("Available", "ok")
    assert status_of(kr.deployment_row(deployment(updated=1), "c1")) == ("Updating", "warn")
    assert status_of(kr.deployment_row(deployment(available=2), "c1")) == ("Updating", "warn")
    assert status_of(kr.deployment_row(deployment(0, 0, 0, 0), "c1")) == ("Scaled to 0", "done")
    down = deployment(available=0, conditions=[{"type": "Available", "status": "False"}])
    assert status_of(kr.deployment_row(down, "c1")) == ("Unavailable", "bad")
    assert kr.deployment_row(obj(), "c1").columns["ready"] == "0/1"


def test_statefulset_daemonset_replicaset_rows():
    sts = obj(spec={"replicas": 3}, status={"readyReplicas": 2, "updatedReplicas": 3})
    row = kr.statefulset_row(sts, "c1")
    assert row.columns["ready"] == "2/3" and status_of(row) == ("Not ready", "warn")
    sts["status"]["readyReplicas"] = 3
    assert status_of(kr.statefulset_row(sts, "c1")) == ("Ready", "ok")
    assert status_of(kr.statefulset_row(obj(spec={"replicas": 0}), "c1")) == ("Scaled to 0", "done")

    ds = obj(
        spec={"template": {"spec": {"nodeSelector": {"disk": "ssd", "zone": "a"}}}},
        status={"desiredNumberScheduled": 3, "numberReady": 3, "updatedNumberScheduled": 3},
    )
    row = kr.daemonset_row(ds, "c1")
    assert row.columns["desired"] == 3 and row.columns["ready"] == "3/3"
    assert row.columns["node_selector"] == "disk=ssd,zone=a" and status_of(row) == ("Ready", "ok")
    ds["status"]["numberReady"] = 1
    assert status_of(kr.daemonset_row(ds, "c1")) == ("Not ready", "warn")

    rs = obj(spec={"replicas": 2}, status={"readyReplicas": 2, "replicas": 2})
    rs["metadata"]["ownerReferences"] = [
        {"apiVersion": "apps/v1", "kind": "Deployment", "name": "web", "controller": True}
    ]
    row = kr.replicaset_row(rs, "c1")
    assert row.columns["owner"] == {
        "kind_key": "deployments.apps",
        "namespace": "demo",
        "name": "web",
        "label": "Deployment/web",
    }
    assert status_of(row) == ("Ready", "ok")
    assert status_of(kr.replicaset_row(obj(spec={"replicas": 0}), "c1")) == ("Scaled to 0", "done")
    assert kr.replicaset_row(obj(), "c1").columns["owner"] is None


def test_job_and_cronjob_rows():
    done = obj(
        spec={"completions": 1},
        status={
            "succeeded": 1,
            "startTime": "2026-11-06T10:00:00Z",
            "completionTime": "2026-11-06T10:03:12Z",
            "conditions": [{"type": "Complete", "status": "True"}],
        },
    )
    row = kr.job_row(done, "c1")
    assert status_of(row) == ("Complete", "done")
    assert row.columns["completions"] == "1/1" and row.columns["duration"] == "3m12s"
    failed = obj(status={"conditions": [{"type": "Failed", "status": "True"}]})
    assert status_of(kr.job_row(failed, "c1")) == ("Failed", "bad")
    assert status_of(kr.job_row(obj(spec={"suspend": True}), "c1")) == ("Suspended", "warn")
    running = kr.job_row(obj(spec={"completions": 3}, status={"succeeded": 1}), "c1")
    assert status_of(running) == ("Running", "ok")
    assert running.columns["completions"] == "1/3" and running.columns["duration"] is None

    cron = obj(
        spec={"schedule": "*/5 * * * *"},
        status={"lastScheduleTime": "2026-11-06T10:05:00Z", "active": [{"name": "j"}]},
    )
    row = kr.cronjob_row(cron, "c1")
    assert row.columns["schedule"] == "*/5 * * * *" and row.columns["active"] == 1
    assert row.columns["last_run"] == datetime(2026, 11, 6, 10, 5, tzinfo=UTC)
    assert status_of(row) == ("Scheduled", "ok")
    cron["spec"]["suspend"] = True
    assert status_of(kr.cronjob_row(cron, "c1")) == ("Suspended", "warn")
    assert kr.cronjob_row(obj(), "c1").columns["last_run"] is None


def test_service_and_ingress_rows():
    svc = obj(
        spec={
            "type": "LoadBalancer",
            "clusterIP": "10.0.0.1",
            "ports": [
                {"port": 80, "protocol": "TCP"},
                {"port": 443, "nodePort": 30443, "protocol": "TCP"},
            ],
        },
        status={"loadBalancer": {"ingress": [{"ip": "1.2.3.4"}]}},
    )
    row = kr.service_row(svc, "c1")
    assert row.columns["type"] == "LoadBalancer" and row.columns["cluster_ip"] == "10.0.0.1"
    assert row.columns["external"] == "1.2.3.4" and row.columns["ports"] == "80/TCP,443:30443/TCP"
    plain = kr.service_row(obj(spec={"clusterIP": "None"}), "c1")
    assert plain.columns["type"] == "ClusterIP" and plain.columns["external"] is None

    ing = obj(
        spec={
            "ingressClassName": "nginx",
            "rules": [{"host": "a.example.com"}, {"host": "b.example.com"}, {}],
        },
        status={"loadBalancer": {"ingress": [{"hostname": "lb.example.com"}]}},
    )
    row = kr.ingress_row(ing, "c1")
    assert row.columns["ingress_class"] == "nginx"
    assert row.columns["hosts"] == "a.example.com,b.example.com,*"
    assert row.columns["address"] == "lb.example.com"
    assert kr.ingress_row(obj(), "c1").columns["hosts"] is None


def test_configmap_row_counts_keys_only():
    row = kr.configmap_row(obj(data={"a": "x", "b": "2"}, binaryData={"c": "AAAA"}), "c1")
    assert row.columns["keys"] == 3


def test_secret_row_has_type_and_key_count_but_no_values():
    secret = obj(
        type="Opaque",
        data={"password": "czNjcjN0", "token": "dG9r"},
        stringData={"plain": "s3cr3t"},
    )
    secret["metadata"]["annotations"] = {
        "kubectl.kubernetes.io/last-applied-configuration": '{"data":{"password":"czNjcjN0"}}'
    }
    row = kr.secret_row(secret, "c1")
    assert row.columns["type"] == "Opaque" and row.columns["keys"] == 2
    dumped = row.model_dump_json()
    for leaked in ("s3cr3t", "czNjcjN0", "dG9r"):
        assert leaked not in dumped, leaked
    assert kr.secret_row(obj(), "c1").columns["keys"] == 0
    # The same through the curated spec the cache uses.
    assert "czNjcjN0" not in KINDS["secrets"].to_row(secret, "c1").model_dump_json()


def test_pvc_and_pv_rows():
    pvc = obj(
        spec={"volumeName": "pv-1", "storageClassName": "standard"},
        status={"phase": "Bound", "capacity": {"storage": "1Gi"}},
    )
    row = kr.pvc_row(pvc, "c1")
    assert status_of(row) == ("Bound", "ok")
    assert (row.columns["volume"], row.columns["capacity"]) == ("pv-1", "1Gi")
    assert row.columns["storage_class"] == "standard"
    assert status_of(kr.pvc_row(obj(status={"phase": "Pending"}), "c1")) == ("Pending", "warn")
    assert status_of(kr.pvc_row(obj(status={"phase": "Lost"}), "c1")) == ("Lost", "bad")

    pv = obj(
        spec={
            "claimRef": {"namespace": "demo", "name": "data"},
            "capacity": {"storage": "5Gi"},
            "persistentVolumeReclaimPolicy": "Delete",
            "storageClassName": "standard",
        },
        status={"phase": "Bound"},
    )
    row = kr.pv_row(pv, "c1")
    assert status_of(row) == ("Bound", "ok")
    assert row.columns["claim"] == "demo/data" and row.columns["reclaim"] == "Delete"
    assert kr.pv_row(obj(), "c1").columns["claim"] is None


def node(ready="True", unschedulable=False, pressure=(), taints=(), labels=None):
    conditions = [{"type": "Ready", "status": ready}]
    conditions += [{"type": p, "status": "True"} for p in pressure]
    n = obj(
        spec={"unschedulable": unschedulable, "taints": list(taints)},
        status={
            "conditions": conditions,
            "nodeInfo": {"kubeletVersion": "v1.31.0"},
            "allocatable": {"cpu": "4", "memory": "8Gi", "pods": "110"},
        },
    )
    n["metadata"]["labels"] = labels or {}
    return n


def test_node_row_status_roles_pressure_taints():
    labels = {"node-role.kubernetes.io/control-plane": "", "kubernetes.io/hostname": "n1"}
    taint = {"key": "dedicated", "value": "gpu", "effect": "NoSchedule"}
    row = kr.node_row(node(labels=labels, taints=[taint]), "c1")
    assert status_of(row) == ("Ready", "ok")
    assert row.columns["roles"] == "control-plane" and row.columns["version"] == "v1.31.0"
    assert row.columns["taints"] == 1 and row.columns["taints_title"] == "dedicated=gpu:NoSchedule"
    assert row.columns["pressure"] == []
    assert row.columns["allocatable_cpu_m"] == 4000
    assert row.columns["allocatable_memory_b"] == 8 * 2**30
    assert row.columns["allocatable_pods"] == 110
    disabled = kr.node_row(node(unschedulable=True), "c1")
    assert status_of(disabled) == ("Ready, SchedulingDisabled", "warn")
    pressured = kr.node_row(node(pressure=["MemoryPressure"]), "c1")
    assert status_of(pressured) == ("Ready", "warn")
    assert pressured.columns["pressure"] == ["MemoryPressure"]
    assert status_of(kr.node_row(node(ready="False"), "c1")) == ("NotReady", "bad")
    assert status_of(kr.node_row(node(ready="Unknown"), "c1")) == ("Unknown", "bad")
    bare = kr.node_row(obj(), "c1")
    assert status_of(bare) == ("Unknown", "bad") and bare.columns["allocatable_cpu_m"] is None
    assert bare.columns["roles"] is None


def test_event_row_object_link_and_count():
    event = obj(
        type="Warning",
        reason="BackOff",
        message="Back-off restarting",
        count=4,
        lastTimestamp="2026-11-06T10:05:00Z",
        involvedObject={"apiVersion": "v1", "kind": "Pod", "name": "web-1", "namespace": "demo"},
    )
    row = kr.event_row(event, "c1")
    assert status_of(row) == ("Warning", "warn")
    assert row.columns["object"] == {
        "kind_key": "pods",
        "namespace": "demo",
        "name": "web-1",
        "label": "Pod/web-1",
    }
    assert row.columns["count"] == 4 and row.columns["reason"] == "BackOff"
    assert row.columns["last_seen"] == datetime(2026, 11, 6, 10, 5, tzinfo=UTC)

    series = obj(
        type="Normal",
        eventTime="2026-11-06T10:00:00.000000Z",
        series={"count": 9, "lastObservedTime": "2026-11-06T10:09:00.000000Z"},
        involvedObject={"apiVersion": "example.dev/v1", "kind": "Widget", "name": "w"},
    )
    row = kr.event_row(series, "c1")
    assert status_of(row) == ("Normal", "ok") and row.columns["count"] == 9
    assert row.columns["last_seen"] == datetime(2026, 11, 6, 10, 0, tzinfo=UTC)
    assert row.columns["object"]["kind_key"] is None
    only_series = obj(series={"lastObservedTime": "2026-11-06T10:09:00.000000Z"})
    assert kr.event_row(only_series, "c1").columns["last_seen"].minute == 9
    assert kr.event_row(obj(), "c1").columns["object"] is None


def test_namespace_and_hpa_rows():
    assert status_of(kr.namespace_row(obj(status={"phase": "Active"}), "c1")) == ("Active", "ok")
    terminating = kr.namespace_row(obj(status={"phase": "Terminating"}), "c1")
    assert status_of(terminating) == ("Terminating", "warn")

    hpa = obj(
        spec={
            "minReplicas": 2,
            "maxReplicas": 10,
            "scaleTargetRef": {"apiVersion": "apps/v1", "kind": "Deployment", "name": "web"},
        },
        status={"currentReplicas": 3},
    )
    row = kr.hpa_row(hpa, "c1")
    assert row.columns["replicas"] == "3 (2–10)"
    assert row.columns["target"]["kind_key"] == "deployments.apps"
    assert row.columns["target"]["label"] == "Deployment/web"
    assert kr.hpa_row(obj(), "c1").columns["target"] is None


def test_helm_release_row_from_labels_only():
    release = obj(type="helm.sh/release.v1", data={"release": "H4sIAAAAAAAA-RELEASE-PAYLOAD"})
    release["metadata"].update(
        name="sh.helm.release.v1.web.v3",
        labels={
            "owner": "helm",
            "name": "web",
            "version": "3",
            "status": "deployed",
            "modifiedAt": "1762423200",
        },
    )
    row = kr.helm_release_row(release, "c1")
    assert (row.kind, row.name, row.namespace) == ("HelmRelease", "web", "demo")
    assert row.columns["revision"] == 3
    assert row.columns["updated"] == datetime.fromtimestamp(1762423200, UTC)
    assert status_of(row) == ("deployed", "ok")
    assert "RELEASE-PAYLOAD" not in row.model_dump_json()
    for status, cls in [
        ("failed", "bad"),
        ("pending-install", "warn"),
        ("pending-upgrade", "warn"),
        ("superseded", "done"),
        ("uninstalling", "warn"),
    ]:
        release["metadata"]["labels"]["status"] = status
        assert status_of(kr.helm_release_row(release, "c1")) == (status, cls)
    bare = kr.helm_release_row(obj(), "c1")
    assert status_of(bare) == ("Unknown", "warn") and bare.columns["updated"] is None
    spec = KINDS[HELM_RELEASES]
    assert (spec.plural, spec.label_selector, spec.sort) == ("secrets", "owner=helm", "recent")
    assert spec.plural_label == "Helm releases"


@pytest.mark.parametrize("key", list(KINDS))
def test_every_curated_kind_has_columns_and_a_row_builder(key):
    spec = KINDS[key]
    assert spec.key == key and spec.columns
    assert len({c.key for c in spec.columns}) == len(spec.columns)
    row = spec.to_row(obj(), "c1")
    assert row.cluster_id == "c1" and row.uid == "u1"
    if any(c.type == "status" for c in spec.columns):
        assert "status" in row.columns and "status_class" in row.columns
    # Every column but those the cache or metrics fill is a key the builder sets.
    for column in spec.columns:
        if column.type not in ("age", "cpu", "memory", "pods") and column.key not in (
            "name",
            "namespace",
        ):
            assert column.key in row.columns, (key, column.key)
    assert spec.to_row({}, "c1").name == ""  # a bare object never crashes a builder


def test_daemonset_with_no_status_is_unknown_not_finished():
    row = kr.daemonset_row(obj(), "c1")
    assert status_of(row) == ("Unknown", "warn")
    assert row.columns["desired"] is None and row.columns["ready"] is None
    none_yet = obj(status={"desiredNumberScheduled": 0, "numberReady": 0})
    assert status_of(kr.daemonset_row(none_yet, "c1")) == ("No nodes", "warn")


def test_missing_data_shows_as_missing_never_invented():
    assert kr.job_row(obj(status={"succeeded": 2}), "c1").columns["completions"] == "2/—"
    hpa = obj(spec={"minReplicas": 2, "maxReplicas": 10})
    assert kr.hpa_row(hpa, "c1").columns["replicas"] == "— (2–10)"
    svc = obj(spec={"ports": [{"protocol": "UDP"}, {"port": 53, "protocol": "UDP"}]})
    assert kr.service_row(svc, "c1").columns["ports"] == "53/UDP"
    pv = obj(spec={"claimRef": {"name": "data"}})
    assert kr.pv_row(pv, "c1").columns["claim"] == "data"
    node_taint = node(taints=[{"key": "k"}, {"key": "a", "value": "b", "effect": "NoSchedule"}])
    assert kr.node_row(node_taint, "c1").columns["taints_title"] == "k\na=b:NoSchedule"


def test_pv_row_survives_a_partial_claimref():
    both = obj(spec={"claimRef": {"namespace": "demo", "name": "data"}})
    assert kr.pv_row(both, "c1").columns["claim"] == "demo/data"
    only_ns = obj(spec={"claimRef": {"namespace": "demo"}})
    assert kr.pv_row(only_ns, "c1").columns["claim"] == "demo"
    only_name = obj(spec={"claimRef": {"name": "data"}})
    assert kr.pv_row(only_name, "c1").columns["claim"] == "data"
    assert kr.pv_row(obj(spec={"claimRef": {}}), "c1").columns["claim"] is None


@pytest.mark.parametrize(
    "build",
    [kr.secret_row, kr.configmap_row, kr.deployment_row, kr.node_row, kr.helm_release_row],
)
def test_every_row_carries_its_resource_version(build):
    """The inspector keys a row's describe (and drops a revealed Secret value) on it."""
    with_version = {"metadata": {**MD, "resourceVersion": "4242"}}
    assert build(with_version, "c1").columns["resource_version"] == "4242"
    assert build(obj(), "c1").columns["resource_version"] is None


def test_printer_rows_and_pod_rows_carry_their_resource_version():
    from omnikrux.resources.printer import PrinterColumn, printer_row_builder
    from omnikrux.resources.rows import pod_row

    with_version = {"metadata": {**MD, "resourceVersion": "7"}}
    column = PrinterColumn(name="Ready", type="string", json_path=".status.ready")
    build = printer_row_builder([column], kind="Widget")
    assert build(with_version, "c1").columns["resource_version"] == "7"
    assert pod_row(with_version, "c1").columns["resource_version"] == "7"
