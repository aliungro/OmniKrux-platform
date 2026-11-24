"""Uninstalling the monitoring tools OmniKrux installed: its own review (a server-built plan
through the action pipeline, so reviewed, confirmed and audited before anything is removed) and
the job that does it, step by step, with progress and a cancel that stops Helm.

The job removes each Helm release (Grafana Alloy, Loki, then the metrics stack; a release
already gone counts as removed), waits for what it ran to stop, removes OmniKrux's contact-point
settings from its Alertmanager, deletes the stored data only when asked, removes the sources the
install connected (each audited), then the install record. The namespace and the Prometheus
Operator's CustomResourceDefinitions stay: other tools' objects may live there. Nothing is ever
put back: a failure or a cancel says what was already removed stays removed, and "Uninstall"
again finishes it. Deleting a project never comes here."""

from __future__ import annotations

import asyncio
import logging
import re
import secrets
import time
from collections.abc import Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.actions.jobs import REMOVED, UNEXPECTED, Job, JobFailed
from omnikrux.actions.pipeline import (
    ActionError,
    Applied,
    ApplyContext,
    ClusterRef,
    Planned,
    Target,
)
from omnikrux.clusters.models import Environment
from omnikrux.exec.debug import finish_even_if_cancelled
from omnikrux.kube.connections import ClusterConnections
from omnikrux.kube.http import call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.monitoring.alerts.store import UnknownRule
from omnikrux.monitoring.install import messages, readiness
from omnikrux.monitoring.install.connect import _audited, _entry
from omnikrux.monitoring.install.facts import read_releases
from omnikrux.monitoring.install.helm import HelmResult, helm_error_message, uninstall_args
from omnikrux.monitoring.install.job import _and, _cluster_words, _sentence, release_specs
from omnikrux.monitoring.install.kubeconfig import (
    LONGEST_HELM_CALL_SECONDS,
    helm_kubeconfig,
    secrets_and_hosts,
)
from omnikrux.monitoring.install.readiness import step_words
from omnikrux.monitoring.install.settings import COMPONENT_ORDER, Component
from omnikrux.monitoring.install.store import INTERRUPTED, InstallBusy, InstallRecord
from omnikrux.monitoring.install.values import (
    AMC_NAME,
    DATA_INSTANCES,
    MANAGED_BY,
    ReleaseSpec,
    WorkloadRef,
    values_for,
)
from omnikrux.monitoring.sources.discovery import CLUSTER_GONE
from omnikrux.monitoring.sources.rules import details_of
from omnikrux.resources.kinds import KindSpec

if TYPE_CHECKING:
    from omnikrux.clusters.registry import ClusterRegistry
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

ACTION = "uninstall"
KIND_KEY = "namespaces"
_RUNNING = {"installing": "installing", "uninstalling": "uninstalling"}
# Helm's own `--timeout` (hooks), and the most one Helm call may run before it is stopped:
# within LONGEST_HELM_CALL_SECONDS, which the startup sweep of kubeconfig folders relies on.
HELM_TIMEOUT_SECONDS = 300
HELM_CALL_SECONDS = 420.0
assert HELM_CALL_SECONDS <= LONGEST_HELM_CALL_SECONDS
# How long the job waits for what a release ran to stop.
STOP_TIMEOUT_SECONDS = 300.0
# The wait's clock (tests replace it to pass five minutes at once).
CLOCK: Callable[[], float] = time.monotonic
MANAGED_LABEL = "app.kubernetes.io/managed-by"
AMC_PATH = "/apis/monitoring.coreos.com/v1alpha1/namespaces/{namespace}/alertmanagerconfigs/{name}"
SECRET_PATH = "/api/v1/namespaces/{namespace}/secrets/{name}"
PVC_LIST = "/api/v1/namespaces/{namespace}/persistentvolumeclaims"
SOURCE_KINDS = ("prometheus", "alertmanager", "loki")
METRICS_RELEASE = "omnikrux-metrics"
# The Prometheus and Alertmanager the metrics release asks the Operator for: removed (and waited
# for) while the Operator still runs, so it can finish its own clean-up before Helm removes it.
OPERATOR_RESOURCES = (
    ("Prometheus", "prometheuses", "omnikrux-metrics-prometheus"),
    ("Alertmanager", "alertmanagers", "omnikrux-metrics-alertmanager"),
)
OPERATOR_RESOURCE_PATH = "/apis/monitoring.coreos.com/v1/namespaces/{namespace}/{plural}/{name}"
INSTANCE_LABEL = "app.kubernetes.io/instance"
# Helm's words for a release it has no record of (`helm uninstall` of one already removed).
_RELEASE_NOT_FOUND = re.compile(r"release: not found", re.IGNORECASE)

