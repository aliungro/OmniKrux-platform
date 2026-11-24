"""Install settings, the values for each release, and the sentence about what a chart creates."""

from dataclasses import replace

from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.render import ObjectRef, objects_sentence
from omnikrux.monitoring.install.settings import (
    ClusterFacts,
    InstallSettings,
    Resources,
    effective_settings,
    validate_settings,
)
from omnikrux.monitoring.install.values import RELEASES, alloy_config, values_for


def facts(**changes) -> ClusterFacts:
    base = ClusterFacts(
        cluster_id="c1",
        cluster_name="kind-omnikrux-dev",
        kube_version="v1.31.0",
        default_storage_class="standard",
        namespace_exists=False,
        served_monitoring_crds={},
        foreign_operator=None,
        releases={},
        environment="dev",
    )
    return replace(base, **changes)


def problems(**changes) -> dict[str, str]:
    return {p.field: p.message for p in validate_settings(replace(InstallSettings(), **changes))}


def test_defaults_are_valid():
    assert validate_settings(InstallSettings()) == []


def test_settings_validation_words():
    assert problems(namespace="Bad_Name")["namespace"] == (
        "Use a namespace name: lower-case letters, digits and -, up to 63 characters."
    )
    assert "namespace" in problems(namespace="a" * 64)
    assert "namespace" in problems(namespace="-x")
    for reserved in ("default", "kube-system", "kube-public"):
        assert problems(namespace=reserved)["namespace"] == (
            f"OmniKrux doesn't install into {reserved}. Pick another namespace."
        )
    assert problems(retention_days=0)["retention_days"] == "Keep data for 1 to 90 days."
    assert "retention_days" in problems(retention_days=91)
    assert problems(loki_storage="10GB")["loki_storage"] == "Use a size like 10Gi."
    assert "prometheus_storage" in problems(prometheus_storage="0Gi")
    assert "alertmanager_storage" in problems(alertmanager_storage="")
    bad_cpu = problems(prometheus=Resources("fast", "512Mi", "2Gi"))
    assert bad_cpu["prometheus.cpu_request"] == "Use CPU like 100m or 0.5."
    assert not problems(alloy=Resources("0.5", "128Mi", "512Mi"))
    bad_memory = problems(loki=Resources("100m", "256MB", "1Gi"))
    assert bad_memory["loki.memory_request"] == "Use memory like 256Mi or 1Gi."
    below = problems(alertmanager=Resources("10m", "256Mi", "128Mi"))
    assert below["alertmanager.memory_limit"] == "The limit can't be below the request (256Mi)."
    assert not problems(alertmanager=Resources("10m", "1024Mi", "1Gi"))


def test_no_default_storage_class_turns_persistence_off():
    s, warnings = effective_settings(InstallSettings(), facts(default_storage_class=None))
    assert s.persist is False
    assert warnings == [
        (
            "This cluster has no default storage class, so the tools keep their data only until "
            "their Pods restart."
        )
    ]
    assert warnings == [messages.NO_STORAGE_CLASS]
    metrics = values_for("omnikrux-metrics", s, namespace="monitoring", cluster_name="k")
    assert "storageSpec" not in metrics["prometheus"]["prometheusSpec"]
    assert "storage" not in metrics["alertmanager"]["alertmanagerSpec"]
    loki = values_for("omnikrux-loki", s, namespace="monitoring", cluster_name="k")
    assert loki["singleBinary"]["persistence"]["enabled"] is False
    assert loki["singleBinary"]["extraVolumes"] == [{"name": "data", "emptyDir": {}}]
    assert loki["singleBinary"]["extraVolumeMounts"] == [{"name": "data", "mountPath": "/var/loki"}]

    kept, none = effective_settings(InstallSettings(), facts())
    assert kept.persist is True and none == []
    loki = values_for("omnikrux-loki", kept, namespace="monitoring", cluster_name="k")
    assert "extraVolumes" not in loki["singleBinary"]
    assert "extraVolumeMounts" not in loki["singleBinary"]


def test_metrics_values_turn_off_grafana_and_select_our_alertmanagerconfigs():
    v = values_for("omnikrux-metrics", InstallSettings(), namespace="obs", cluster_name="k")
    assert v["fullnameOverride"] == "omnikrux-metrics"
    assert v["grafana"] == {"enabled": False}
    assert v["crds"] == {"enabled": False}
    assert v["defaultRules"] == {"create": False}
    for name in ("kubeEtcd", "kubeScheduler", "kubeControllerManager", "kubeProxy"):
        assert v[name] == {"enabled": False}
    prom = v["prometheus"]["prometheusSpec"]
    assert prom["retention"] == "7d"
    assert prom["resources"] == {
        "requests": {"cpu": "200m", "memory": "512Mi"},
        "limits": {"memory": "2Gi"},
    }
    assert prom["storageSpec"]["volumeClaimTemplate"]["spec"] == {
        "accessModes": ["ReadWriteOnce"],
        "resources": {"requests": {"storage": "20Gi"}},
    }
    am = v["alertmanager"]["alertmanagerSpec"]
    assert am["resources"]["limits"] == {"memory": "128Mi"}
    assert am["storage"]["volumeClaimTemplate"]["spec"]["resources"]["requests"] == {
        "storage": "1Gi"
    }
    assert am["alertmanagerConfigSelector"] == {
        "matchLabels": {"app.kubernetes.io/managed-by": "omnikrux"}
    }
    assert am["alertmanagerConfigNamespaceSelector"] == {
        "matchLabels": {"kubernetes.io/metadata.name": "obs"}
    }
    assert am["alertmanagerConfigMatcherStrategy"] == {"type": "None"}
    assert v["omnikrux"] == {"managedBy": "omnikrux"}


