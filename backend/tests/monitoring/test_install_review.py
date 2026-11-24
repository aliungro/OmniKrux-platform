"""The install review: a server-built plan (M4's `make_plan`) that reads the cluster, renders each
chart through the (fake) Helm runner, and blocks or warns in words before anything is written."""

import base64
import gzip
import json

import pytest
import yaml

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.monitoring.install.facts import decode_release
from omnikrux.monitoring.install.helm import HelmResult
from omnikrux.monitoring.install.pins import CHARTS
from omnikrux.monitoring.install.settings import InstallSettings
from omnikrux.monitoring.install.tools import ToolsCheck, ToolsStatus
from tests.actions.clusters import kubeconfig_named
from tests.fakekube import (
    CRDS_KEY,
    helm_release_secret,
    prometheus_operator_deployment,
    storage_class,
)

PLAN = "/api/monitoring/install/plan"
TOOLS = "/api/monitoring/install/tools"
PRODUCTION = "This is a production cluster."
OPERATOR_VERSION = "0.95.1"
CRD_NAMES = (
    "alertmanagerconfigs.monitoring.coreos.com",
    "alertmanagers.monitoring.coreos.com",
    "prometheuses.monitoring.coreos.com",
    "prometheusrules.monitoring.coreos.com",
    "servicemonitors.monitoring.coreos.com",
)
KPS = CHARTS["kube-prometheus-stack"]


def _doc(kind: str, name: str, namespace: str | None = "monitoring") -> dict:
    meta: dict = {"name": name}
    if namespace is not None:
        meta["namespace"] = namespace
    return {"apiVersion": "v1", "kind": kind, "metadata": meta}


RENDERED = {
    "omnikrux-metrics": [
        _doc("ServiceAccount", "omnikrux-metrics-operator"),
        _doc("ClusterRole", "omnikrux-metrics-operator", None),
        _doc("ClusterRoleBinding", "omnikrux-metrics-operator", None),
        _doc("Service", "omnikrux-metrics-prometheus"),
        _doc("Service", "omnikrux-metrics-alertmanager"),
        _doc("Deployment", "omnikrux-metrics-operator"),
        _doc("Deployment", "omnikrux-metrics-kube-state-metrics"),
        _doc("DaemonSet", "omnikrux-metrics-prometheus-node-exporter"),
        _doc("Prometheus", "omnikrux-metrics-prometheus"),
        _doc("Alertmanager", "omnikrux-metrics-alertmanager"),
        _doc("ServiceMonitor", "omnikrux-metrics-kubelet"),
    ],
    "omnikrux-loki": [
        _doc("ConfigMap", "omnikrux-loki"),
        _doc("Service", "omnikrux-loki"),
        _doc("StatefulSet", "omnikrux-loki"),
    ],
    "omnikrux-alloy": [
        _doc("ServiceAccount", "omnikrux-alloy"),
        _doc("ConfigMap", "omnikrux-alloy"),
        _doc("ClusterRole", "omnikrux-alloy", None),
        _doc("ClusterRoleBinding", "omnikrux-alloy", None),
        _doc("Deployment", "omnikrux-alloy"),
    ],
}


def _crd(name: str, version: str | None) -> dict:
    annotations = {"operator.prometheus.io/version": version} if version is not None else {}
    plural, group = name.split(".", 1)
    return {
        "apiVersion": "apiextensions.k8s.io/v1",
        "kind": "CustomResourceDefinition",
        "metadata": {"name": name, "annotations": annotations},
        "spec": {"group": group, "names": {"plural": plural}},
    }


def _yaml(docs: list[dict]) -> str:
    return yaml.safe_dump_all(docs, sort_keys=False)


@pytest.fixture
def env(monitoring_app, kube_cluster, fake_api, fake_helm):
    """The app, a registered cluster on the fake API, and a FakeHelm that renders each release
    and answers `show crds` with five Prometheus Operator CRDs."""
    http, app = monitoring_app
    for release, docs in RENDERED.items():
        fake_helm.rendered[release] = _yaml(docs)
    crds = [_crd(name, OPERATOR_VERSION) for name in CRD_NAMES]
    fake_helm.script["show"] = HelmResult(0, _yaml(crds), "")
    return http, app, kube_cluster, fake_api, fake_helm


def default_class(fake_api) -> None:
    fake_api.objects["storageclasses.storage.k8s.io"][("", "standard")] = storage_class(
        "standard", default=True
    )