ApiFor = Callable[[], AbstractAsyncContextManager[ApiClient]]


def ordered(components: Sequence[str]) -> list[Component]:
    return [c for c in COMPONENT_ORDER if c in components]


def uninstall_specs(components: Sequence[str]) -> list[ReleaseSpec]:
    """The releases of these components in uninstall order: Alloy, Loki, then the metrics."""
    return list(reversed(release_specs(components)))


def _q(text: str) -> str:
    return quote(text, safe="")


async def read_volumes(api: ApiClient, namespace: str, components: Sequence[str]) -> list[dict]:
    """The data volumes (PersistentVolumeClaims) of these components, by name, with their uid."""
    instances = [i for c in ordered(components) for i in DATA_INSTANCES[c]]
    if not instances:
        return []
    answer = await call_json(
        api,
        "GET",
        PVC_LIST.format(namespace=_q(namespace)),
        timeout=REQUEST_TIMEOUT,
        query=[("labelSelector", f"app.kubernetes.io/instance in ({','.join(instances)})")],
    )
    items = answer.get("items") if isinstance(answer.get("items"), list) else []
    volumes = []
    for item in items:
        meta = item.get("metadata") if isinstance(item, dict) else None
        if isinstance(meta, dict) and isinstance(meta.get("name"), str):
            volumes.append({"name": meta["name"], "uid": str(meta.get("uid") or "")})
    return sorted(volumes, key=lambda v: v["name"])


async def rules_in_tools(services: MonitoringServices, record: InstallRecord) -> list[str]:
    """The names of the alert rules that run in the installed Prometheus or Loki (a tool target
    there, not leaving, of a rule not deleted)."""
    tools = {record.prometheus_source_id, record.loki_source_id} - {None}
    if not tools:
        return []
    names: set[str] = set()
    for target in await services.alerts.targets():
        if target.engine != "tool" or target.leaving or target.source_id not in tools:
            continue
        try:
            rule = await services.alerts.get_rule(target.rule_id)
        except UnknownRule:
            continue
        if rule.deleted_at is None:
            names.add(rule.name)
    return sorted(names, key=lambda n: (n.casefold(), n))


async def _sources(services: MonitoringServices, record: InstallRecord) -> list[Any]:
    """The sources the install connected that still exist (Prometheus, Alertmanager, Loki)."""
    found = []
    for kind in SOURCE_KINDS:
        source_id = getattr(record, f"{kind}_source_id")
        if source_id is None:
            continue
        try:
            found.append(await services.sources.get(source_id))
        except KeyError:
            continue
    return found


def _releases_line(names: Sequence[str], cluster: str) -> str:
    line = (
        messages.SUMMARY_REMOVES_RELEASE if len(names) == 1 else messages.SUMMARY_REMOVES_RELEASES
    )
    return line.format(names=_and(names), cluster=cluster)


def _sources_line(names: Sequence[str], projects: Sequence[str]) -> str:
    one = len(names) == 1
    if projects:
        line = messages.SUMMARY_REMOVES_SOURCE if one else messages.SUMMARY_REMOVES_SOURCES
        return line.format(names=_and(names), projects=_and(projects))
    line = (
        messages.SUMMARY_REMOVES_SOURCE_UNUSED if one else messages.SUMMARY_REMOVES_SOURCES_UNUSED
    )
    return line.format(names=_and(names))


def _data_line(volumes: Sequence[Mapping], delete_data: bool) -> str | None:
    if not volumes:
        return None
    if delete_data:
        return messages.SUMMARY_DELETES_DATA.format(names=_and([v["name"] for v in volumes]))
    if len(volumes) == 1:
        return messages.SUMMARY_KEEPS_DATA_ONE
    return messages.SUMMARY_KEEPS_DATA.format(n=len(volumes))


async def cluster_ref(state: Any, cluster_id: str) -> tuple[ClusterRef, bool]:
    """The cluster as the pipeline names it, and whether it is a cloud cluster."""
    registry = state.registry
    try:
        info = await registry.get(cluster_id)
    except KeyError:
        raise ActionError(404, CLUSTER_GONE) from None
    cluster = ClusterRef(
        id=info.id,
        name=info.name,
        provider=info.provider.value,
        environment=info.environment.value,
    )
    return cluster, bool(await registry.is_cloud(cluster_id))


def _busy(state: str, cluster: ClusterRef) -> str:
    return messages.BLOCK_BUSY.format(doing=_RUNNING.get(state, state), cluster=cluster.name)


