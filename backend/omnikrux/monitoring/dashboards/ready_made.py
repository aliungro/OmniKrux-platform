"""Ready-made views: read-only dashboards OmniKrux generates for a project.

They are data, built on request from small helpers; nothing here calls Prometheus. Each view is
a normalised, valid dashboard document whose sources are `{"type": …, "id": None}` (the project's
first source of that type). Their ids are `ready:<project id>:<key>`; they are never stored, so
they have no versions and can't be saved, restored or deleted (only copied).

`NEEDS` says which exporters a view reads; `NEED_METRIC` is one metric that proves each is
reporting, and `NEED_NOTE` is what the project page says when it isn't."""

from collections.abc import Mapping
from typing import Literal

from omnikrux.monitoring.dashboards.schema import validate_dashboard
from omnikrux.monitoring.projects.types import Project
from omnikrux.monitoring.sources.types import ProjectKind

ReadyKey = Literal["cluster", "nodes", "namespaces", "workloads", "pods"]
Need = Literal["kube_state", "cadvisor", "node_exporter"]

READY_ORDER: tuple[ReadyKey, ...] = ("cluster", "nodes", "namespaces", "workloads", "pods")

TITLES: dict[ReadyKey, str] = {
    "cluster": "Cluster health",
    "nodes": "Node health",
    "namespaces": "Namespace health",
    "workloads": "Workload health",
    "pods": "Pod health",
}
DESCRIPTIONS: dict[ReadyKey, str] = {
    "cluster": "Nodes, Pods and resource use across the cluster.",
    "nodes": "CPU, memory, load, disk and network per node.",
    "namespaces": "Pods and resource use per namespace.",
    "workloads": "Replicas and resource use per Deployment, StatefulSet and DaemonSet.",
    "pods": "Readiness, restarts, waiting reasons and resource use per Pod.",
}
NEEDS: dict[ReadyKey, tuple[Need, ...]] = {
    "cluster": ("kube_state", "cadvisor"),
    "nodes": ("node_exporter",),
    "namespaces": ("kube_state", "cadvisor"),
    "workloads": ("kube_state", "cadvisor"),
    "pods": ("kube_state", "cadvisor"),
}
NEED_METRIC: dict[Need, str] = {
    "kube_state": "kube_pod_info",
    "cadvisor": "container_cpu_usage_seconds_total",
    "node_exporter": "node_cpu_seconds_total",
}
NEED_NOTE: dict[Need, str] = {
    "kube_state": "kube-state-metrics isn't reporting to this Prometheus, so counts and states "
    "stay empty.",
    "cadvisor": "Container usage from the kubelet (cAdvisor) isn't collected, so CPU and memory "
    "stay empty.",
    "node_exporter": "node-exporter isn't reporting to this Prometheus, so node panels stay empty.",
}

PREFIX = "ready"


def ready_id(project_id: str, key: ReadyKey) -> str:
    return f"{PREFIX}:{project_id}:{key}"


def parse_ready_id(id: str) -> tuple[str, ReadyKey] | None:
    """(project id, key) of a ready-made id, or None for any other id."""
    parts = id.split(":")
    if len(parts) != 3 or parts[0] != PREFIX or not parts[1] or parts[2] not in READY_ORDER:
        return None
    return parts[1], parts[2]  # type: ignore[return-value]


def ready_keys(kind: ProjectKind, has_prometheus: bool, has_loki: bool) -> tuple[ReadyKey, ...]:
    """The views a project gets: all five for Kubernetes with Prometheus, Node health for any
    other kind with Prometheus, none without it. (`has_loki` only changes a view's panels.)"""
    if not has_prometheus:
        return ()
    return READY_ORDER if kind == "kubernetes" else ("nodes",)


def project_ready_keys(project: Project, source_types: Mapping[str, str]) -> tuple[ReadyKey, ...]:
    """`ready_keys` for a project, given the type of each source (by id) that exists."""
    types = {
        source_types[link.source_id] for link in project.links if link.source_id in source_types
    }
    return ready_keys(project.kind, "prometheus" in types, "loki" in types)


# --- Building blocks ----------------------------------------------------------------------------

_PROM = {"type": "prometheus", "id": None}
_LOKI = {"type": "loki", "id": None}


def _pq(ref: str, expr: str, legend: str = "") -> dict:
    return {"ref": ref, "source": dict(_PROM), "expr": expr, "legend": legend}


def _lq(ref: str, expr: str) -> dict:
    return {"ref": ref, "source": dict(_LOKI), "expr": expr}