def namespace(fake_api, name: str = "monitoring") -> None:
    fake_api.objects["namespaces"][("", name)] = {
        "apiVersion": "v1",
        "kind": "Namespace",
        "metadata": {"name": name, "uid": f"u-ns-{name}"},
    }


async def plan_for(http, cluster_id: str, **body) -> dict:
    r = await http.post(PLAN, json={"cluster_id": cluster_id, **body})
    assert r.status_code == 200, r.text
    return r.json()


async def test_review_shows_what_will_be_created(env):
    http, _, cluster, fake_api, fake_helm = env
    default_class(fake_api)
    out = await plan_for(http, cluster, components=["metrics", "logs"])
    plan = out["plan"]
    assert (plan["action"], plan["kind"], plan["target"]["name"]) == (
        "install",
        "Namespace",
        "monitoring",
    )
    assert plan["target"]["kind_key"] == "namespaces" and plan["target"]["namespace"] is None
    assert plan["title"] == "Install monitoring tools in monitoring"
    assert plan["apply_label"] == "Install"
    name = plan["cluster"]["name"]
    assert plan["summary"] == [
        (
            "Installs Prometheus, Alertmanager, node-exporter and kube-state-metrics "
            f"(kube-prometheus-stack {KPS.version}), and Loki 3.6.16 in single-binary mode and "
            f"Grafana Alloy v1.21.3 to collect Pod logs into {name}, namespace monitoring. "
            "The cluster pulls the container images itself."
        ),
        (
            f"Helm release omnikrux-metrics: chart kube-prometheus-stack {KPS.version}; creates "
            "2 Deployments, 1 DaemonSet, 2 Services, 1 ServiceAccount, "
            "2 cluster-wide roles and bindings, 1 ServiceMonitor, 1 Prometheus and 1 Alertmanager."
        ),
        (
            "Helm release omnikrux-loki: chart loki 7.5.0; creates 1 StatefulSet, 1 Service and "
            "1 ConfigMap."
        ),
        (
            "Helm release omnikrux-alloy: chart alloy 1.15.0; creates 1 Deployment, 1 ConfigMap, "
            "1 ServiceAccount and 2 cluster-wide roles and bindings."
        ),
        "Creates the namespace monitoring.",
        (
            "Creates 5 and updates 0 CustomResourceDefinitions of the Prometheus Operator "
            "(monitoring.coreos.com)."
        ),
        (
            "Keeps data for 7 days on volumes: Prometheus 20Gi, Loki 10Gi, Alertmanager 1Gi "
            "(standard storage class)."
        ),
        "Then OmniKrux connects Prometheus, Alertmanager and Loki as sources.",
    ]
    after = plan["diff"]["after"]
    assert "Deployment monitoring/omnikrux-alloy" in after
    assert "ClusterRole omnikrux-alloy" in after
    assert "prometheuses.monitoring.coreos.com" in after
    assert "managedBy: omnikrux" in after
    assert plan["diff"]["before"] == ""
    assert plan["blocked"] == [] and plan["warnings"] == [] and plan["confirm_text"] is None
    assert out["problems"] == []
    assert out["facts"] == {"default_storage_class": "standard", "kube_version": "v1.31.0"}
    assert out["settings"]["namespace"] == "monitoring"
    assert out["settings"]["retention_days"] == 7
    assert out["settings"]["prometheus"] == {
        "cpu_request": "200m",
        "memory_request": "512Mi",
        "memory_limit": "2Gi",
    }
    # Every chart is rendered with the cluster's version and our CRD API versions; nothing is
    # written to the cluster, and Helm never got a kubeconfig.
    templates = [c for c in fake_helm.calls if c.args[0] == "template"]
    assert sorted(c.args[1] for c in templates) == [
        "omnikrux-alloy",
        "omnikrux-loki",
        "omnikrux-metrics",
    ]
    assert all("v1.31.0" in c.args for c in templates)
    assert all("monitoring.coreos.com/v1alpha1" in c.args for c in templates)
    assert all(c.kubeconfig_text is None for c in fake_helm.calls)
    assert fake_api.created_objects == [] and fake_api.writes == []


