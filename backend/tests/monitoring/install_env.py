"""Helpers for the install job's tests (and Tasks 7–8): plan an install through the API, wait for
a job, make the installed workloads ready on the fake Kubernetes API, and a FakeHelm whose
upgrades leave Helm's release records on that API and whose uninstalls take them (and the
workloads) away, as the real Helm does."""

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass

import yaml

from omnikrux.monitoring.install.helm import HelmResult
from omnikrux.monitoring.install.pins import CHARTS
from omnikrux.monitoring.install.values import RELEASES
from tests.fakekube import FakeKubeApi, FakeResource, helm_release_secret, storage_class
from tests.monitoring.fake_helm import FakeHelm

PLAN = "/api/monitoring/install/plan"
JOBS = "/api/actions/jobs"
CRD_NAMES = (
    "alertmanagerconfigs.monitoring.coreos.com",
    "alertmanagers.monitoring.coreos.com",
    "prometheuses.monitoring.coreos.com",
    "prometheusrules.monitoring.coreos.com",
    "servicemonitors.monitoring.coreos.com",
)
OPERATOR_VERSION = "0.95.1"
_KIND_KEYS = {
    "Deployment": "deployments.apps",
    "StatefulSet": "statefulsets.apps",
    "DaemonSet": "daemonsets.apps",
}
_CHART_OF = {spec.release: spec.chart for specs in RELEASES.values() for spec in specs}


def chart_crd(name: str, version: str | None = OPERATOR_VERSION) -> dict:
    annotations = {"operator.prometheus.io/version": version} if version is not None else {}
    plural, group = name.split(".", 1)
    return {
        "apiVersion": "apiextensions.k8s.io/v1",
        "kind": "CustomResourceDefinition",
        "metadata": {"name": name, "annotations": annotations},
        "spec": {"group": group, "names": {"plural": plural}, "scope": "Namespaced"},
    }


def prepare_install(fake_api: FakeKubeApi, fake_helm: FakeHelm) -> None:
    """A default storage class on the cluster; `helm show crds` answers five Prometheus Operator
    CRDs; upgrades write Helm's release records (`helm_writes_releases`)."""
    fake_api.objects["storageclasses.storage.k8s.io"][("", "standard")] = storage_class(
        "standard", default=True
    )
    crds = [chart_crd(name) for name in CRD_NAMES]
    fake_helm.script["show"] = HelmResult(0, yaml.safe_dump_all(crds, sort_keys=False), "")
    helm_writes_releases(fake_helm, fake_api)


def _namespace(args: list[str]) -> str:
    return args[args.index("--namespace") + 1]


def write_release(
    fake_api: FakeKubeApi, namespace: str, release: str, revision: int, status: str
) -> None:
    chart = _CHART_OF[release]
    fake_api.objects["secrets"][(namespace, f"sh.helm.release.v1.{release}.v{revision}")] = (
        helm_release_secret(
            namespace, release, revision, status, chart=chart, version=CHARTS[chart].version
        )
    )


def helm_writes_releases(
    fake_helm: FakeHelm,
    fake_api: FakeKubeApi,
    *,
    fail: dict[str, str] | None = None,
) -> None:
    """Script `upgrade`: each release gets its next revision as a release record (status
    `deployed`); a release in `fail` gets a `failed` record and Helm's error (`fail[release]`,
    its stderr) with exit code 1."""
    failing = fail or {}

    async def upgrade(args: list[str]) -> HelmResult:
        release, namespace = args[2], _namespace(args)
        revision = fake_helm.releases.get((release, namespace), 0) + 1
        if release in failing:
            write_release(fake_api, namespace, release, revision, "failed")
            fake_helm.releases[(release, namespace)] = revision
            return HelmResult(1, "", failing[release])
        write_release(fake_api, namespace, release, revision, "deployed")
        return HelmResult(0, f'Release "{release}" has been upgraded.\n', "")

    fake_helm.script["upgrade"] = upgrade


def helm_uninstall_removes(
    fake_helm: FakeHelm, fake_api: FakeKubeApi, *, fail: dict[str, str] | None = None
) -> None:
    """Script `uninstall`: the release's records and the workloads it ran leave the fake API (as
    Helm and the garbage collector do); a release with no record answers Helm's not-found error;
    a release in `fail` answers `fail[release]` (its stderr) with exit code 1."""
    failing = fail or {}

    async def uninstall(args: list[str]) -> HelmResult:
        release, namespace = args[1], _namespace(args)
        if release in failing:
            return HelmResult(1, "", failing[release])
        prefix = f"sh.helm.release.v1.{release}.v"
        records = [
            k for k in fake_api.objects["secrets"] if k[0] == namespace and k[1].startswith(prefix)
        ]
        if not records:
            return HelmResult(
                1, "", f"Error: uninstall: Release not loaded: {release}: release: not found\n"
            )
        for key in records:
            del fake_api.objects["secrets"][key]
        for specs in RELEASES.values():
            for spec in specs:
                if spec.release == release:
                    for w in spec.workloads:
                        fake_api.objects[_KIND_KEYS[w.kind]].pop((namespace, w.name), None)
        fake_helm.releases.pop((release, namespace), None)
        return HelmResult(0, f'release "{release}" uninstalled\n', "")

    fake_helm.script["uninstall"] = uninstall


def data_volume(fake_api: FakeKubeApi, namespace: str, name: str, instance: str) -> None:
    """A PersistentVolumeClaim labelled as a StatefulSet of `instance` labels its claims."""
    fake_api.objects["persistentvolumeclaims"][(namespace, name)] = {
        "apiVersion": "v1",
        "kind": "PersistentVolumeClaim",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "uid": f"u-pvc-{name}",
            "labels": {"app.kubernetes.io/instance": instance},
        },
        "spec": {"accessModes": ["ReadWriteOnce"]},
    }


