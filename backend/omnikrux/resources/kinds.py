"""Kinds: how one kind of object is listed, watched and shown.

A kind's key is kubectl's fully qualified resource name (`pods`, `deployments.apps`,
`widgets.example.omnikrux.dev`); `helm-releases` is the one virtual key. `KINDS` holds the curated
built-in kinds; every other kind a cluster serves gets `generic_spec`.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from typing import Literal

from omnikrux.kube.discovery import ApiResource
from omnikrux.resources import kind_rows as kr
from omnikrux.resources.printer import PrinterColumn, printer_columns, printer_row_builder
from omnikrux.resources.rows import ResourceRow, base_row, pod_row

ColumnType = Literal["text", "number", "status", "age", "time", "cpu", "memory", "object", "pods"]
Width = Literal["s", "m", "l"]

HELM_RELEASES = "helm-releases"

# A DNS subdomain (RFC 1123), which every kubectl resource name is: lower case, dot-separated.
_KIND_KEY = re.compile(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*")


@dataclass(frozen=True)
class Column:
    key: str
    label: str
    type: ColumnType = "text"
    width: Width = "m"


@dataclass(frozen=True)
class KindSpec:
    key: str
    group: str
    version: str
    plural: str
    kind: str
    namespaced: bool
    label: str
    columns: tuple[Column, ...]
    to_row: Callable[[dict, str], ResourceRow]
    sort: Literal["status", "recent"] = "status"
    short_names: tuple[str, ...] = ()
    label_selector: str | None = None
    verbs: frozenset[str] = frozenset()
    # For copy such as "No deployments"; the plural resource name unless set.
    plural_label: str | None = None

    def _prefix(self) -> str:
        return f"/apis/{self.group}/{self.version}" if self.group else f"/api/{self.version}"

    def list_path(self, namespace: str | None = None) -> str:
        """The collection, cluster-wide (`/api/v1/pods`, `/apis/apps/v1/deployments`) or in one
        namespace (`/api/v1/namespaces/demo/pods`)."""
        if self.namespaced and namespace:
            return f"{self._prefix()}/namespaces/{namespace}/{self.plural}"
        return f"{self._prefix()}/{self.plural}"

    def object_path(self, namespace: str | None, name: str) -> str:
        if self.namespaced and namespace:
            return f"{self._prefix()}/namespaces/{namespace}/{self.plural}/{name}"
        return f"{self._prefix()}/{self.plural}/{name}"


def kind_key(group: str, plural: str) -> str:
    return f"{plural}.{group}" if group else plural


def target_problem(spec: KindSpec, name: str, namespace: str | None) -> str | None:
    """Why the name or namespace doesn't fit the kind (or any object), in words; None when they
    do."""
    if spec.namespaced and not namespace:
        return f"Choose the namespace of {spec.kind} {name}."
    if not spec.namespaced and namespace:
        return f"{spec.kind} objects have no namespace."
    return object_name_problem(name, namespace)


# Names are joined into API paths unencoded, so only what Kubernetes names use is let through:
# a DNS subdomain, plus upper case and ':' (RBAC names such as system:controller:...). Never
# '/', '?', '#', '%', spaces, '.' or '..'. Namespaces are DNS labels. `fullmatch`, never
# `match` with `$`, which would let a trailing newline through.
_OBJECT_NAME = re.compile(r"[A-Za-z0-9]([-A-Za-z0-9.:]*[A-Za-z0-9])?")
_NAMESPACE = re.compile(r"[a-z0-9]([-a-z0-9]*[a-z0-9])?")


def object_name_problem(name: str, namespace: str | None) -> str | None:
    """Why `name` or `namespace` can't be an object's, in words; None when both can."""
    if len(name) > 253 or not _OBJECT_NAME.fullmatch(name):
        return f"{name} isn't a valid object name: names use letters, digits, '-', '.' and ':'."
    if namespace is not None and (len(namespace) > 63 or not _NAMESPACE.fullmatch(namespace)):
        return (
            f"{namespace} isn't a valid namespace: namespaces use lower-case letters, digits "
            "and '-'."
        )
    return None


def matches_selector(spec: KindSpec, obj: dict) -> bool:
    """Whether `obj` carries the labels of the spec's equality selector (`k=v,k2=v2`), as
    helm-releases' owner=helm; True for a spec without one."""
    if not spec.label_selector:
        return True
    labels = (obj.get("metadata") or {}).get("labels") or {}
    terms = [t.partition("=") for t in spec.label_selector.split(",") if t]
    return all(labels.get(key) == value for key, _, value in terms)