class UninstallAction:
    """The pipeline handler for uninstalling the monitoring tools from their namespace. `params`
    are made by the server (`api.plan_uninstall`): `delete_data`. Not in the pipeline's
    `ACTIONS`: the browser can never ask for `uninstall` through `POST /api/actions/plan`."""

    kinds = frozenset({KIND_KEY})

    def __init__(self, services: MonitoringServices, state: Any = None) -> None:
        self._services = services
        self._state = state

    async def _review(
        self, api: ApiClient, record: InstallRecord, *, delete_data: bool
    ) -> dict[str, Any]:
        """What the review shows and the apply checks again, read now."""
        services = self._services
        namespace = record.namespace
        components = ordered(record.components)
        specs = uninstall_specs(components)
        releases = await read_releases(api, namespace)
        # Every release with one of the names, as Helm has it: removed only when it carries
        # OmniKrux's marker; one that doesn't (or whose record can't be read) stays.
        found = {
            s.release: {
                "revision": releases[s.release].revision,
                "ours": releases[s.release].owner_label == MANAGED_BY,
                "version": releases[s.release].chart_version,
            }
            for s in specs
            if s.release in releases
        }
        sources = await _sources(services, record)
        projects: set[str] = set()
        for source in sources:
            projects.update(p.name for p in await services.projects.projects_using(source.id))
        return {
            "namespace": namespace,
            "components": components,
            "releases": found,
            # What the job removes, in uninstall order: exactly the releases the review names.
            "remove": [s.release for s in specs if found.get(s.release, {}).get("ours")],
            "keep": [
                s.release for s in specs if s.release in found and not found[s.release]["ours"]
            ],
            "contacts": "metrics" in components and await contact_settings_ours(api, namespace),
            "volumes": await read_volumes(api, namespace, components),
            "sources": [s.id for s in sources],
            "source_names": [s.name for s in sources],
            "projects": sorted(projects, key=lambda n: (n.casefold(), n)),
            "rules": await rules_in_tools(services, record),
            "delete_data": delete_data,
        }

    async def plan(
        self, api: ApiClient, spec: KindSpec, target: Target, params: dict, *, cluster: ClusterRef
    ) -> Planned:
        services = self._services
        record = await services.installs.get(cluster.id)
        if record is None or record.namespace != target.name:
            raise ActionError(404, messages.NOT_INSTALLED)
        seen = await self._review(api, record, delete_data=bool(params.get("delete_data")))
        namespace = record.namespace
        specs = uninstall_specs(seen["components"])

        blocked: list[str] = []
        if seen["rules"]:
            blocked.append(messages.BLOCK_RULES_IN_TOOLS.format(names=_and(seen["rules"])))
        if record.state in _RUNNING:
            blocked.append(_busy(record.state, cluster))

        summary: list[str] = []
        if seen["remove"]:
            summary.append(_releases_line(seen["remove"], cluster.name))
        summary += [
            messages.SUMMARY_KEEPS_RELEASE.format(release=r, namespace=namespace)
            for r in seen["keep"]
        ]
        if seen["contacts"]:
            summary.append(messages.SUMMARY_REMOVES_CONTACTS)
        if seen["source_names"]:
            summary.append(_sources_line(seen["source_names"], seen["projects"]))
        if (line := _data_line(seen["volumes"], seen["delete_data"])) is not None:
            summary.append(line)
        summary.append(messages.SUMMARY_KEEPS_NAMESPACE.format(namespace=namespace))

        before = {
            "namespace": namespace,
            "releases": {
                s.release: {
                    "chart": s.chart,
                    "version": seen["releases"][s.release]["version"],
                    "values": values_for(
                        s.release, record.settings, namespace=namespace, cluster_name=cluster.name
                    ),
                }
                for s in specs
                if s.release in seen["remove"]
            },
            "volumes": [v["name"] for v in seen["volumes"]],
        }
        return Planned(
            title=messages.UNINSTALL_TITLE.format(namespace=namespace),
            summary=summary,
            blocked=blocked,
            before=before,
            after=None,
            typed=cluster.environment == Environment.PRODUCTION,
            apply_label=messages.UNINSTALL_LABEL,
            state=seen,
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        """Check that the review still holds (nothing is removed otherwise), mark the record as
        uninstalling (a job already running there answers 409 with the busy words), then start
        the uninstall job, which takes the record over under its own id."""
        jobs = ctx.jobs
        if jobs is None or jobs.closed:
            raise ActionError(503, messages.UNINSTALL_NO_JOBS)
        services, state = self._services, planned.state
        namespace: str = state["namespace"]
        cluster, cloud = await cluster_ref(self._state, target.cluster_id)
        record = await services.installs.get(cluster.id)
        if record is None:
            raise ActionError(404, messages.NOT_INSTALLED)
        if record.state in _RUNNING:
            raise ActionError(409, _busy(record.state, cluster))
        stale = ActionError(409, messages.INSTALL_STALE.format(namespace=namespace))
        if record.namespace != namespace:
            raise stale
        now = await self._review(ctx.api, record, delete_data=state["delete_data"])
        if now["rules"]:
            raise ActionError(409, messages.BLOCK_RULES_IN_TOOLS.format(names=_and(now["rules"])))
        keys = ("components", "releases", "contacts", "volumes", "sources", "projects")
        if any(now[key] != state.get(key) for key in keys):
            raise stale

        pending = f"pending-{secrets.token_urlsafe(12)}"
        try:
            await services.installs.begin_uninstall(cluster.id, job_id=pending)
        except InstallBusy as exc:
            raise ActionError(409, _busy(exc.state, cluster)) from None
        except KeyError:
            raise ActionError(404, messages.NOT_INSTALLED) from None
        except Exception as exc:  # noqa: BLE001 (a store failure: in words, logged by type)
            log.warning("The install record couldn't be marked (%s)", type(exc).__name__)
            raise ActionError(503, messages.UNINSTALL_NOT_SAVED) from None

        registry = self._state.registry

        async def work(job: Job) -> str:
            return await run_uninstall(
                job,
                services=services,
                connections=ctx.connections,
                registry=registry,
                cluster=cluster,
                cloud=cloud,
                plan_state=state,
                actor=ctx.actor,
                record_job=pending,
            )

        first = first_step(state)
        try:
            job_id = jobs.start(
                ACTION,
                work,
                actor=ctx.actor,
                audit_id=ctx.audit_id,
                cancelled_message=messages.UNINSTALL_CANCELLED.format(step=step_words(first)),
                message=first,
                cluster_id=cluster.id,
            )
        except RuntimeError:  # the runner closed while the record was marked: put it back
            await services.installs.finish(cluster.id, record.state, record.message, job_id=pending)
            raise ActionError(503, messages.UNINSTALL_NO_JOBS) from None
        return Applied(messages.UNINSTALL_STARTED.format(namespace=namespace), job_id=job_id)


# --- the job ------------------------------------------------------------------------------


def step(job: Job, message: str) -> None:
    """Show the step, and what a cancel during it says."""
    job.message = message
    job.cancelled_message = messages.UNINSTALL_CANCELLED.format(step=step_words(message))


def _removed_specs(plan_state: Mapping) -> list[ReleaseSpec]:
    """The releases the review listed for removal, in uninstall order."""
    remove = set(plan_state["remove"])
    return [s for s in uninstall_specs(plan_state["components"]) if s.release in remove]


def first_step(plan_state: Mapping) -> str:
    specs = _removed_specs(plan_state)
    if specs and specs[0].release == METRICS_RELEASE:
        return messages.STEP_OPERATOR_RESOURCES
    if specs:
        return messages.STEP_HELM_REMOVE.format(release=specs[0].release)
    if plan_state["contacts"]:
        return messages.STEP_REMOVE_CONTACTS
    if plan_state["delete_data"]:
        return messages.STEP_DELETE_DATA
    return messages.STEP_REMOVE_SOURCES


def total_steps(plan_state: Mapping) -> int:
    """One per Helm release removed and one per workload it ran (and, for the metrics, one for
    the Operator's Prometheus and Alertmanager), the contact-point settings (when there are),
    the stored data (when asked), and the sources."""
    specs = _removed_specs(plan_state)
    return (
        sum(1 + len(s.workloads) for s in specs)
        + (1 if any(s.release == METRICS_RELEASE for s in specs) else 0)
        + (1 if plan_state["contacts"] else 0)
        + (1 if plan_state["delete_data"] else 0)
        + 1
    )


async def helm_uninstall(
    services: MonitoringServices,
    connections: ClusterConnections,
    *,
    cluster: ClusterRef,
    cloud: bool,
    namespace: str,
    release: str,
) -> None:
    """`helm uninstall` one release in its own private kubeconfig folder. A release Helm has no
    record of counts as removed; a failure raises JobFailed with Helm's scrubbed words."""
    helm_step = messages.HELM_UNINSTALL_STEP.format(release=release)
    try:
        async with helm_kubeconfig(connections, cluster.id) as kubeconfig:
            secrets_, hosts = secrets_and_hosts(kubeconfig)
            result: HelmResult = await services.helm.run(
                uninstall_args(release, namespace, timeout_s=HELM_TIMEOUT_SECONDS),
                kubeconfig=kubeconfig,
                timeout=HELM_CALL_SECONDS,
            )
    except Exception as exc:  # noqa: BLE001 (no kubeconfig, or Helm couldn't start: in words)
        log.warning("Helm couldn't run for %s (%s)", release, type(exc).__name__)
        raise JobFailed(
            messages.UNINSTALL_STEP_FAILED.format(
                words=messages.HELM_NOT_STARTED_UNINSTALL.format(release=release)
            )
        ) from None
    if result.code == 0 and result.timeout is None:
        return
    if result.timeout is None and _RELEASE_NOT_FOUND.search(result.stderr):
        return  # already gone
    if result.truncated and result.timeout is None:
        words = messages.HELM_ANSWER_TOO_LONG.format(step=helm_step)
    else:
        if result.timeout is not None:
            helm_step = messages.HELM_UNINSTALLING_STEP.format(release=release)
        words = helm_error_message(
            result, step=helm_step, secrets=secrets_, hosts=hosts, cloud=cloud
        )
    raise JobFailed(
        messages.UNINSTALL_HELM_FAILED.format(helm_words=_sentence(words), namespace=namespace)
    )


async def _still_there(api_for: ApiFor, namespace: str, workloads: Sequence[WorkloadRef]):
    """Per workload: (gone, why it is still there)."""

    async def one(api: ApiClient, w: WorkloadRef) -> tuple[bool, str]:
        try:
            await call_json(
                api, "GET", readiness.workload_path(namespace, w), timeout=REQUEST_TIMEOUT
            )
        except ApiException as exc:
            if exc.status == 404:
                return True, ""
            return False, readiness.read_failed(exc)
        return False, messages.STILL_STOPPING

    try:
        async with api_for() as api:
            return list(await asyncio.gather(*(one(api, w) for w in workloads)))
    except Exception as exc:  # noqa: BLE001 (the cluster didn't answer: try again next time)
        log.info("Reading the uninstall's workloads failed (%s)", type(exc).__name__)
        return [(False, readiness.read_failed(exc)) for _ in workloads]


async def wait_gone(
    api_for: ApiFor,
    namespace: str,
    workloads: Sequence[WorkloadRef],
    job: Job,
    *,
    timeout: float = STOP_TIMEOUT_SECONDS,
    interval: float = readiness.READY_INTERVAL_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], object] = asyncio.sleep,
) -> None:
    """Read every workload each `interval` seconds until none is left. While it waits,
    `job.message` names the first still there, `job.blocked` lists each and why, and `job.done`
    counts the gone ones. Past `timeout`: JobFailed(UNINSTALL_NOT_STOPPED)."""
    if not workloads:
        return
    base = job.done
    counted = 0
    deadline = clock() + timeout
    while True:
        seen = await _still_there(api_for, namespace, workloads)
        gone = sum(1 for g, _ in seen if g)
        counted = max(counted, gone)
        job.done = base + counted
        staying = [(w, why) for w, (g, why) in zip(workloads, seen, strict=True) if not g]
        job.blocked = [
            {"namespace": namespace, "name": f"{w.kind} {w.name}", "message": why}
            for w, why in staying
        ]
        if not staying:
            job.blocked = []
            return
        first, why = staying[0]
        step(job, messages.STEP_STOP.format(label=first.label))
        if clock() >= deadline:
            raise JobFailed(
                messages.UNINSTALL_NOT_STOPPED.format(
                    label=first.label, why=why.removesuffix("."), namespace=namespace
                )
            )
        await sleep(interval)  # type: ignore[misc]


