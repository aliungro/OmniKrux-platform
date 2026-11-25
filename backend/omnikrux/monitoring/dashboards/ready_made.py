"""Ready-made views: read-only dashboards OmniKrux generates for a project.

They are data, built on request from small helpers; nothing here calls Prometheus or Loki (the
Loki labels the log panels use are read by `loki_labels` and handed in). Each view is
a normalised, valid dashboard document whose sources are `{"type": …, "id": None}` (the project's
first source of that type). Their ids are `ready:<project id>:<key>`; they are never stored, so
they have no versions and can't be saved, restored or deleted (only copied).

`NEEDS` says which exporters a view reads; `NEED_METRIC` is one metric that proves each is
reporting, and `NEED_NOTE` is what the project page says when it isn't. The Logs overview reads
only Loki; `loki_notes` says what its labels (and Pod health's Logs panel's) lack."""

from collections.abc import Mapping
from typing import Literal

from omnikrux.monitoring.dashboards.loki_labels import (
    CLASSIC,
    LokiFacts,
    LokiLabelSet,
    group_label,
    level_label,
    pick_label_set,
)
from omnikrux.monitoring.dashboards.schema import validate_dashboard
from omnikrux.monitoring.projects.types import Project
from omnikrux.monitoring.sources.types import ProjectKind

ReadyKey = Literal["cluster", "nodes", "namespaces", "workloads", "pods", "logs"]
Need = Literal["kube_state", "cadvisor", "node_exporter"]

READY_ORDER: tuple[ReadyKey, ...] = ("cluster", "nodes", "namespaces", "workloads", "pods", "logs")
# The views that read Prometheus; the Logs overview reads only Loki.
PROMETHEUS_VIEWS: tuple[ReadyKey, ...] = ("cluster", "nodes", "namespaces", "workloads", "pods")
# The views whose panels follow the Loki's labels.
LOKI_VIEWS: tuple[ReadyKey, ...] = ("pods", "logs")