def test_loki_values_are_single_binary_with_retention():
    v = values_for("omnikrux-loki", InstallSettings(), namespace="monitoring", cluster_name="k")
    assert v["fullnameOverride"] == "omnikrux-loki"
    assert v["deploymentMode"] == "SingleBinary"
    assert v["loki"]["auth_enabled"] is False
    assert v["loki"]["commonConfig"] == {"replication_factor": 1}
    assert v["loki"]["storage"] == {"type": "filesystem"}
    assert v["loki"]["schemaConfig"]["configs"] == [
        {
            "from": "2024-04-01",
            "store": "tsdb",
            "object_store": "filesystem",
            "schema": "v13",
            "index": {"prefix": "index_", "period": "24h"},
        }
    ]
    assert v["loki"]["limits_config"]["retention_period"] == "168h"
    assert v["loki"]["compactor"] == {
        "retention_enabled": True,
        "delete_request_store": "filesystem",
    }
    assert v["singleBinary"]["replicas"] == 1
    assert v["singleBinary"]["persistence"] == {"enabled": True, "size": "10Gi"}
    assert v["singleBinary"]["resources"]["requests"] == {"cpu": "100m", "memory": "256Mi"}
    for part in ("read", "write", "backend"):
        assert v[part] == {"replicas": 0}
    for part in ("gateway", "chunksCache", "resultsCache", "lokiCanary", "test", "minio"):
        assert v[part] == {"enabled": False}
    thirty = values_for(
        "omnikrux-loki",
        replace(InstallSettings(), retention_days=30),
        namespace="monitoring",
        cluster_name="k",
    )
    assert thirty["loki"]["limits_config"]["retention_period"] == "720h"


EXPECTED_ALLOY = """discovery.kubernetes "pods" {
  role = "pod"
}

discovery.relabel "pods" {
  targets = discovery.kubernetes.pods.targets
  rule { source_labels = ["__meta_kubernetes_namespace"] target_label = "namespace" }
  rule { source_labels = ["__meta_kubernetes_pod_name"] target_label = "pod" }
  rule { source_labels = ["__meta_kubernetes_pod_container_name"] target_label = "container" }
  rule { source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name"] target_label = "app" }
  rule { source_labels = ["__meta_kubernetes_pod_node_name"] target_label = "node" }
}

loki.source.kubernetes "pods" {
  targets    = discovery.relabel.pods.output
  forward_to = [loki.write.omnikrux.receiver]
}

loki.write "omnikrux" {
  endpoint {
    url = "http://omnikrux-loki.monitoring.svc:3100/loki/api/v1/push"
  }
  external_labels = { cluster = "kind-omnikrux-dev" }
}
"""


def test_alloy_config_pushes_to_the_installed_loki():
    assert alloy_config("monitoring", "kind-omnikrux-dev") == EXPECTED_ALLOY
    quoted = alloy_config("obs", 'my "prod" \\ cluster')
    assert 'external_labels = { cluster = "my \\"prod\\" \\\\ cluster" }' in quoted
    assert "omnikrux-loki.obs.svc:3100" in quoted
    v = values_for("omnikrux-alloy", InstallSettings(), namespace="monitoring", cluster_name="x")
    assert v["alloy"]["configMap"] == {
        "create": True,
        "content": alloy_config("monitoring", "x"),
    }
    assert v["controller"] == {"type": "deployment", "replicas": 1}
    assert v["crds"] == {"create": False}
    assert v["fullnameOverride"] == "omnikrux-alloy"


def test_releases_name_what_each_chart_creates():
    (metrics,) = RELEASES["metrics"]
    assert metrics.release == "omnikrux-metrics" and metrics.chart == "kube-prometheus-stack"
    assert [(w.kind, w.name, w.made_by_operator) for w in metrics.workloads] == [
        ("Deployment", "omnikrux-metrics-operator", False),
        ("Deployment", "omnikrux-metrics-kube-state-metrics", False),
        ("DaemonSet", "omnikrux-metrics-prometheus-node-exporter", False),
        ("StatefulSet", "prometheus-omnikrux-metrics-prometheus", True),
        ("StatefulSet", "alertmanager-omnikrux-metrics-alertmanager", True),
    ]
    assert metrics.services == {
        "prometheus": ("omnikrux-metrics-prometheus", "9090"),
        "alertmanager": ("omnikrux-metrics-alertmanager", "9093"),
    }
    loki, alloy = RELEASES["logs"]
    assert loki.services == {"loki": ("omnikrux-loki", "3100")}
    assert [w.name for w in alloy.workloads] == ["omnikrux-alloy"]
    assert alloy.services == {}


def test_objects_sentence_counts_by_kind():
    def many(kind: str, n: int) -> list[ObjectRef]:
        return [ObjectRef(kind, f"{kind}-{i}", "monitoring") for i in range(n)]

    objects = [
        *many("ServiceMonitor", 14),
        *many("Prometheus", 1),
        *many("Alertmanager", 1),
        *many("Deployment", 2),
        *many("DaemonSet", 1),
        *many("Service", 6),
        *many("PodSecurityPolicy", 4),
        *many("Ingress", 5),
    ]
    assert objects_sentence(objects) == (
        "2 Deployments, 1 DaemonSet, 6 Services, 14 ServiceMonitors, 1 Prometheus, "
        "1 Alertmanager and 9 other objects"
    )
    assert objects_sentence(many("Role", 1) + many("ClusterRoleBinding", 2)) == (
        "2 cluster-wide roles and bindings and 1 role or binding"
    )
    assert objects_sentence(many("Deployment", 1)) == "1 Deployment"
    assert objects_sentence(many("Ingress", 1)) == "1 other object"
    assert objects_sentence([]) == "no objects"