async def _read(api: ApiClient, path: str) -> dict | None:
    """The object at `path`; None when the cluster says it isn't there (or its kind isn't
    served)."""
    try:
        obj = await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)
    except ApiException as exc:
        if exc.status == 404:
            return None
        raise
    return obj if isinstance(obj, dict) else None


def _meta(obj: dict) -> dict:
    return obj.get("metadata") if isinstance(obj.get("metadata"), dict) else {}


def _labelled(obj: dict | None, label: str, value: str) -> bool:
    labels = _meta(obj).get("labels") if obj is not None else None
    return isinstance(labels, dict) and labels.get(label) == value


async def _delete_if_labelled(api: ApiClient, path: str, label: str, value: str) -> None:
    """Delete the object at `path` when it carries `label: value` (by its uid, so one made
    meanwhile is never touched); one that isn't there counts as removed."""
    obj = await _read(api, path)
    if obj is not None and _labelled(obj, label, value):
        await _delete(api, path, str(_meta(obj).get("uid") or ""))


async def _delete_if_ours(api: ApiClient, path: str) -> None:
    """Delete the object at `path` when it carries OmniKrux's `managed-by` label."""
    await _delete_if_labelled(api, path, MANAGED_LABEL, MANAGED_BY)


def _contact_paths(namespace: str) -> tuple[tuple[str, str], ...]:
    return (
        ("AlertmanagerConfig", AMC_PATH.format(namespace=_q(namespace), name=AMC_NAME)),
        ("Secret", SECRET_PATH.format(namespace=_q(namespace), name=AMC_NAME)),
    )


