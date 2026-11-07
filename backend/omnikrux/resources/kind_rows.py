"""One row builder per curated kind. A missing field is None (the table shows "—"), never a crash.

Secrets: a Secret's row carries its type and how many keys it has. It never reads a value out of
`data` (it counts the keys) and nothing from it reaches a column. Helm releases are read from the
labels of Helm's release Secrets only; the release payload is never decoded.
"""

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from omnikrux.resources.quantity import parse_bytes, parse_cpu_m
from omnikrux.resources.rows import ResourceRow, StatusClass, base_row, parse_ts

# Kinds that objects commonly point at (owners, involved objects, scale targets) and their keys.
_KIND_KEYS = {
    ("", "Pod"): "pods",
    ("", "Node"): "nodes",
    ("", "Service"): "services",
    ("", "Namespace"): "namespaces",
    ("", "ConfigMap"): "configmaps",
    ("", "Secret"): "secrets",
    ("", "PersistentVolumeClaim"): "persistentvolumeclaims",
    ("", "PersistentVolume"): "persistentvolumes",
    ("apps", "Deployment"): "deployments.apps",
    ("apps", "StatefulSet"): "statefulsets.apps",
    ("apps", "ReplicaSet"): "replicasets.apps",
    ("apps", "DaemonSet"): "daemonsets.apps",
    ("batch", "Job"): "jobs.batch",
    ("batch", "CronJob"): "cronjobs.batch",
    ("networking.k8s.io", "Ingress"): "ingresses.networking.k8s.io",
    ("autoscaling", "HorizontalPodAutoscaler"): "horizontalpodautoscalers.autoscaling",
}


def _ts(value: Any) -> datetime | None:
    try:
        return parse_ts(value) if isinstance(value, str) and value else None
    except ValueError:
        return None


def _num(value: Any, default: int = 0) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def _status(row: ResourceRow, label: str, status_class: StatusClass) -> None:
    row.columns["status"] = label
    row.columns["status_class"] = status_class


def object_ref(
    api_version: Any, kind: Any, name: Any, namespace: str | None
) -> dict[str, Any] | None:
    """The `object` column value: where a click goes (`kind_key` is None for a kind we can't
    name) and what to show."""
    if not isinstance(kind, str) or not isinstance(name, str):
        return None
    group = api_version.split("/")[0] if isinstance(api_version, str) and "/" in api_version else ""
    return {
        "kind_key": _KIND_KEYS.get((group, kind)),
        "namespace": namespace,
        "name": name,
        "label": f"{kind}/{name}",
    }


def _conditions(obj: dict) -> dict[str, str]:
    return {
        c["type"]: c.get("status", "")
        for c in (obj.get("status") or {}).get("conditions") or []
        if isinstance(c, dict) and "type" in c
    }


def _images(containers: Any) -> list[str]:
    return [c["image"] for c in containers or [] if isinstance(c, dict) and c.get("image")]


def _pod_template(obj: dict) -> dict:
    return ((obj.get("spec") or {}).get("template") or {}).get("spec") or {}


def _desired(obj: dict) -> int:
    return _num((obj.get("spec") or {}).get("replicas"), 1)


# --- workloads -----------------------------------------------------------------------------


def deployment_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "Deployment")
    st = obj.get("status") or {}
    desired = _desired(obj)
    ready = _num(st.get("readyReplicas"))
    updated = _num(st.get("updatedReplicas"))
    available = _num(st.get("availableReplicas"))
    row.columns.update(
        ready=f"{ready}/{desired}",
        up_to_date=updated,
        available=available,
        images=_images(_pod_template(obj).get("containers")),
    )
    if desired == 0:
        _status(row, "Scaled to 0", "done")
    elif _conditions(obj).get("Available") == "False":
        _status(row, "Unavailable", "bad")
    elif updated < desired or available < desired:
        _status(row, "Updating", "warn")
    else:
        _status(row, "Available", "ok")
    return row