async def test_plan_state_is_kept_on_the_server(env):
    http, app, cluster, fake_api, _ = env
    default_class(fake_api)
    out = await plan_for(http, cluster, components=["logs"])
    stored = app.state.plans.peek(out["plan"]["plan_id"])
    state = stored.planned.state
    assert state["components"] == ["logs"]
    assert state["settings"]["retention_days"] == 7 and state["settings"]["persist"] is True
    assert state["charts"] == {
        "omnikrux-loki": CHARTS["loki"].sha256,
        "omnikrux-alloy": CHARTS["alloy"].sha256,
    }
    assert state["revisions"] == {"omnikrux-loki": None, "omnikrux-alloy": None}
    assert state["crds"] == [] and state["project_id"] is None
    assert len(state["values_digest"]) == 64
    assert not any("CustomResourceDefinitions" in line for line in out["plan"]["summary"])
    assert out["plan"]["summary"][-2] == (
        "Keeps data for 7 days on volumes: Loki 10Gi (standard storage class)."
    )
    assert out["plan"]["summary"][-1] == "Then OmniKrux connects Loki as a source."


async def test_foreign_operator_blocks(env):
    http, _, cluster, fake_api, _ = env
    default_class(fake_api)
    fake_api.objects["deployments.apps"][("other", "kps-operator")] = (
        prometheus_operator_deployment("other", "kps-operator", instance="kps")
    )
    plan = (await plan_for(http, cluster, components=["metrics"]))["plan"]
    assert plan["blocked"] == [
        (
            "This cluster already runs a Prometheus Operator (other/kps-operator) that OmniKrux "
            "didn't install. A second one would fight over the same objects. Connect the Prometheus "
            "it runs instead."
        )
    ]


async def test_our_own_operator_does_not_block(env):
    http, _, cluster, fake_api, _ = env
    default_class(fake_api)
    fake_api.objects["deployments.apps"][("monitoring", "omnikrux-metrics-operator")] = (
        prometheus_operator_deployment(
            "monitoring", "omnikrux-metrics-operator", instance="omnikrux-metrics"
        )
    )
    plan = (await plan_for(http, cluster, components=["metrics"]))["plan"]
    assert plan["blocked"] == []


async def test_foreign_release_with_our_name_blocks(env):
    http, _, cluster, fake_api, _ = env
    default_class(fake_api)
    namespace(fake_api)
    secret = helm_release_secret(
        "monitoring", "omnikrux-loki", 1, "deployed", chart="loki", version="6.0.0",
        managed_by_omnikrux=False,
    )  # fmt: skip
    fake_api.objects["secrets"][("monitoring", secret["metadata"]["name"])] = secret
    plan = (await plan_for(http, cluster, components=["logs"]))["plan"]
    assert plan["blocked"] == [
        (
            "A Helm release named omnikrux-loki already exists in monitoring, and OmniKrux didn't "
            "install it. Pick another namespace."
        )
    ]
    assert plan["title"] == "Install monitoring tools in monitoring"


async def test_old_crds_are_updated_in_the_review(env):
    http, app, cluster, fake_api, _ = env
    default_class(fake_api)
    name = "prometheuses.monitoring.coreos.com"
    fake_api.objects[CRDS_KEY][("", name)] = _crd(name, "0.70.0")
    out = await plan_for(http, cluster, components=["metrics"])
    plan = out["plan"]
    assert (
        "Creates 4 and updates 1 CustomResourceDefinitions of the Prometheus Operator "
        "(monitoring.coreos.com)."
    ) in plan["summary"]
    state = app.state.plans.peek(plan["plan_id"]).planned.state
    assert state["crds"] == sorted(CRD_NAMES)


async def test_crds_at_the_chart_version_are_left_alone(env):
    http, app, cluster, fake_api, _ = env
    default_class(fake_api)
    for name, version in (
        ("prometheuses.monitoring.coreos.com", "0.70.0"),
        ("alertmanagers.monitoring.coreos.com", OPERATOR_VERSION),
    ):
        fake_api.objects[CRDS_KEY][("", name)] = _crd(name, version)
    plan = (await plan_for(http, cluster, components=["metrics"]))["plan"]
    assert (
        "Creates 3 and updates 1 CustomResourceDefinitions of the Prometheus Operator "
        "(monitoring.coreos.com)."
    ) in plan["summary"]
    state = app.state.plans.peek(plan["plan_id"]).planned.state
    assert "alertmanagers.monitoring.coreos.com" not in state["crds"]
    assert len(state["crds"]) == 4