async def contact_settings_ours(api: ApiClient, namespace: str) -> bool:
    """Whether OmniKrux's contact-point settings (its AlertmanagerConfig or their Secret) are in
    the namespace: only then does the review say they go."""
    for _, path in _contact_paths(namespace):
        if _labelled(await _read(api, path), MANAGED_LABEL, MANAGED_BY):
            return True
    return False


def _operator_path(namespace: str, plural: str, name: str) -> str:
    return OPERATOR_RESOURCE_PATH.format(namespace=_q(namespace), plural=plural, name=name)


async def _operator_left(api: ApiClient, namespace: str) -> list[tuple[str, str, dict]]:
    """The metrics release's Prometheus and Alertmanager still there: (kind, name, object)."""
    left = []
    for kind, plural, name in OPERATOR_RESOURCES:
        obj = await _read(api, _operator_path(namespace, plural, name))
        if obj is not None and _labelled(obj, INSTANCE_LABEL, METRICS_RELEASE):
            left.append((kind, name, obj))
    return left


async def remove_operator_resources(
    connections: ClusterConnections,
    cluster: ClusterRef,
    cloud: bool,
    namespace: str,
    job: Job,
    *,
    timeout: float = STOP_TIMEOUT_SECONDS,
    interval: float = readiness.READY_INTERVAL_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], object] = asyncio.sleep,
) -> None:
    """Before Helm removes the metrics release (and with it the Operator): delete the Prometheus
    and Alertmanager the release made, and wait until they are gone, so the Operator still runs
    to finish whatever it holds them for. Finalizers are never removed: past `timeout` the job
    stops with words naming the object still being deleted and what it waits for."""
    step(job, messages.STEP_OPERATOR_RESOURCES)
    for kind, plural, name in OPERATOR_RESOURCES:
        action = messages.DELETE_OBJECT_STEP.format(kind=kind, name=f"{namespace}/{name}")
        path = _operator_path(namespace, plural, name)
        await _cluster_step(
            connections,
            cluster,
            cloud,
            action,
            lambda api, p=path: _delete_if_labelled(api, p, INSTANCE_LABEL, METRICS_RELEASE),
        )
    deadline = clock() + timeout
    action = messages.READ_TOOLS_STEP.format(namespace=namespace)
    while True:
        left = await _cluster_step(
            connections, cluster, cloud, action, lambda api: _operator_left(api, namespace)
        )
        if not left:
            job.blocked = []
            return
        job.blocked = [
            {"namespace": namespace, "name": f"{kind} {name}", "message": messages.STILL_STOPPING}
            for kind, name, _ in left
        ]
        if clock() >= deadline:
            kind, name, obj = left[0]
            finalizers = _meta(obj).get("finalizers")
            waits = (
                ", ".join(str(f) for f in finalizers)
                if isinstance(finalizers, list) and finalizers
                else messages.NOTHING_NAMED
            )
            raise JobFailed(
                messages.UNINSTALL_STUCK.format(
                    kind=kind, name=f"{namespace}/{name}", waits=waits, namespace=namespace
                )
            )
        await sleep(interval)  # type: ignore[misc]