def is_kind_key(key: str) -> bool:
    return key == HELM_RELEASES or (len(key) <= 253 and _KIND_KEY.fullmatch(key) is not None)


def _col(key: str, label: str, type: ColumnType = "text", width: Width = "m") -> Column:
    return Column(key, label, type, width)


NAME = _col("name", "Name", width="l")
NAMESPACE = _col("namespace", "Namespace")
AGE = _col("age", "Age", "age", "s")
STATUS = _col("status", "Status", "status")
READY = _col("ready", "Ready", width="s")
UP_TO_DATE = _col("up_to_date", "Up-to-date", "number", "s")
IMAGES = _col("images", "Images", width="l")
CPU = _col("cpu", "CPU", "cpu", "s")
MEMORY = _col("memory", "Memory", "memory", "s")
CAPACITY = _col("capacity", "Capacity", width="s")
STORAGE_CLASS = _col("storage_class", "Storage class")


def generic_row(obj: dict, cluster_id: str, *, kind: str) -> ResourceRow:
    """The row every kind can have: identity, age and labels."""
    return base_row(obj, cluster_id, kind)


# Printer columns that the Name and Age columns already show.
_DUPLICATES = {".metadata.name", ".metadata.creationTimestamp"}


def _printer_column(column: PrinterColumn) -> Column:
    if column.name in ("Ready", "Status"):
        return _col(column.key, column.name, "status", "s")
    if column.type in ("integer", "number"):
        return _col(column.key, column.name, "number", "s")
    return _col(column.key, column.name, "time" if column.type == "date" else "text")


def generic_spec(res: ApiResource, printer: list[dict] | None) -> KindSpec:
    """A spec for any served resource; a CRD's priority-0 printer columns go between Namespace
    and Age."""
    extra = [c for c in printer_columns(printer or []) if c.json_path not in _DUPLICATES]
    columns = (NAME, NAMESPACE) if res.namespaced else (NAME,)
    columns += tuple(_printer_column(c) for c in extra) + (AGE,)
    to_row = (
        printer_row_builder(extra, kind=res.kind) if extra else partial(generic_row, kind=res.kind)
    )
    return KindSpec(
        key=kind_key(res.group, res.plural),
        group=res.group,
        version=res.version,
        plural=res.plural,
        kind=res.kind,
        namespaced=res.namespaced,
        label=res.kind,
        columns=columns,
        to_row=to_row,
        short_names=res.short_names,
        verbs=res.verbs,
    )


def _core(
    plural: str,
    kind: str,
    columns: tuple[Column, ...],
    to_row: Callable[[dict, str], ResourceRow],
    *,
    group: str = "",
    version: str = "v1",
    namespaced: bool = True,
    **extra,
) -> KindSpec:
    return KindSpec(
        key=kind_key(group, plural),
        group=group,
        version=version,
        plural=plural,
        kind=kind,
        namespaced=namespaced,
        label=kind,
        columns=columns,
        to_row=to_row,
        **extra,
    )


