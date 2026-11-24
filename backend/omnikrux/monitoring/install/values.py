"""The Helm values for each release, written as plain dictionaries, and what each chart creates
(the workloads and Services the tools page and the install job watch)."""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal

from omnikrux.monitoring.install.pins import ChartKey
from omnikrux.monitoring.install.settings import Component, InstallSettings, Resources

MANAGED_BY = "omnikrux"


@dataclass(frozen=True)
class WorkloadRef:
    kind: Literal["Deployment", "StatefulSet", "DaemonSet"]
    name: str
    label: str
    made_by_operator: bool = False


@dataclass(frozen=True)
class ReleaseSpec:
    release: str
    chart: ChartKey
    workloads: tuple[WorkloadRef, ...]
    # service kind -> (Service name, port number as text)
    services: Mapping[Literal["prometheus", "alertmanager", "loki"], tuple[str, str]]


RELEASES: Mapping[Component, tuple[ReleaseSpec, ...]] = MappingProxyType(
    {
        "metrics": (
            ReleaseSpec(
                "omnikrux-metrics",
                "kube-prometheus-stack",
                (
                    WorkloadRef("Deployment", "omnikrux-metrics-operator", "Prometheus Operator"),
                    WorkloadRef(
                        "Deployment", "omnikrux-metrics-kube-state-metrics", "kube-state-metrics"
                    ),
                    WorkloadRef(
                        "DaemonSet", "omnikrux-metrics-prometheus-node-exporter", "node-exporter"
                    ),
                    WorkloadRef(
                        "StatefulSet",
                        "prometheus-omnikrux-metrics-prometheus",
                        "Prometheus",
                        made_by_operator=True,
                    ),
                    WorkloadRef(
                        "StatefulSet",
                        "alertmanager-omnikrux-metrics-alertmanager",
                        "Alertmanager",
                        made_by_operator=True,
                    ),
                ),
                MappingProxyType(
                    {
                        "prometheus": ("omnikrux-metrics-prometheus", "9090"),
                        "alertmanager": ("omnikrux-metrics-alertmanager", "9093"),
                    }
                ),
            ),
        ),
        "logs": (
            ReleaseSpec(
                "omnikrux-loki",
                "loki",
                (WorkloadRef("StatefulSet", "omnikrux-loki", "Loki"),),
                MappingProxyType({"loki": ("omnikrux-loki", "3100")}),
            ),
            ReleaseSpec(
                "omnikrux-alloy",
                "alloy",
                (WorkloadRef("Deployment", "omnikrux-alloy", "Grafana Alloy"),),
                MappingProxyType({}),
            ),
        ),
    }
)