async def _delete(api: ApiClient, path: str, uid: str) -> None:
    body = {"kind": "DeleteOptions", "apiVersion": "v1"}
    if uid:
        body["preconditions"] = {"uid": uid}  # type: ignore[assignment]
    try:
        await call_json(api, "DELETE", path, timeout=REQUEST_TIMEOUT, body=body)
    except ApiException as exc:
        # Gone already, or another object of that name now (made after the review): not ours.
        if exc.status not in (404, 409):
            raise


async def _cluster_step(
    connections: ClusterConnections,
    cluster: ClusterRef,
    cloud: bool,
    action: str,
    work: Callable[[ApiClient], Any],
) -> Any:
    try:
        async with connections.api(cluster.id) as api:
            return await work(api)
    except Exception as exc:  # noqa: BLE001 (said in words; logged by type)
        log.warning("The uninstall couldn't %s (%s)", action.split(" ")[0], type(exc).__name__)
        raise JobFailed(
            messages.UNINSTALL_STEP_FAILED.format(words=_cluster_words(exc, action, cloud=cloud))
        ) from None


async def remove_contact_settings(
    connections: ClusterConnections, cluster: ClusterRef, cloud: bool, namespace: str
) -> None:
    """OmniKrux's AlertmanagerConfig and its Secret, when they are OmniKrux's."""
    for kind, path in _contact_paths(namespace):
        action = messages.DELETE_OBJECT_STEP.format(kind=kind, name=f"{namespace}/{AMC_NAME}")
        await _cluster_step(
            connections, cluster, cloud, action, lambda api, p=path: _delete_if_ours(api, p)
        )