class _Panels:
    """Panels numbered `p-1`, `p-2`… in the order they are added."""

    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(
        self, kind: str, title: str, at: tuple[int, int, int, int], queries: list[dict], **options
    ) -> None:
        x, y, w, h = at
        self.items.append(
            {
                "id": f"p-{len(self.items) + 1}",
                "type": kind,
                "title": title,
                "layout": {"x": x, "y": y, "w": w, "h": h},
                "queries": queries,
                "options": options,
            }
        )


def _above(value: float, color: str) -> dict:
    return {"value": value, "color": color}


def _variable(name: str, label: str, label_name: str, match: str) -> dict:
    return {
        "name": name,
        "label": label,
        "type": "labelValues",
        "source": dict(_PROM),
        "labelName": label_name,
        "match": match,
        "multi": True,
        "includeAll": True,
        "default": "all",
    }


def _namespace_variable() -> dict:
    return _variable("namespace", "Namespace", "namespace", "kube_namespace_status_phase")


def _document(key: ReadyKey, panels: _Panels, variables: list[dict]) -> dict:
    return validate_dashboard(
        {
            "schemaVersion": 1,
            "title": TITLES[key],
            "description": DESCRIPTIONS[key],
            "variables": variables,
            "panels": panels.items,
        },
        owner_kind="project",
    )


# --- The views ----------------------------------------------------------------------------------


def _cluster() -> dict:
    p = _Panels()
    p.add(
        "stat",
        "Nodes ready",
        (0, 0, 6, 4),
        [_pq("A", 'sum(kube_node_status_condition{condition="Ready",status="true"})')],
    )
    p.add(
        "stat",
        "Nodes not ready",
        (6, 0, 6, 4),
        [
            _pq(
                "A",
                'count(kube_node_status_condition{condition="Ready",status="true"} == 0)'
                " or vector(0)",
            )
        ],
        thresholds=[_above(1, "bad")],
    )
    p.add(
        "stat",
        "Pods running",
        (12, 0, 6, 4),
        [_pq("A", 'sum(kube_pod_status_phase{phase="Running"})')],
    )
    p.add(
        "stat",
        "Pods not ready",
        (18, 0, 6, 4),
        [_pq("A", 'sum(kube_pod_status_ready{condition="false"})')],
        thresholds=[_above(1, "warn")],
    )
    gauge = {
        "unit": "percentunit",
        "max": 1,
        "thresholds": [_above(0.8, "warn"), _above(0.95, "bad")],
    }
    p.add(
        "gauge",
        "CPU requested",
        (0, 4, 6, 6),
        [
            _pq(
                "A",
                'sum(kube_pod_container_resource_requests{resource="cpu"})'
                ' / sum(kube_node_status_allocatable{resource="cpu"})',
            )
        ],
        **gauge,
    )
    p.add(
        "gauge",
        "Memory requested",
        (6, 4, 6, 6),
        [
            _pq(
                "A",
                'sum(kube_pod_container_resource_requests{resource="memory"})'
                ' / sum(kube_node_status_allocatable{resource="memory"})',
            )
        ],
        **gauge,
    )
    p.add(
        "bar",
        "Pods by phase",
        (12, 4, 12, 6),
        [_pq("A", "sum by (phase) (kube_pod_status_phase)", "{{phase}}")],
    )
    p.add(
        "timeseries",
        "CPU used by namespace",
        (0, 10, 12, 8),
        [
            _pq(
                "A",
                "sum by (namespace) "
                '(rate(container_cpu_usage_seconds_total{container!=""}[$__rate_interval]))',
                "{{namespace}}",
            )
        ],
        unit="cores",
    )
    p.add(
        "timeseries",
        "Memory used by namespace",
        (12, 10, 12, 8),
        [
            _pq(
                "A",
                'sum by (namespace) (container_memory_working_set_bytes{container!=""})',
                "{{namespace}}",
            )
        ],
        unit="bytes",
    )
    p.add(
        "table",
        "Restarts in the last hour",
        (0, 18, 24, 8),
        [
            _pq(
                "A",
                "topk(10, sum by (namespace, pod) "
                "(increase(kube_pod_container_status_restarts_total[1h])) > 0)",
            )
        ],
        columns=["namespace", "pod"],
        sort={"column": "Value", "descending": True},
        # increase() extrapolates (11.2 restarts); restarts are counted in whole numbers.
        decimals=0,
    )
    return _document("cluster", p, [])