TITLES: dict[ReadyKey, str] = {
    "cluster": "Cluster health",
    "nodes": "Node health",
    "namespaces": "Namespace health",
    "workloads": "Workload health",
    "pods": "Pod health",
    "logs": "Logs overview",
}
DESCRIPTIONS: dict[ReadyKey, str] = {
    "cluster": "Nodes, Pods and resource use across the cluster.",
    "nodes": "CPU, memory, load, disk and network per node.",
    "namespaces": "Pods and resource use per namespace.",
    "workloads": "Replicas and resource use per Deployment, StatefulSet and DaemonSet.",
    "pods": "Readiness, restarts, waiting reasons and resource use per Pod.",
    "logs": "Log lines per second, errors and warnings, the noisiest streams and recent error lines.",
}
NEEDS: dict[ReadyKey, tuple[Need, ...]] = {
    "cluster": ("kube_state", "cadvisor"),
    "nodes": ("node_exporter",),
    "namespaces": ("kube_state", "cadvisor"),
    "workloads": ("kube_state", "cadvisor"),
    "pods": ("kube_state", "cadvisor"),
    "logs": (),
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

LOKI_UNREAD = (
    "OmniKrux couldn't read this Loki's labels ({reason}), so its log panels assume namespace "
    "and pod labels and may stay empty."
)
LOKI_EMPTY = (
    "This Loki holds no log streams from the last 7 days, so this view stays empty until logs "
    "arrive."
)
POD_LOGS_NO_LABELS = (
    "This Loki has no Pod labels (k8s_namespace_name and k8s_pod_name, or namespace and pod), "
    "so the Logs panel stays empty."
)

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
    """The views a project gets: with Prometheus, all five Prometheus views for Kubernetes and
    Node health for any other kind; then, with Loki, the Logs overview (also without
    Prometheus)."""
    keys: tuple[ReadyKey, ...] = ()
    if has_prometheus:
        keys = PROMETHEUS_VIEWS if kind == "kubernetes" else ("nodes",)
    return (*keys, "logs") if has_loki else keys


def loki_notes(key: ReadyKey, loki: LokiFacts | None) -> list[str]:
    """What a view's log panels lack, from its project's Loki facts (None: no Loki, nothing to
    say). Labels that couldn't be read are said in both views that use them; no streams at all,
    in the Logs overview; no Pod label set, in Pod health (for its Logs panel)."""
    if loki is None or key not in LOKI_VIEWS:
        return []
    if loki.labels is None:
        return [LOKI_UNREAD.format(reason=loki.message)]
    if key == "logs":
        return [] if loki.labels else [LOKI_EMPTY]
    return [] if pick_label_set(loki.labels) is not None else [POD_LOGS_NO_LABELS]


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


def _lq(ref: str, expr: str, legend: str | None = None) -> dict:
    query = {"ref": ref, "source": dict(_LOKI), "expr": expr}
    return query if legend is None else query | {"legend": legend}


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


def _pod_label_set(loki: LokiFacts | None) -> LokiLabelSet:
    """The label set Pod health's Logs panel selects with: the Loki's own, else the classic set
    (`loki_notes` then says the labels were unread or missing)."""
    labels = loki.labels if loki is not None else None
    found = pick_label_set(labels) if labels is not None else None
    return found or CLASSIC


def _pods(has_loki: bool, loki: LokiFacts | None) -> dict:
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
        s = _pod_label_set(loki)
        p.add(
            "logs",
            "Logs",
            (0, 24, 24, 10),
            [_lq("A", f'{{{s.namespace}=~"$namespace", {s.pod}=~"$pod"}}')],
            limit=200,
        )
    pod = _variable("pod", "Pod", "pod", 'kube_pod_info{namespace=~"$namespace"}')
    return _document("pods", p, [_namespace_variable(), pod])


def _log_labels(loki: LokiFacts | None) -> tuple[str, str | None]:
    """(the label the Logs overview groups streams by, the label a line's level is in or None).
    Grouped by the Pod label set's namespace label when there is one, else by the first group
    label the streams carry, else (no labels at all) by `job`. Labels unread (or not read): the
    classic set's `namespace`, and line filters instead of a level label."""
    labels = loki.labels if loki is not None else None
    if labels is None:
        return CLASSIC.namespace, None
    found = pick_label_set(labels)
    group = found.namespace if found is not None else group_label(labels) or "job"
    return group, level_label(labels)


def _logs(loki: LokiFacts | None) -> dict:
    p = _Panels()
    g, level = _log_labels(loki)
    sel = f'{{{g}=~".+"}}'
    by_group = "{{" + g + "}}"
    p.add(
        "timeseries",
        "Log lines per second",
        (0, 0, 24, 8),
        [_lq("A", f"sum by ({g}) (rate({sel}[$__rate_interval]))", by_group)],
        unit="short",
    )
    if level is not None:
        levels = "(?i)(error|err|fatal|critical|crit|warn|warning)"
        errors_and_warnings = [
            _lq(
                "A",
                f'sum by ({level}) (count_over_time({{{g}=~".+", {level}=~"{levels}"}}'
                "[$__interval]))",
                "{{" + level + "}}",
            )
        ]
        error_lines = f'{{{g}=~".+", {level}=~"(?i)(error|err|fatal|critical|crit)"}}'
    else:
        errors_and_warnings = [
            _lq(
                "A",
                f'sum(count_over_time({sel} |~ "(?i)(error|fatal|panic)" [$__interval]))',
                "Errors",
            ),
            _lq("B", f'sum(count_over_time({sel} |~ "(?i)warn" [$__interval]))', "Warnings"),
        ]
        error_lines = f'{sel} |~ "(?i)(error|fatal|panic)"'
    p.add(
        "timeseries",
        "Errors and warnings",
        (0, 8, 12, 8),
        errors_and_warnings,
        # Task 2 of M7 switches this to bars (a count per step).
        style="stacked",
        decimals=0,
    )
    p.add(
        "bar",
        "Noisiest streams",
        (12, 8, 12, 8),
        [_lq("A", f"topk(10, sum by ({g}) (count_over_time({sel}[$__range])))", by_group)],
        decimals=0,
    )
    p.add("logs", "Recent error lines", (0, 16, 24, 10), [_lq("A", error_lines)], limit=100)
    return _document("logs", p, [])


def build_ready_made(
    key: ReadyKey, *, kind: ProjectKind, has_loki: bool, loki: LokiFacts | None = None
) -> dict:
    """The view as a normalised, valid document; no Prometheus or Loki call is made. `loki` is
    what the project's Loki holds (`read_loki_facts`); None or unread labels: the classic set."""
    if key == "logs":
        return _logs(loki)
    if key == "cluster":
        return _cluster()
    if key == "nodes":
        return _nodes(kind)
    if key == "namespaces":
        return _namespaces()
    if key == "workloads":
        return _workloads()
    return _pods(has_loki, loki)