async def delete_volumes(
    connections: ClusterConnections,
    cluster: ClusterRef,
    cloud: bool,
    namespace: str,
    volumes: Sequence[Mapping],
) -> None:
    """The reviewed data volumes, each by its uid."""
    for volume in volumes:
        name = str(volume["name"])
        uid = str(volume.get("uid") or "")
        path = f"{PVC_LIST.format(namespace=_q(namespace))}/{_q(name)}"
        action = messages.DELETE_OBJECT_STEP.format(
            kind="PersistentVolumeClaim", name=f"{namespace}/{name}"
        )
        await _cluster_step(
            connections, cluster, cloud, action, lambda api, p=path, u=uid: _delete(api, p, u)
        )


async def _finish_after_stop(services: MonitoringServices, record: int, source_id: str) -> None:
    """A removal stopped mid-way: succeeded when the source is gone (its delete committed),
    failed when it is still there."""
    try:
        await services.sources.get(source_id)
    except KeyError:
        await services.audit.finish(record, "succeeded")
        return
    except Exception as exc:  # noqa: BLE001 (unknown: say it failed)
        log.info("Reading a source after a stop failed (%s)", type(exc).__name__)
    await services.audit.finish(record, "failed", None)


async def remove_sources(
    services: MonitoringServices,
    registry: ClusterRegistry,
    source_ids: Sequence[str],
    actor: str,
) -> None:
    """Each source the install connected (one removed meanwhile is skipped), audited
    `source_remove`; then the rules of the projects that used them are brought up to date."""
    affected: dict[str, None] = {}
    for source_id in source_ids:
        try:
            source = await services.sources.get(source_id)
        except KeyError:
            continue
        for project in await services.projects.projects_using(source_id):
            affected[project.id] = None
        record = await _audited(
            services,
            _entry(
                actor, "source_remove", "source", source.name, await details_of(registry, source)
            ),
        )
        try:
            await services.sources.delete(source_id)
        except KeyError:  # removed meanwhile
            await services.audit.finish(record, "failed", None)
            continue
        except Exception as exc:  # noqa: BLE001 (said in words; logged by type)
            await finish_even_if_cancelled(services.audit.finish(record, "failed", None))
            log.warning("Removing an installed source failed (%s)", type(exc).__name__)
            raise JobFailed(messages.REMOVE_SOURCE_STEP.format(name=source.name)) from None
        except BaseException:
            # Stopped (a cancel, a shutdown): the record says what happened to the source.
            await finish_even_if_cancelled(_finish_after_stop(services, record, source_id))
            raise
        await finish_even_if_cancelled(services.audit.finish(record, "succeeded"))
        services.health.forget(source_id)
        services.transports.forget(source_id)
        services.capabilities.forget(source_id)
    for project_id in affected:
        try:
            await services.alert_sync.reconcile_scope("project", project_id)
        except Exception as exc:  # noqa: BLE001 (the sources are gone; rules converge at start)
            log.warning(
                "Bringing the alert rules of project %s up to date failed (%s)",
                project_id,
                type(exc).__name__,
            )