def _nodes(kind: ProjectKind) -> dict:
    p = _Panels()
    node = 'instance=~"$instance"'
    p.add(
        "timeseries",
        "CPU busy",
        (0, 0, 12, 8),
        [
            _pq(
                "A",
                f'1 - avg by (instance) (rate(node_cpu_seconds_total{{mode="idle",{node}}}'
                "[$__rate_interval]))",
                "{{instance}}",
            )
        ],
        unit="percentunit",
        max=1,
    )
    p.add(
        "timeseries",
        "Memory used",
        (12, 0, 12, 8),
        [
            _pq(
                "A",
                f"1 - node_memory_MemAvailable_bytes{{{node}}} / node_memory_MemTotal_bytes{{{node}}}",
                "{{instance}}",
            )
        ],
        unit="percentunit",
        max=1,
    )
    p.add(
        "timeseries",
        "Load (1 min)",
        (0, 8, 12, 8),
        [_pq("A", f"node_load1{{{node}}}", "{{instance}}")],
        unit="short",
    )
    disk = f'mountpoint="/",fstype!="rootfs",{node}'
    p.add(
        "bar",
        "Root disk used",
        (12, 8, 12, 8),
        [
            _pq(
                "A",
                f"1 - node_filesystem_avail_bytes{{{disk}}} / node_filesystem_size_bytes{{{disk}}}",
                "{{instance}}",
            )
        ],
        unit="percentunit",
        thresholds=[_above(0.8, "warn"), _above(0.9, "bad")],
    )
    device = f'device!~"lo|veth.*|cali.*|cni.*|flannel.*",{node}'
    for title, at, metric in (
        ("Network received", (0, 16, 12, 8), "node_network_receive_bytes_total"),
        ("Network sent", (12, 16, 12, 8), "node_network_transmit_bytes_total"),
    ):
        p.add(
            "timeseries",
            title,
            at,
            [
                _pq(
                    "A",
                    f"sum by (instance) (rate({metric}{{{device}}}[$__rate_interval]))",
                    "{{instance}}",
                )
            ],
            unit="Bps",
        )
    if kind == "kubernetes":
        p.add(
            "table",
            "Node conditions",
            (0, 24, 24, 6),
            [_pq("A", 'kube_node_status_condition{status="true"} == 1')],
            columns=["node", "condition"],
        )
    variable = _variable("instance", "Node", "instance", "node_uname_info")
    return _document("nodes", p, [variable])


def _namespaces() -> dict:
    p = _Panels()
    ns = 'namespace=~"$namespace"'
    p.add(
        "stat",
        "Pods running",
        (0, 0, 6, 4),
        [_pq("A", f'sum(kube_pod_status_phase{{phase="Running",{ns}}})')],
    )
    p.add(
        "stat",
        "Pods failing",
        (6, 0, 6, 4),
        [_pq("A", f'sum(kube_pod_status_phase{{phase=~"Failed|Unknown",{ns}}})')],
        thresholds=[_above(1, "bad")],
    )
    p.add(
        "bar",
        "Pods by phase",
        (12, 0, 12, 4),
        [_pq("A", f"sum by (phase) (kube_pod_status_phase{{{ns}}})", "{{phase}}")],
    )
    p.add(
        "timeseries",
        "CPU used",
        (0, 4, 12, 8),
        [
            _pq(
                "A",
                "sum by (namespace) "
                f'(rate(container_cpu_usage_seconds_total{{container!="",{ns}}}'
                "[$__rate_interval]))",
                "{{namespace}}",
            )
        ],
        unit="cores",
    )
    p.add(
        "timeseries",
        "Memory used",
        (12, 4, 12, 8),
        [
            _pq(
                "A",
                f'sum by (namespace) (container_memory_working_set_bytes{{container!="",{ns}}})',
                "{{namespace}}",
            )
        ],
        unit="bytes",
    )
    p.add(
        "timeseries",
        "Container restarts",
        (0, 12, 24, 8),
        [
            _pq(
                "A",
                "sum by (namespace) "
                f"(increase(kube_pod_container_status_restarts_total{{{ns}}}[$__rate_interval]))",
                "{{namespace}}",
            )
        ],
        unit="short",
    )
    return _document("namespaces", p, [_namespace_variable()])