async def test_no_default_storage_class_keeps_data_in_memory(env):
    http, app, cluster, fake_api, fake_helm = env
    fake_api.objects["storageclasses.storage.k8s.io"][("", "slow")] = storage_class(
        "slow", default=False
    )
    out = await plan_for(http, cluster, components=["metrics", "logs"])
    plan = out["plan"]
    assert plan["warnings"] == [
        (
            "This cluster has no default storage class, so the tools keep their data only until "
            "their Pods restart."
        )
    ]
    assert "Keeps data for 7 days, only until the Pods restart." in plan["summary"]
    assert plan["blocked"] == []
    assert out["facts"]["default_storage_class"] is None
    # The form keeps what the user asked for; the plan installs without volumes.
    assert out["settings"]["persist"] is True
    assert app.state.plans.peek(plan["plan_id"]).planned.state["settings"]["persist"] is False
    loki_values = [c for c in fake_helm.calls if c.args[:2] == ["template", "omnikrux-loki"]]
    assert loki_values
    assert "storageSpec" not in plan["diff"]["after"]


async def test_chart_refusal_blocks_with_its_words(env):
    http, _, cluster, fake_api, fake_helm = env
    default_class(fake_api)
    fake_helm.script["template"] = HelmResult(
        1,
        "",
        "Error: chart requires kubeVersion: >=1.25.0-0 which is incompatible with Kubernetes "
        "v1.24.0\n",
    )
    plan = (await plan_for(http, cluster, components=["metrics"]))["plan"]
    assert plan["blocked"] == [
        (
            "Helm couldn't read the kube-prometheus-stack chart with these settings: chart requires "
            "kubeVersion: >=1.25.0-0 which is incompatible with Kubernetes v1.24.0"
        )
    ]
    assert not any(line.startswith("Helm release ") for line in plan["summary"])


async def test_settings_problems_come_back_by_field(env):
    http, _, cluster, fake_api, fake_helm = env
    default_class(fake_api)
    out = await plan_for(http, cluster, components=["metrics"], settings={"retention_days": 0})
    assert out["problems"] == [
        {"field": "retention_days", "message": "Keep data for 1 to 90 days."}
    ]
    assert out["plan"]["blocked"] == ["Keep data for 1 to 90 days."]
    assert out["settings"]["retention_days"] == 0
    assert [c for c in fake_helm.calls if c.args[0] == "template"] == []


async def test_a_bad_namespace_is_a_problem_not_a_422(env):
    http, _, cluster, fake_api, _ = env
    default_class(fake_api)
    out = await plan_for(
        http, cluster, components=["logs"], settings={"namespace": "Not/A namespace"}
    )
    message = "Use a namespace name: lower-case letters, digits and -, up to 63 characters."
    assert out["problems"] == [{"field": "namespace", "message": message}]
    assert out["plan"]["blocked"] == [message]
    # Nothing the user typed reaches an API path.
    assert not any("Not" in path for path in fake_api.paths)


async def test_production_asks_for_the_namespace(monitoring_app, fake_api, fake_helm):
    http, app = monitoring_app
    [info] = await app.state.registry.upsert_from_kubeconfig(
        kubeconfig_named(fake_api, "prod-east"), rewrite_loopback=False, source=SOURCE_UPLOAD
    )
    assert info.environment.value == "production"
    default_class(fake_api)
    plan = (await plan_for(http, info.id, components=["logs"]))["plan"]
    assert plan["confirm_text"] == "monitoring"
    assert plan["warnings"][0] == PRODUCTION
    wrong = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={"confirm_text": "x"})
    assert wrong.status_code == 422
    assert wrong.json()["detail"] == "Type monitoring to confirm"


async def _record(app, cluster_id: str, **over) -> None:
    args = {
        "namespace": "monitoring",
        "components": ("metrics", "logs"),
        "settings": InstallSettings(retention_days=30),
        "charts": {key: pin.version for key, pin in CHARTS.items()},
    }
    args.update(over)
    installs = app.state.monitoring.installs
    await installs.begin(
        cluster_id,
        args["namespace"],
        args["components"],
        args["settings"],
        args["charts"],
        job_id="job-1",
        project_id=None,
    )
    if over.get("state", "installed") != "installing":
        await installs.finish(cluster_id, over.get("state", "installed"), None)


def _our_releases(fake_api, namespace: str = "monitoring", revision: int = 2) -> None:
    for release, chart in (
        ("omnikrux-metrics", "kube-prometheus-stack"),
        ("omnikrux-loki", "loki"),
        ("omnikrux-alloy", "alloy"),
    ):
        for rev in range(1, revision + 1):
            status = "deployed" if rev == revision else "superseded"
            secret = helm_release_secret(
                namespace, release, rev, status, chart=chart, version=CHARTS[chart].version
            )
            fake_api.objects["secrets"][(namespace, secret["metadata"]["name"])] = secret