async def run_uninstall(
    job: Job,
    *,
    services: MonitoringServices,
    connections: ClusterConnections,
    registry: ClusterRegistry,
    cluster: ClusterRef,
    cloud: bool,
    plan_state: Mapping,
    actor: str,
    record_job: str | None = None,
) -> str:
    """Uninstall what the review listed (`plan_state`). Returns UNINSTALLED; raises JobFailed in
    words. The record (marked before, under `record_job` until this job takes it over) is
    removed when everything went, else finished with how it ended (never left `uninstalling`),
    unless a newer job owns it."""
    job.total = total_steps(plan_state)
    job.done = 0
    # Stopped with OmniKrux (or before the job ran): the words startup would give the record.
    ending: tuple[str, str] = ("failed", INTERRUPTED.format(what=ACTION))
    message = ""
    try:
        try:
            taken = record_job is None or record_job == job.id
            if not taken and not await services.installs.attach_job(cluster.id, record_job, job.id):
                raise JobFailed(
                    messages.BLOCK_BUSY.format(doing="uninstalling", cluster=cluster.name)
                )
            message = await _steps(
                job,
                services=services,
                connections=connections,
                registry=registry,
                cluster=cluster,
                cloud=cloud,
                plan_state=plan_state,
                actor=actor,
            )
        except JobFailed as exc:
            ending = ("failed", exc.message)
            raise
        except asyncio.CancelledError:
            if job.stop == "cancel":
                ending = ("cancelled", job.cancelled_message)
            elif job.stop == "removed":
                ending = ("failed", REMOVED.format(action=ACTION))
            raise
        except Exception as exc:
            ending = ("failed", UNEXPECTED.format(action=ACTION, error=type(exc).__name__))
            raise
        ending = ("uninstalled", message)
    finally:
        job.blocked = []
        holders = [job.id] + ([record_job] if record_job not in (None, job.id) else [])
        try:
            await finish_even_if_cancelled(_end(services, cluster.id, holders, ending))
        except asyncio.CancelledError:
            # A cancel that lands once everything is removed changes nothing.
            if ending[0] != "uninstalled":
                raise
            if (task := asyncio.current_task()) is not None:
                task.uncancel()
    return message


async def _end(
    services: MonitoringServices,
    cluster_id: str,
    job_ids: Sequence[str],
    ending: tuple[str, str],
) -> None:
    state, message = ending
    try:
        for job_id in job_ids:
            if state == "uninstalled":
                done = await services.installs.remove(cluster_id, job_id=job_id)
            else:
                done = (
                    await services.installs.finish(
                        cluster_id,
                        state,  # type: ignore[arg-type]
                        message,
                        job_id=job_id,
                    )
                    is not None
                )
            if done:
                return
    except KeyError:  # the record is gone
        pass
    except Exception as exc:  # noqa: BLE001 (startup marks a record left running)
        log.warning("Couldn't finish the install record (%s)", type(exc).__name__)


async def _steps(
    job: Job,
    *,
    services: MonitoringServices,
    connections: ClusterConnections,
    registry: ClusterRegistry,
    cluster: ClusterRef,
    cloud: bool,
    plan_state: Mapping,
    actor: str,
) -> str:
    namespace: str = plan_state["namespace"]
    delete_data = bool(plan_state["delete_data"])

    # 1. Each Helm release the review listed (no other), then what it ran stops. For the
    # metrics, the Operator's Prometheus and Alertmanager go first, while the Operator runs.
    for spec in _removed_specs(plan_state):
        if spec.release == METRICS_RELEASE:
            await remove_operator_resources(
                connections,
                cluster,
                cloud,
                namespace,
                job,
                timeout=STOP_TIMEOUT_SECONDS,
                interval=readiness.READY_INTERVAL_SECONDS,
                clock=CLOCK,
            )
            job.done += 1
        step(job, messages.STEP_HELM_REMOVE.format(release=spec.release))
        await helm_uninstall(
            services,
            connections,
            cluster=cluster,
            cloud=cloud,
            namespace=namespace,
            release=spec.release,
        )
        job.done += 1
        if spec.workloads:
            step(job, messages.STEP_STOP.format(label=spec.workloads[0].label))
            await wait_gone(
                lambda: connections.api(cluster.id),
                namespace,
                spec.workloads,
                job,
                timeout=STOP_TIMEOUT_SECONDS,
                interval=readiness.READY_INTERVAL_SECONDS,
                clock=CLOCK,
            )

    # 2. OmniKrux's contact-point settings in its Alertmanager, when the review listed them.
    if plan_state["contacts"]:
        step(job, messages.STEP_REMOVE_CONTACTS)
        await remove_contact_settings(connections, cluster, cloud, namespace)
        job.done += 1

    # 3. The stored data, only when asked.
    if delete_data:
        step(job, messages.STEP_DELETE_DATA)
        await delete_volumes(connections, cluster, cloud, namespace, plan_state["volumes"])
        job.done += 1

    # 4. The sources the install connected.
    step(job, messages.STEP_REMOVE_SOURCES)
    await remove_sources(services, registry, plan_state["sources"], actor)
    job.done += 1

    kept = messages.UNINSTALLED_DELETED if delete_data else messages.UNINSTALLED_KEPT
    return messages.UNINSTALLED.format(namespace=namespace, kept=kept)