_CURATED = (
    _core(
        "pods",
        "Pod",
        (
            NAME,
            NAMESPACE,
            STATUS,
            READY,
            _col("restarts", "Restarts", "number", "s"),
            CPU,
            MEMORY,
            _col("node", "Node"),
            AGE,
        ),
        pod_row,
        short_names=("po",),
    ),
    _core(
        "deployments",
        "Deployment",
        (
            NAME,
            NAMESPACE,
            STATUS,
            READY,
            UP_TO_DATE,
            _col("available", "Available", "number", "s"),
            IMAGES,
            AGE,
        ),
        kr.deployment_row,
        group="apps",
        short_names=("deploy",),
    ),
    _core(
        "statefulsets",
        "StatefulSet",
        (NAME, NAMESPACE, STATUS, READY, UP_TO_DATE, IMAGES, AGE),
        kr.statefulset_row,
        group="apps",
        short_names=("sts",),
    ),
    _core(
        "replicasets",
        "ReplicaSet",
        (NAME, NAMESPACE, STATUS, READY, _col("owner", "Owner", "object"), IMAGES, AGE),
        kr.replicaset_row,
        group="apps",
        short_names=("rs",),
    ),
    _core(
        "daemonsets",
        "DaemonSet",
        (
            NAME,
            NAMESPACE,
            STATUS,
            _col("desired", "Desired", "number", "s"),
            READY,
            UP_TO_DATE,
            _col("node_selector", "Node selector"),
            AGE,
        ),
        kr.daemonset_row,
        group="apps",
        short_names=("ds",),
    ),
    _core(
        "jobs",
        "Job",
        (
            NAME,
            NAMESPACE,
            STATUS,
            _col("completions", "Completions", width="s"),
            _col("duration", "Duration", width="s"),
            AGE,
        ),
        kr.job_row,
        group="batch",
    ),
    _core(
        "cronjobs",
        "CronJob",
        (
            NAME,
            NAMESPACE,
            STATUS,
            _col("schedule", "Schedule"),
            _col("last_run", "Last run", "time", "s"),
            _col("active", "Active", "number", "s"),
            AGE,
        ),
        kr.cronjob_row,
        group="batch",
        short_names=("cj",),
    ),
    _core(
        "services",
        "Service",
        (
            NAME,
            NAMESPACE,
            _col("type", "Type", width="s"),
            _col("cluster_ip", "Cluster IP"),
            _col("external", "External"),
            _col("ports", "Ports"),
            AGE,
        ),
        kr.service_row,
        short_names=("svc",),
    ),
    _core(
        "ingresses",
        "Ingress",
        (
            NAME,
            NAMESPACE,
            _col("ingress_class", "Class", width="s"),
            _col("hosts", "Hosts", width="l"),
            _col("address", "Address"),
            AGE,
        ),
        kr.ingress_row,
        group="networking.k8s.io",
        short_names=("ing",),
    ),
    _core(
        "configmaps",
        "ConfigMap",
        (NAME, NAMESPACE, _col("keys", "Keys", "number", "s"), AGE),
        kr.configmap_row,
        short_names=("cm",),
    ),
    _core(
        "secrets",
        "Secret",
        (NAME, NAMESPACE, _col("type", "Type"), _col("keys", "Keys", "number", "s"), AGE),
        kr.secret_row,
    ),
    _core(
        "persistentvolumeclaims",
        "PersistentVolumeClaim",
        (NAME, NAMESPACE, STATUS, _col("volume", "Volume"), CAPACITY, STORAGE_CLASS, AGE),
        kr.pvc_row,
        short_names=("pvc",),
    ),
    _core(
        "persistentvolumes",
        "PersistentVolume",
        (
            NAME,
            STATUS,
            _col("claim", "Claim"),
            CAPACITY,
            _col("reclaim", "Reclaim", width="s"),
            STORAGE_CLASS,
            AGE,
        ),
        kr.pv_row,
        namespaced=False,
        short_names=("pv",),
    ),
    _core(
        "nodes",
        "Node",
        (
            NAME,
            STATUS,
            _col("roles", "Roles"),
            _col("version", "Version", width="s"),
            CPU,
            MEMORY,
            _col("pods", "Pods", "pods", "s"),
            _col("pressure", "Pressure"),
            _col("taints", "Taints", "number", "s"),
            AGE,
        ),
        kr.node_row,
        namespaced=False,
        short_names=("no",),
    ),
    _core(
        "events",
        "Event",
        (
            NAMESPACE,
            _col("status", "Type", "status", "s"),
            _col("reason", "Reason"),
            _col("object", "Object", "object", "l"),
            _col("message", "Message", width="l"),
            _col("count", "Count", "number", "s"),
            _col("last_seen", "Last seen", "time", "s"),
        ),
        kr.event_row,
        sort="recent",
        short_names=("ev",),
    ),
    _core(
        "namespaces",
        "Namespace",
        (NAME, STATUS, AGE),
        kr.namespace_row,
        namespaced=False,
        short_names=("ns",),
    ),
    _core(
        "horizontalpodautoscalers",
        "HorizontalPodAutoscaler",
        (
            NAME,
            NAMESPACE,
            _col("target", "Target", "object"),
            _col("replicas", "Replicas", width="s"),
            AGE,
        ),
        kr.hpa_row,
        group="autoscaling",
        version="v2",
        short_names=("hpa",),
    ),
    # Helm keeps each release revision in a Secret labelled owner=helm; rows read only the labels.
    KindSpec(
        key=HELM_RELEASES,
        group="",
        version="v1",
        plural="secrets",
        kind="HelmRelease",
        namespaced=True,
        label="Helm release",
        # One row per revision: the release first, its Secret (the object's own name) last.
        columns=(
            _col("release", "Release", width="l"),
            NAMESPACE,
            _col("revision", "Revision", "number", "s"),
            STATUS,
            _col("updated", "Updated", "time", "s"),
            _col("name", "Secret", width="l"),
        ),
        to_row=kr.helm_release_row,
        sort="recent",
        label_selector="owner=helm",
        plural_label="Helm releases",
    ),
)

KINDS: dict[str, KindSpec] = {spec.key: spec for spec in _CURATED}