async def test_existing_install_reads_as_update(env):
    http, app, cluster, fake_api, _ = env
    default_class(fake_api)
    namespace(fake_api)
    _our_releases(fake_api)
    await _record(app, cluster)
    # Without settings the review uses the stored ones.
    stored = await plan_for(http, cluster, components=["metrics"])
    assert stored["settings"]["retention_days"] == 30
    assert stored["plan"]["title"] == "Update monitoring tools in monitoring"
    assert stored["plan"]["apply_label"] == "Update"
    assert "Creates the namespace monitoring." not in stored["plan"]["summary"]
    # The record's components stay installed: logs are planned too.
    assert any(line.startswith("Helm release omnikrux-loki") for line in stored["plan"]["summary"])
    state = app.state.plans.peek(stored["plan"]["plan_id"]).planned.state
    assert state["components"] == ["metrics", "logs"]
    assert state["revisions"] == {
        "omnikrux-metrics": 2,
        "omnikrux-loki": 2,
        "omnikrux-alloy": 2,
    }
    changed = await plan_for(http, cluster, components=["metrics"], settings={"retention_days": 14})
    diff = changed["plan"]["diff"]
    assert "retention: 30d" in diff["before"] and "retention: 14d" in diff["after"]
    assert "omnikrux-loki" in diff["before"]
    assert changed["plan"]["blocked"] == []


async def test_install_in_another_namespace_blocks(env):
    http, app, cluster, fake_api, _ = env
    default_class(fake_api)
    await _record(app, cluster, namespace="obs", settings=InstallSettings(namespace="obs"))
    plan = (await plan_for(http, cluster, components=["logs"]))["plan"]
    # Without settings the record's namespace is used: asking for another one is what blocks.
    assert plan["target"]["name"] == "obs"
    other = (
        await plan_for(http, cluster, components=["logs"], settings={"namespace": "monitoring"})
    )["plan"]
    assert other["blocked"] == [
        (
            "OmniKrux already installed its tools in obs in this cluster. Update them there, or "
            "uninstall them first."
        )
    ]