def statefulset_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "StatefulSet")
    st = obj.get("status") or {}
    desired = _desired(obj)
    ready = _num(st.get("readyReplicas"))
    updated = _num(st.get("updatedReplicas"))
    row.columns.update(
        ready=f"{ready}/{desired}",
        up_to_date=updated,
        images=_images(_pod_template(obj).get("containers")),
    )
    if desired == 0:
        _status(row, "Scaled to 0", "done")
    elif updated < desired:
        _status(row, "Updating", "warn")
    elif ready < desired:
        _status(row, "Not ready", "warn")
    else:
        _status(row, "Ready", "ok")
    return row


def replicaset_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "ReplicaSet")
    st = obj.get("status") or {}
    desired, ready = _desired(obj), _num(st.get("readyReplicas"))
    owners = (obj.get("metadata") or {}).get("ownerReferences") or []
    owner = next((o for o in owners if o.get("controller")), None)
    row.columns.update(
        ready=f"{ready}/{desired}",
        current=_num(st.get("replicas")),
        owner=owner
        and object_ref(
            owner.get("apiVersion"), owner.get("kind"), owner.get("name"), row.namespace
        ),
        images=_images(_pod_template(obj).get("containers")),
    )
    if desired == 0:
        _status(row, "Scaled to 0", "done")
    elif ready < desired:
        _status(row, "Not ready", "warn")
    else:
        _status(row, "Ready", "ok")
    return row


def daemonset_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "DaemonSet")
    st = obj.get("status") or {}
    selector = _pod_template(obj).get("nodeSelector") or {}
    known = isinstance(st.get("desiredNumberScheduled"), int)
    desired, ready = _num(st.get("desiredNumberScheduled")), _num(st.get("numberReady"))
    updated = _num(st.get("updatedNumberScheduled"))
    row.columns.update(
        desired=desired if known else None,
        ready=f"{ready}/{desired}" if known else None,
        up_to_date=updated if known else None,
        node_selector=",".join(f"{k}={v}" for k, v in selector.items()) or None,
    )
    if not known:  # the controller hasn't reported yet
        _status(row, "Unknown", "warn")
    elif desired == 0:  # a DaemonSet has no replicas to scale: no node matches it
        _status(row, "No nodes", "warn")
    elif updated < desired:
        _status(row, "Updating", "warn")
    elif ready < desired:
        _status(row, "Not ready", "warn")
    else:
        _status(row, "Ready", "ok")
    return row


def _duration(start: datetime | None, end: datetime | None) -> str | None:
    if start is None or end is None:
        return None
    seconds = max(0, int((end - start).total_seconds()))
    days, rest = divmod(seconds, 86400)
    hours, rest = divmod(rest, 3600)
    minutes, secs = divmod(rest, 60)
    parts = [f"{n}{u}" for n, u in ((days, "d"), (hours, "h"), (minutes, "m"), (secs, "s")) if n]
    return "".join(parts[:2]) or "0s"


def job_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "Job")
    spec, st = obj.get("spec") or {}, obj.get("status") or {}
    row.columns.update(
        completions=f"{_num(st.get('succeeded'))}/{spec['completions']}"
        if isinstance(spec.get("completions"), int)
        else f"{_num(st.get('succeeded'))}/—",
        # Only a finished job has a duration: a running one would be stale by the next render.
        duration=_duration(_ts(st.get("startTime")), _ts(st.get("completionTime"))),
    )
    conditions = _conditions(obj)
    if conditions.get("Complete") == "True":
        _status(row, "Complete", "done")
    elif conditions.get("Failed") == "True":
        _status(row, "Failed", "bad")
    elif spec.get("suspend"):
        _status(row, "Suspended", "warn")
    else:
        _status(row, "Running", "ok")
    return row