def contact_settings(fake_api: FakeKubeApi, namespace: str, *, ours: bool = True) -> None:
    """OmniKrux's AlertmanagerConfig and its Secret (served kind added), labelled as OmniKrux's
    unless `ours` is False."""
    group = "monitoring.coreos.com"
    if not any(r.plural == "alertmanagerconfigs" for r in fake_api.resources):
        fake_api.resources.append(
            FakeResource(group, "v1alpha1", "alertmanagerconfigs", "AlertmanagerConfig", True)
        )
    labels = {"app.kubernetes.io/managed-by": "omnikrux"} if ours else {}
    meta = {"name": "omnikrux-contact-points", "namespace": namespace, "labels": labels}
    fake_api.objects[f"alertmanagerconfigs.{group}"][(namespace, "omnikrux-contact-points")] = {
        "apiVersion": f"{group}/v1alpha1",
        "kind": "AlertmanagerConfig",
        "metadata": {**meta, "uid": "u-amc"},
        "spec": {"route": {"receiver": "x"}, "receivers": [{"name": "x"}]},
    }
    fake_api.objects["secrets"][(namespace, "omnikrux-contact-points")] = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {**meta, "uid": "u-amc-secret"},
        "data": {},
    }


def _labels(release: str, name: str) -> dict[str, str]:
    return {"app.kubernetes.io/instance": release, "app.kubernetes.io/name": name}


def rolled_out(kind: str, *, ready: bool, generation: int = 1) -> dict:
    """A workload's status with its current version (`generation`) rolled out on one replica
    (Node): ready, or created but not ready."""
    n = 1 if ready else 0
    if kind == "DaemonSet":
        return {
            "observedGeneration": generation,
            "desiredNumberScheduled": 1,
            "currentNumberScheduled": 1,
            "updatedNumberScheduled": 1,
            "numberReady": n,
            "numberAvailable": n,
        }
    status = {
        "observedGeneration": generation,
        "replicas": 1,
        "updatedReplicas": 1,
        "readyReplicas": n,
    }
    if kind == "Deployment":
        status["availableReplicas"] = n
    else:
        status["currentRevision"] = status["updateRevision"] = f"{generation}"
    return status


def workload(
    kind: str, namespace: str, name: str, release: str, *, ready: bool, generation: int = 1
) -> dict:
    labels = _labels(release, name)
    status = rolled_out(kind, ready=ready, generation=generation)
    return {
        "apiVersion": "apps/v1",
        "kind": kind,
        "metadata": {
            "name": name,
            "namespace": namespace,
            "uid": f"u-{kind}-{name}",
            "generation": generation,
        },
        "spec": {
            **({} if kind == "DaemonSet" else {"replicas": 1}),
            "selector": {"matchLabels": labels},
            "template": {"metadata": {"labels": labels}},
        },
        "status": status,
    }


def mark_all_ready(fake_api: FakeKubeApi, namespace: str, *, except_: tuple[str, ...] = ()) -> None:
    """Every workload of every release ready in `namespace` (those named in `except_` are made
    but not ready)."""
    for specs in RELEASES.values():
        for spec in specs:
            for w in spec.workloads:
                fake_api.objects[_KIND_KEYS[w.kind]][(namespace, w.name)] = workload(
                    w.kind, namespace, w.name, spec.release, ready=w.name not in except_
                )


def waiting_pod(namespace: str, name: str, labels: dict, reason: str, message: str) -> dict:
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {"name": name, "namespace": namespace, "labels": labels, "uid": f"u-{name}"},
        "spec": {"containers": [{"name": "main", "image": "example.test/loki:x"}]},
        "status": {
            "phase": "Pending",
            "containerStatuses": [
                {
                    "name": "main",
                    "ready": False,
                    "state": {"waiting": {"reason": reason, "message": message}},
                }
            ],
        },
    }


async def install_plan(
    http, cluster_id: str, components: list[str], *, project_id=None, settings=None
) -> dict:
    """The install review's plan (as `POST /api/monitoring/install/plan` answers it)."""
    body: dict = {"cluster_id": cluster_id, "components": components}
    if project_id is not None:
        body["project_id"] = project_id
    if settings is not None:
        body["settings"] = settings
    r = await http.post(PLAN, json=body)
    assert r.status_code == 200, r.text
    return r.json()["plan"]


async def apply(http, plan: dict) -> dict:
    r = await http.post(f"/api/actions/{plan['plan_id']}/apply", json={})
    assert r.status_code == 200, r.text
    return r.json()


async def wait_job(http, job_id: str, timeout: float = 10) -> dict:
    """The job once it has ended (a test failure after `timeout` seconds)."""
    deadline = time.monotonic() + timeout
    while True:
        job = (await http.get(f"{JOBS}/{job_id}")).json()
        if job["state"] != "running":
            return job
        assert time.monotonic() < deadline, f"the job is still running: {job}"
        await asyncio.sleep(0.02)


async def wait_until(check: Callable[[], bool], timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while not check():
        assert time.monotonic() < deadline, "the condition never held"
        await asyncio.sleep(0.01)


@dataclass(frozen=True)
class InstalledCluster:
    """A cluster with a finished install of both components in `namespace` and its sources."""

    cluster_id: str
    namespace: str
    project_id: str | None
    sources: dict[str, str]  # prometheus, alertmanager, loki -> source id
    job: dict