def loki_statefulset(fake_api, size: str | None) -> None:
    """The installed Loki's StatefulSet, claiming a `size` data volume (none when None)."""
    claims = [] if size is None else [
        {
            "metadata": {"name": "storage"},
            "spec": {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": size}}},
        }
    ]  # fmt: skip
    fake_api.objects["statefulsets.apps"][("monitoring", "omnikrux-loki")] = {
        "apiVersion": "apps/v1",
        "kind": "StatefulSet",
        "metadata": {"name": "omnikrux-loki", "namespace": "monitoring", "uid": "u-sts-loki"},
        "spec": {"replicas": 1, "volumeClaimTemplates": claims},
    }


async def test_installed_loki_volume_cant_change(env):
    """Kubernetes never lets a StatefulSet's volume claim change: Helm would refuse the update
    half way, so the review says so before anything is written."""
    http, _, cluster, fake_api, _ = env
    default_class(fake_api)
    namespace(fake_api)
    loki_statefulset(fake_api, "10Gi")
    same = (await plan_for(http, cluster, components=["logs"]))["plan"]
    assert same["blocked"] == []
    smaller = await plan_for(http, cluster, components=["logs"], settings={"loki_storage": "2Gi"})
    assert smaller["plan"]["blocked"] == [
        (
            "Loki already keeps its data on a 10Gi volume, and its size can't change once Loki has "
            "it. Set Loki's storage back to 10Gi, or uninstall the tools and install them again."
        )
    ]
    in_memory = await plan_for(http, cluster, components=["logs"], settings={"persist": False})
    assert in_memory["plan"]["blocked"] == [
        (
            "Loki already keeps its data on a 10Gi volume, which can't be taken away once Loki has "
            "it. Turn on Keep data on volumes with Loki at 10Gi, or uninstall the tools and install "
            "them again."
        )
    ]
    # Metrics alone never touch Loki.
    metrics = await plan_for(
        http, cluster, components=["metrics"], settings={"loki_storage": "2Gi"}
    )
    assert metrics["plan"]["blocked"] == []
    loki_statefulset(fake_api, None)
    added = await plan_for(http, cluster, components=["logs"])
    assert added["plan"]["blocked"] == [
        (
            "Loki already runs without a data volume, and one can't be added once Loki runs. Turn "
            "off Keep data on volumes, or uninstall the tools and install them again."
        )
    ]


async def test_a_release_helm_never_finished_blocks(env):
    """A Helm stopped half way (killed, or OmniKrux stopped) leaves its record `pending-install`;
    Helm refuses to change that release again, so the review says how to get out."""
    http, app, cluster, fake_api, _ = env
    default_class(fake_api)
    namespace(fake_api)
    await _record(app, cluster, state="cancelled")
    secret = helm_release_secret(
        "monitoring", "omnikrux-metrics", 1, "pending-install", chart="kube-prometheus-stack",
        version=KPS.version,
    )  # fmt: skip
    fake_api.objects["secrets"][("monitoring", secret["metadata"]["name"])] = secret
    plan = (await plan_for(http, cluster, components=["metrics"]))["plan"]
    assert plan["blocked"] == [
        (
            "Helm's record of omnikrux-metrics says an earlier change never finished "
            "(pending-install), so Helm won't change it again. Uninstall the tools, then install "
            "them again."
        )
    ]
    # One someone else made isn't OmniKrux's to judge: it blocks as a foreign release.
    fake_api.objects["secrets"][("monitoring", secret["metadata"]["name"])] = helm_release_secret(
        "monitoring", "omnikrux-metrics", 1, "pending-install", chart="kube-prometheus-stack",
        version=KPS.version, managed_by_omnikrux=False,
    )  # fmt: skip
    plan = (await plan_for(http, cluster, components=["metrics"]))["plan"]
    assert not any("never finished" in line for line in plan["blocked"])


async def test_a_running_job_blocks(env):
    http, app, cluster, fake_api, _ = env
    default_class(fake_api)
    await _record(app, cluster, state="installing")
    plan = (await plan_for(http, cluster, components=["logs"]))["plan"]
    name = plan["cluster"]["name"]
    assert plan["blocked"] == [
        f"OmniKrux is installing in {name} right now. Wait for it to finish, or cancel it."
    ]


class MissingTools(ToolsCheck):
    def __init__(self):
        super().__init__(Settings(kubeconfig="", in_container=False))

    async def _check(self) -> ToolsStatus:
        return ToolsStatus(False, "Installing needs Helm (test).", None, None)


async def test_tools_missing_block_the_review(env):
    http, app, cluster, fake_api, fake_helm = env
    default_class(fake_api)
    app.state.monitoring.install_tools = MissingTools()
    plan = (await plan_for(http, cluster, components=["metrics", "logs"]))["plan"]
    assert plan["blocked"] == ["Installing needs Helm (test)."]
    assert fake_helm.calls == []
    tools = await http.get(TOOLS)
    assert tools.status_code == 200
    assert tools.json()["available"] is False
    assert tools.json()["message"] == "Installing needs Helm (test)."


async def test_tools_route_lists_the_pinned_charts(env):
    http, *_ = env
    r = await http.get(TOOLS)
    assert r.status_code == 200
    body = r.json()
    assert body["available"] is True and body["message"] is None
    assert body["helm_version"] == "v4.3.1"
    assert body["charts"] == [
        {"key": key, "version": pin.version, "app_version": pin.app_version}
        for key, pin in CHARTS.items()
    ]


async def test_project_is_named_and_unknowns_are_404(env, linked_project):
    http, _, cluster, fake_api, _ = env
    default_class(fake_api)
    plan = (
        await plan_for(http, cluster, components=["logs"], project_id=linked_project.project_id)
    )["plan"]
    assert plan["summary"][-1] == (
        f"Then OmniKrux connects Loki as a source and adds it to the project "
        f"{linked_project.project_name}."
    )
    gone = await http.post(PLAN, json={"cluster_id": "nope", "components": ["logs"]})
    assert gone.status_code == 404
    assert gone.json()["detail"] == "That cluster isn't connected to OmniKrux any more."
    nope = await http.post(
        PLAN, json={"cluster_id": cluster, "components": ["logs"], "project_id": "nope"}
    )
    assert nope.status_code == 404 and nope.json()["detail"] == "That project no longer exists."


async def test_components_are_one_or_two_distinct(env):
    http, _, cluster, *_ = env
    for components in ([], ["logs", "logs"], ["metrics", "logs", "metrics"], ["traces"]):
        r = await http.post(PLAN, json={"cluster_id": cluster, "components": components})
        assert r.status_code == 422, components


async def test_the_browser_cannot_ask_for_install(env):
    http, _, cluster, *_ = env
    for action in ("install", "uninstall"):
        r = await http.post(
            "/api/actions/plan",
            json={
                "action": action,
                "target": {"cluster_id": cluster, "kind_key": "namespaces", "name": "monitoring"},
            },
        )
        assert r.status_code == 422, action


async def test_install_routes_refuse_cross_origin(env):
    http, _, cluster, *_ = env
    evil = {"Origin": "http://evil.example"}
    for method, path in (("GET", TOOLS), ("POST", PLAN)):
        r = await http.request(
            method, path, headers=evil, json={"cluster_id": cluster, "components": ["logs"]}
        )
        assert r.status_code == 403, (method, path)
        assert r.json() == {"detail": "Cross-origin request refused"}


async def test_a_read_failure_says_what_failed(env):
    http, _, cluster, fake_api, _ = env
    fake_api.forbidden_kinds.add("storageclasses.storage.k8s.io")
    r = await http.post(PLAN, json={"cluster_id": cluster, "components": ["logs"]})
    assert r.status_code == 403
    assert r.json()["detail"].startswith("Not allowed to install Namespace monitoring")


def test_release_secrets_decode_with_and_without_gzip():
    secret = helm_release_secret(
        "monitoring", "omnikrux-loki", 3, "deployed", chart="loki", version="7.5.0"
    )
    ref = decode_release(secret)
    assert (ref.name, ref.revision, ref.status, ref.owner_label, ref.chart_version) == (
        "omnikrux-loki",
        3,
        "deployed",
        "omnikrux",
        "7.5.0",
    )
    plain = {"name": "x", "version": 1, "info": {"status": "failed"}, "config": {}}
    inner = base64.b64encode(json.dumps(plain).encode()).decode()
    raw = {
        "metadata": {"labels": {"name": "x", "version": "1", "status": "failed"}},
        "data": {"release": base64.b64encode(inner.encode()).decode()},
    }
    ref = decode_release(raw)
    assert (ref.revision, ref.status, ref.owner_label, ref.chart_version) == (
        1,
        "failed",
        None,
        None,
    )
    broken = {
        "metadata": {"labels": {"name": "x", "version": "2", "status": "deployed"}},
        "data": {"release": "not base64!"},
    }
    ref = decode_release(broken)
    assert (ref.revision, ref.status, ref.owner_label) == (2, "deployed", None)


# -- fix round 1 -------------------------------------------------------------------------------


def _release_secret(packed: bytes, *, name: str = "omnikrux-loki", revision: int = 1) -> dict:
    """A release Secret carrying `packed` as Helm's record (before Helm's and the API's base64)."""
    inner = base64.b64encode(packed).decode()
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": f"sh.helm.release.v1.{name}.v{revision}",
            "namespace": "monitoring",
            "labels": {
                "owner": "helm",
                "name": name,
                "status": "deployed",
                "version": str(revision),
            },
        },
        "data": {"release": base64.b64encode(inner.encode()).decode()},
    }