def cronjob_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "CronJob")
    spec, st = obj.get("spec") or {}, obj.get("status") or {}
    row.columns.update(
        schedule=spec.get("schedule"),
        last_run=_ts(st.get("lastScheduleTime")),
        active=len(st.get("active") or []),
    )
    if spec.get("suspend"):
        _status(row, "Suspended", "warn")
    else:
        _status(row, "Scheduled", "ok")
    return row


# --- networking ----------------------------------------------------------------------------


def _addresses(ingress: Any) -> list[str]:
    found = [i.get("ip") or i.get("hostname") for i in ingress or [] if isinstance(i, dict)]
    return [a for a in found if a]


def service_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "Service")
    spec = obj.get("spec") or {}
    external = _addresses(((obj.get("status") or {}).get("loadBalancer") or {}).get("ingress"))
    external += [str(a) for a in spec.get("externalIPs") or []]
    if spec.get("externalName"):
        external.append(spec["externalName"])
    ports = []
    for p in spec.get("ports") or []:
        if p.get("port") is None:
            continue
        port = str(p["port"])
        if p.get("nodePort"):
            port += f":{p['nodePort']}"
        ports.append(f"{port}/{p.get('protocol') or 'TCP'}")
    row.columns.update(
        type=spec.get("type") or "ClusterIP",
        cluster_ip=spec.get("clusterIP"),
        external=",".join(external) or None,
        ports=",".join(ports) or None,
    )
    return row


def ingress_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "Ingress")
    md, spec = obj.get("metadata") or {}, obj.get("spec") or {}
    hosts = [r.get("host") or "*" for r in spec.get("rules") or []]
    address = _addresses(((obj.get("status") or {}).get("loadBalancer") or {}).get("ingress"))
    row.columns.update(
        ingress_class=spec.get("ingressClassName")
        or (md.get("annotations") or {}).get("kubernetes.io/ingress.class"),
        hosts=",".join(dict.fromkeys(hosts)) or None,
        address=",".join(address) or None,
    )
    return row


# --- config and storage --------------------------------------------------------------------


def configmap_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "ConfigMap")
    row.columns["keys"] = len(obj.get("data") or {}) + len(obj.get("binaryData") or {})
    return row


def secret_row(obj: dict, cluster_id: str) -> ResourceRow:
    """Type and key count only. No value, plain or base64, is read into the row."""
    row = base_row(obj, cluster_id, "Secret")
    row.columns.update(type=obj.get("type"), keys=len(obj.get("data") or {}))
    return row


def pvc_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "PersistentVolumeClaim")
    spec, st = obj.get("spec") or {}, obj.get("status") or {}
    row.columns.update(
        volume=spec.get("volumeName"),
        capacity=(st.get("capacity") or {}).get("storage"),
        storage_class=spec.get("storageClassName"),
    )
    phase = st.get("phase")
    _status(row, phase or "Unknown", {"Bound": "ok", "Lost": "bad"}.get(phase, "warn"))
    return row


def pv_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "PersistentVolume")
    spec = obj.get("spec") or {}
    claim = spec.get("claimRef") or {}
    row.columns.update(
        claim="/".join(p for p in (claim.get("namespace"), claim.get("name")) if p) or None,
        capacity=(spec.get("capacity") or {}).get("storage"),
        reclaim=spec.get("persistentVolumeReclaimPolicy"),
        storage_class=spec.get("storageClassName"),
    )
    phase = (obj.get("status") or {}).get("phase")
    _status(
        row,
        phase or "Unknown",
        {"Bound": "ok", "Available": "ok", "Failed": "bad"}.get(phase, "warn"),
    )
    return row


# --- cluster -------------------------------------------------------------------------------

_PRESSURE = ("MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable")


def _allocatable(alloc: dict, key: str, parse: Callable[[str], int]) -> int | None:
    try:
        return parse(alloc[key])
    except (KeyError, ValueError):
        return None