def _workloads() -> dict:
    p = _Panels()
    ns = 'namespace=~"$namespace"'
    p.add(
        "stat",
        "Deployments short of replicas",
        (0, 0, 8, 4),
        [
            _pq(
                "A",
                f"count(kube_deployment_spec_replicas{{{ns}}}"
                f" > kube_deployment_status_replicas_available{{{ns}}}) or vector(0)",
            )
        ],
        thresholds=[_above(1, "warn")],
    )
    p.add(
        "stat",
        "StatefulSets short of replicas",
        (8, 0, 8, 4),
        [
            _pq(
                "A",
                f"count(kube_statefulset_replicas{{{ns}}}"
                f" > kube_statefulset_status_replicas_ready{{{ns}}}) or vector(0)",
            )
        ],
        thresholds=[_above(1, "warn")],
    )
    p.add(
        "stat",
        "DaemonSets short of Pods",
        (16, 0, 8, 4),
        [
            _pq(
                "A",
                f"count(kube_daemonset_status_desired_number_scheduled{{{ns}}}"
                f" > kube_daemonset_status_number_ready{{{ns}}}) or vector(0)",
            )
        ],
        thresholds=[_above(1, "warn")],
    )
    p.add(
        "table",
        "Deployments",
        (0, 4, 24, 8),
        [
            _pq("A", f"kube_deployment_status_replicas_available{{{ns}}}", "Available"),
            _pq("B", f"kube_deployment_spec_replicas{{{ns}}}", "Desired"),
        ],
        columns=["namespace", "deployment"],
    )
    legend = "{{namespace}}/{{owner_name}}"
    owner = f"* on (namespace, pod) group_left (owner_name) kube_pod_owner{{{ns}}}"
    p.add(
        "timeseries",
        "CPU by owner",
        (0, 12, 12, 8),
        [
            _pq(
                "A",
                "sum by (namespace, owner_name) "
                f'(rate(container_cpu_usage_seconds_total{{container!="",{ns}}}'
                f"[$__rate_interval]) {owner})",
                legend,
            )
        ],
        unit="cores",
    )
    p.add(
        "timeseries",
        "Memory by owner",
        (12, 12, 12, 8),
        [
            _pq(
                "A",
                "sum by (namespace, owner_name) "
                f'(container_memory_working_set_bytes{{container!="",{ns}}} {owner})',
                legend,
            )
        ],
        unit="bytes",
    )
    return _document("workloads", p, [_namespace_variable()])


def _pods(has_loki: bool) -> dict:
    p = _Panels()
    sel = 'namespace=~"$namespace",pod=~"$pod"'
    legend = "{{namespace}}/{{pod}}"
    p.add(
        "table",
        "Pods not ready",
        (0, 0, 12, 8),
        [_pq("A", f'kube_pod_status_ready{{condition="false",{sel}}} == 1')],
        columns=["namespace", "pod"],
    )
    p.add(
        "table",
        "Waiting reasons",
        (12, 0, 12, 8),
        [
            _pq(
                "A",
                "sum by (namespace, pod, reason) "
                f"(kube_pod_container_status_waiting_reason{{{sel}}}) > 0",
            )
        ],
        columns=["namespace", "pod", "reason"],
    )
    p.add(
        "timeseries",
        "CPU by Pod",
        (0, 8, 12, 8),
        [
            _pq(
                "A",
                "sum by (namespace, pod) "
                f'(rate(container_cpu_usage_seconds_total{{container!="",{sel}}}'
                "[$__rate_interval]))",
                legend,
            )
        ],
        unit="cores",
    )
    p.add(
        "timeseries",
        "Memory by Pod",
        (12, 8, 12, 8),
        [
            _pq(
                "A",
                "sum by (namespace, pod) "
                f'(container_memory_working_set_bytes{{container!="",{sel}}})',
                legend,
            )
        ],
        unit="bytes",
    )
    p.add(
        "timeseries",
        "Restarts",
        (0, 16, 12, 8),
        [
            _pq(
                "A",
                "sum by (namespace, pod) "
                f"(increase(kube_pod_container_status_restarts_total{{{sel}}}[$__rate_interval]))",
                legend,
            )
        ],
        unit="short",
    )
    throttled = "container_cpu_cfs_throttled_periods_total"
    periods = "container_cpu_cfs_periods_total"
    p.add(
        "timeseries",
        "CPU throttled",
        (12, 16, 12, 8),
        [
            _pq(
                "A",
                f'sum by (namespace, pod) (rate({throttled}{{container!="",{sel}}}'
                "[$__rate_interval]))"
                f' / sum by (namespace, pod) (rate({periods}{{container!="",{sel}}}'
                "[$__rate_interval]))",
                legend,
            )
        ],
        unit="percentunit",
        max=1,
    )
    if has_loki:
        p.add(
            "logs",
            "Logs",
            (0, 24, 24, 10),
            [_lq("A", '{namespace=~"$namespace", pod=~"$pod"}')],
            limit=200,
        )
    pod = _variable("pod", "Pod", "pod", 'kube_pod_info{namespace=~"$namespace"}')
    return _document("pods", p, [_namespace_variable(), pod])


def build_ready_made(key: ReadyKey, *, kind: ProjectKind, has_loki: bool) -> dict:
    """The view as a normalised, valid document; no Prometheus call is made."""
    if key == "cluster":
        return _cluster()
    if key == "nodes":
        return _nodes(kind)
    if key == "namespaces":
        return _namespaces()
    if key == "workloads":
        return _workloads()
    return _pods(has_loki)