def _ours(pad: int = 0) -> bytes:
    """A release record carrying OmniKrux's marker, padded to more than `pad` bytes."""
    record = {"config": {"omnikrux": {"managedBy": "omnikrux"}}, "pad": " " * pad}
    return json.dumps(record).encode()


async def test_our_operator_in_another_namespace_is_foreign(env):
    http, _, cluster, fake_api, _ = env
    default_class(fake_api)
    fake_api.objects["deployments.apps"][("obs", "omnikrux-metrics-operator")] = (
        prometheus_operator_deployment(
            "obs", "omnikrux-metrics-operator", instance="omnikrux-metrics"
        )
    )
    plan = (await plan_for(http, cluster, components=["metrics"]))["plan"]
    assert plan["blocked"] == [
        (
            "This cluster already runs a Prometheus Operator (obs/omnikrux-metrics-operator) that "
            "OmniKrux didn't install. A second one would fight over the same objects. Connect the "
            "Prometheus it runs instead."
        )
    ]


async def test_newer_crds_are_never_downgraded(env):
    http, app, cluster, fake_api, _ = env
    default_class(fake_api)
    newer = "prometheuses.monitoring.coreos.com"
    older = "servicemonitors.monitoring.coreos.com"
    fake_api.objects[CRDS_KEY][("", newer)] = _crd(newer, "0.99.0")
    fake_api.objects[CRDS_KEY][("", older)] = _crd(older, "0.9.0")
    plan = (await plan_for(http, cluster, components=["metrics"]))["plan"]
    summary = plan["summary"]
    crd_line = (
        "Creates 3 and updates 1 CustomResourceDefinitions of the Prometheus Operator "
        "(monitoring.coreos.com)."
    )
    kept_line = (
        "Keeps the newer prometheuses.monitoring.coreos.com the cluster already has (0.99.0)."
    )
    assert summary[summary.index(crd_line) + 1] == kept_line
    state = app.state.plans.peek(plan["plan_id"]).planned.state
    assert newer not in state["crds"] and older in state["crds"] and len(state["crds"]) == 4
    assert newer not in plan["diff"]["after"]