_ALLOY_ESCAPES = {"\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _alloy_string(text: str) -> str:
    """An Alloy string literal: quotes, backslashes and every control character escaped."""
    escaped = "".join(
        _ALLOY_ESCAPES.get(c) or (f"\\u{ord(c):04x}" if ord(c) < 0x20 or ord(c) == 0x7F else c)
        for c in text
    )
    return f'"{escaped}"'


def literal_in_tpl(text: str) -> str:
    """The Alloy chart runs `configMap.content` through Helm's `tpl`: `{{` is written so it
    comes out as the same two characters."""
    return text.replace("{{", '{{ "{{" }}')


def alloy_config(namespace: str, cluster_name: str) -> str:
    return f"""discovery.kubernetes "pods" {{
  role = "pod"
}}

discovery.relabel "pods" {{
  targets = discovery.kubernetes.pods.targets
  rule {{ source_labels = ["__meta_kubernetes_namespace"] target_label = "namespace" }}
  rule {{ source_labels = ["__meta_kubernetes_pod_name"] target_label = "pod" }}
  rule {{ source_labels = ["__meta_kubernetes_pod_container_name"] target_label = "container" }}
  rule {{ source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name"] target_label = "app" }}
  rule {{ source_labels = ["__meta_kubernetes_pod_node_name"] target_label = "node" }}
}}

loki.source.kubernetes "pods" {{
  targets    = discovery.relabel.pods.output
  forward_to = [loki.write.omnikrux.receiver]
}}

loki.write "omnikrux" {{
  endpoint {{
    url = "http://omnikrux-loki.{namespace}.svc:3100/loki/api/v1/push"
  }}
  external_labels = {{ cluster = {_alloy_string(cluster_name)} }}
}}
"""


def _resources(r: Resources) -> dict[str, Any]:
    return {
        "requests": {"cpu": r.cpu_request, "memory": r.memory_request},
        "limits": {"memory": r.memory_limit},
    }


def _claim(size: str) -> dict[str, Any]:
    return {
        "spec": {
            "accessModes": ["ReadWriteOnce"],
            "resources": {"requests": {"storage": size}},
        }
    }


def _metrics(s: InstallSettings, namespace: str) -> dict[str, Any]:
    prometheus_spec: dict[str, Any] = {
        "retention": f"{s.retention_days}d",
        "resources": _resources(s.prometheus),
    }
    alertmanager_spec: dict[str, Any] = {
        "resources": _resources(s.alertmanager),
        "alertmanagerConfigSelector": {"matchLabels": {"app.kubernetes.io/managed-by": "omnikrux"}},
        "alertmanagerConfigNamespaceSelector": {
            "matchLabels": {"kubernetes.io/metadata.name": namespace}
        },
        "alertmanagerConfigMatcherStrategy": {"type": "None"},
    }
    if s.persist:
        prometheus_spec["storageSpec"] = {"volumeClaimTemplate": _claim(s.prometheus_storage)}
        alertmanager_spec["storage"] = {"volumeClaimTemplate": _claim(s.alertmanager_storage)}
    return {
        "fullnameOverride": "omnikrux-metrics",
        "grafana": {"enabled": False},
        "crds": {"enabled": False},
        "defaultRules": {"create": False},
        "kubeEtcd": {"enabled": False},
        "kubeScheduler": {"enabled": False},
        "kubeControllerManager": {"enabled": False},
        "kubeProxy": {"enabled": False},
        "prometheus": {"prometheusSpec": prometheus_spec},
        "alertmanager": {"alertmanagerSpec": alertmanager_spec},
    }


def _loki(s: InstallSettings) -> dict[str, Any]:
    single_binary: dict[str, Any] = {
        "replicas": 1,
        "resources": _resources(s.loki),
        "persistence": {"enabled": s.persist, "size": s.loki_storage},
    }
    if not s.persist:
        # Chart 7 leaves /var/loki read-only without a volume: give Loki a scratch one.
        single_binary["extraVolumes"] = [{"name": "data", "emptyDir": {}}]
        single_binary["extraVolumeMounts"] = [{"name": "data", "mountPath": "/var/loki"}]
    return {
        "fullnameOverride": "omnikrux-loki",
        "deploymentMode": "SingleBinary",
        "loki": {
            "auth_enabled": False,
            "commonConfig": {"replication_factor": 1},
            "storage": {"type": "filesystem"},
            "schemaConfig": {
                "configs": [
                    {
                        "from": "2024-04-01",
                        "store": "tsdb",
                        "object_store": "filesystem",
                        "schema": "v13",
                        "index": {"prefix": "index_", "period": "24h"},
                    }
                ]
            },
            "limits_config": {"retention_period": f"{s.retention_days * 24}h"},
            "compactor": {"retention_enabled": True, "delete_request_store": "filesystem"},
        },
        "singleBinary": single_binary,
        "read": {"replicas": 0},
        "write": {"replicas": 0},
        "backend": {"replicas": 0},
        "gateway": {"enabled": False},
        "chunksCache": {"enabled": False},
        "resultsCache": {"enabled": False},
        "lokiCanary": {"enabled": False},
        "test": {"enabled": False},
        "minio": {"enabled": False},
    }


def _alloy(s: InstallSettings, namespace: str, cluster_name: str) -> dict[str, Any]:
    return {
        "fullnameOverride": "omnikrux-alloy",
        "controller": {"type": "deployment", "replicas": 1},
        "alloy": {
            "resources": _resources(s.alloy),
            "configMap": {
                "create": True,
                "content": literal_in_tpl(alloy_config(namespace, cluster_name)),
            },
        },
        "crds": {"create": False},
    }


def values_for(
    release: str, s: InstallSettings, *, namespace: str, cluster_name: str
) -> dict[str, Any]:
    """The values for one release. Each carries the top-level `omnikrux.managedBy` marker, which
    no chart reads: it is stored in the Helm release so a later review can tell whose it is."""
    if release == "omnikrux-metrics":
        values = _metrics(s, namespace)
    elif release == "omnikrux-loki":
        values = _loki(s)
    elif release == "omnikrux-alloy":
        values = _alloy(s, namespace, cluster_name)
    else:
        raise KeyError(release)
    values["omnikrux"] = {"managedBy": MANAGED_BY}
    return values