def node_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "Node")
    md, spec, st = obj.get("metadata") or {}, obj.get("spec") or {}, obj.get("status") or {}
    conditions = _conditions(obj)
    pressure = [c for c in _PRESSURE if conditions.get(c) == "True"]
    roles = sorted(
        k.removeprefix("node-role.kubernetes.io/")
        for k in md.get("labels") or {}
        if k.startswith("node-role.kubernetes.io/")
    )
    taints = [t for t in spec.get("taints") or [] if isinstance(t, dict)]
    alloc = st.get("allocatable") or {}

    ready = conditions.get("Ready")
    cls: StatusClass
    if ready == "True":
        label, cls = "Ready", "warn" if pressure else "ok"
        if spec.get("unschedulable"):
            label, cls = "Ready, SchedulingDisabled", "warn"
    elif ready == "False":
        label, cls = "NotReady", "bad"
    else:
        label, cls = "Unknown", "bad"

    _status(row, label, cls)
    row.columns.update(
        roles=",".join(roles) or None,
        version=(st.get("nodeInfo") or {}).get("kubeletVersion"),
        pressure=pressure,
        taints=len(taints),
        taints_title="\n".join(
            f"{t.get('key')}{'=' + t['value'] if t.get('value') else ''}"
            f"{':' + t['effect'] if t.get('effect') else ''}"
            for t in taints
        ),
        allocatable_cpu_m=_allocatable(alloc, "cpu", parse_cpu_m),
        allocatable_memory_b=_allocatable(alloc, "memory", parse_bytes),
        allocatable_pods=_allocatable(alloc, "pods", int),
    )
    return row


def event_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "Event")
    involved = obj.get("involvedObject") or {}
    series = obj.get("series") or {}
    kind = obj.get("type")
    _status(row, kind or "Unknown", {"Warning": "warn", "Normal": "ok"}.get(kind, "warn"))
    seen = obj.get("lastTimestamp") or obj.get("eventTime") or series.get("lastObservedTime")
    row.columns.update(
        reason=obj.get("reason"),
        object=object_ref(
            involved.get("apiVersion"),
            involved.get("kind"),
            involved.get("name"),
            involved.get("namespace"),
        ),
        message=obj.get("message"),
        count=series.get("count") or obj.get("count"),
        last_seen=_ts(seen),
    )
    return row


def namespace_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "Namespace")
    phase = (obj.get("status") or {}).get("phase")
    _status(row, phase or "Unknown", {"Active": "ok"}.get(phase, "warn"))
    return row


def hpa_row(obj: dict, cluster_id: str) -> ResourceRow:
    row = base_row(obj, cluster_id, "HorizontalPodAutoscaler")
    spec, st = obj.get("spec") or {}, obj.get("status") or {}
    target = spec.get("scaleTargetRef") or {}
    high = spec.get("maxReplicas")
    row.columns.update(
        target=object_ref(
            target.get("apiVersion"), target.get("kind"), target.get("name"), row.namespace
        ),
        replicas=(
            f"{st['currentReplicas'] if isinstance(st.get('currentReplicas'), int) else '—'} "
            f"({_num(spec.get('minReplicas'), 1)}–{high if high is not None else '—'})"
        ),
    )
    return row


def helm_release_row(obj: dict, cluster_id: str) -> ResourceRow:
    """From the labels of Helm's release Secret only; `data.release` is never read."""
    row = base_row(obj, cluster_id, "HelmRelease")
    labels = row.labels
    row.name = labels.get("name") or row.name
    modified, revision, status = (
        labels.get("modifiedAt"),
        labels.get("version"),
        labels.get("status"),
    )
    try:
        updated = datetime.fromtimestamp(int(modified), UTC) if modified else None
    except (ValueError, OverflowError, OSError):
        updated = None
    row.columns.update(
        revision=int(revision) if revision and revision.isdigit() else revision, updated=updated
    )
    cls: StatusClass = {"deployed": "ok", "failed": "bad", "superseded": "done"}.get(
        status or "", "warn"
    )
    _status(row, status or "Unknown", cls)
    return row