async def test_an_unreadable_release_record_is_not_ours(env):
    http, _, cluster, fake_api, _ = env
    default_class(fake_api)
    namespace(fake_api)
    deep = b'{"a":' + b"[" * 200_000 + b"]" * 200_000 + b"}"
    secret = _release_secret(gzip.compress(deep))
    fake_api.objects["secrets"][("monitoring", secret["metadata"]["name"])] = secret
    r = await http.post(PLAN, json={"cluster_id": cluster, "components": ["logs"]})
    assert r.status_code == 200, r.text
    assert r.json()["plan"]["blocked"] == [
        (
            "A Helm release named omnikrux-loki already exists in monitoring, and OmniKrux didn't "
            "install it. Pick another namespace."
        )
    ]


def test_release_records_are_bounded_and_whole():
    small = decode_release(_release_secret(gzip.compress(_ours())))
    assert small.owner_label == "omnikrux"
    # Unpacked past 64 MiB: not read, so not ours (the record is still valid JSON with the marker).
    big = _ours(64 * 1024 * 1024)
    assert len(big) > 64 * 1024 * 1024
    huge = decode_release(_release_secret(gzip.compress(big, compresslevel=1)))
    assert (huge.owner_label, huge.revision, huge.status) == (None, 1, "deployed")
    # A gzip stream cut short is not read either, even when what came through is the marker.
    whole = gzip.compress(_ours(4096))
    cut = decode_release(_release_secret(whole[:-12]))
    assert cut.owner_label is None
    deep = b'{"a":' + b"[" * 200_000 + b"]" * 200_000 + b"}"
    assert decode_release(_release_secret(deep)).owner_label is None
    assert decode_release(_release_secret(b"[1, 2]")).owner_label is None


async def test_a_blocked_install_plan_is_refused_with_nothing_written(env):
    http, app, cluster, fake_api, fake_helm = env
    default_class(fake_api)
    fake_api.objects["deployments.apps"][("other", "kps-operator")] = (
        prometheus_operator_deployment("other", "kps-operator", instance="kps")
    )
    plan = (await plan_for(http, cluster, components=["metrics", "logs"]))["plan"]
    assert plan["blocked"]
    r = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={})
    assert r.status_code == 422
    assert r.json()["detail"] == " ".join(plan["blocked"])
    assert fake_api.created_objects == [] and fake_api.writes == []
    assert [c for c in fake_helm.calls if c.args[0] in ("upgrade", "uninstall")] == []
    assert (await app.state.audit.list(action="install")).records == []
    assert await app.state.monitoring.installs.get(cluster) is None


async def test_a_partial_settings_body_updates_the_installed_settings(env):
    http, app, cluster, fake_api, _ = env
    default_class(fake_api)
    installed = InstallSettings(namespace="obs", retention_days=30, prometheus_storage="50Gi")
    await _record(app, cluster, namespace="obs", settings=installed)
    out = await plan_for(
        http,
        cluster,
        components=["metrics"],
        settings={"retention_days": 14, "prometheus": {"cpu_request": "300m"}},
    )
    assert out["plan"]["target"]["name"] == "obs" and out["plan"]["blocked"] == []
    settings = out["settings"]
    assert (settings["namespace"], settings["retention_days"]) == ("obs", 14)
    assert settings["prometheus_storage"] == "50Gi"
    assert settings["prometheus"] == {
        "cpu_request": "300m",
        "memory_request": installed.prometheus.memory_request,
        "memory_limit": installed.prometheus.memory_limit,
    }
