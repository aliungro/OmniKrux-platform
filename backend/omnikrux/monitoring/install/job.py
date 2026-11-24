"""The install job: what a confirmed install review does, step by step, with progress the browser
polls and a cancel that stops Helm.

Steps: the namespace, the Prometheus Operator's CustomResourceDefinitions (when metrics are
installed), one `helm upgrade --install` per release (never `--wait`, `--atomic` or a
rollback), waiting for every workload to be ready, then connecting the installed tools as
sources. Each Helm call gets its own private kubeconfig (a fresh token), removed when the call
ends, however it ends. Helm's words are scrubbed of that call's credentials before they reach a
message. A failure says what failed and leaves things as Helm left them; whatever happens, the
install record is finished (never left `installing`) and the job runner finishes the audit."""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote

import yaml
from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.actions.jobs import REMOVED, STOPPED, UNEXPECTED, Job, JobFailed
from omnikrux.actions.pipeline import ClusterRef
from omnikrux.exec.debug import finish_even_if_cancelled
from omnikrux.kube.connections import ClusterConnections, cloud_kube_error, kube_error_message
from omnikrux.kube.http import KUBE_ERRORS, call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.monitoring.install import connect, messages, readiness
from omnikrux.monitoring.install.helm import (
    HelmResult,
    helm_error_message,
    upgrade_args,
)
from omnikrux.monitoring.install.kubeconfig import (
    LONGEST_HELM_CALL_SECONDS,
    helm_kubeconfig,
    secrets_and_hosts,
)
from omnikrux.monitoring.install.settings import COMPONENT_ORDER, InstallSettings, Resources
from omnikrux.monitoring.install.values import RELEASES, ReleaseSpec, values_for
from omnikrux.monitoring.projects.store import UnknownProject

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices
    from omnikrux.resources.catalog import KindCatalog

log = logging.getLogger(__name__)

ACTION = "install"
# Helm's own `--timeout` (it bounds the chart's hooks; nothing waits for readiness in Helm), and
# the most one Helm call may run before it is stopped: within LONGEST_HELM_CALL_SECONDS, which
# the startup sweep of leftover kubeconfig folders relies on.
HELM_TIMEOUT_SECONDS = 600
HELM_CALL_SECONDS = 720.0
assert HELM_CALL_SECONDS <= LONGEST_HELM_CALL_SECONDS
CRD_WRITE_TIMEOUT = 60
CRD_PATH = "/apis/apiextensions.k8s.io/v1/customresourcedefinitions"
_CRD_ATTEMPTS = 3
TOOL_NAMES = {"metrics": ("Prometheus", "Alertmanager"), "logs": ("Loki", "Grafana Alloy")}

# The readiness wait's clock (tests replace it to pass ten minutes at once).
CLOCK: Callable[[], float] = time.monotonic


def release_specs(components: Sequence[str]) -> list[ReleaseSpec]:
    """The releases of these components, in install order (metrics, loki, alloy)."""
    return [spec for c in COMPONENT_ORDER if c in components for spec in RELEASES[c]]


def settings_from_dict(values: Mapping) -> InstallSettings:
    """InstallSettings from `asdict` output (the plan's params and state)."""
    data = dict(values)
    for name in ("prometheus", "alertmanager", "loki", "alloy"):
        if isinstance(data.get(name), Mapping):
            data[name] = Resources(**data[name])
    return InstallSettings(**data)


def _and(words: Sequence[str]) -> str:
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def _sentence(text: str) -> str:
    text = text.strip()
    return text if text.endswith((".", "!", "?")) else text + "."


def step(job: Job, message: str, *, words: str | None = None) -> None:
    """Show the step, and what a cancel during it says (`words`: the step as the cancel names
    it, when it isn't the message itself)."""
    job.message = message
    job.cancelled_message = messages.INSTALL_CANCELLED.format(
        step=readiness.step_words(words or message)
    )


def total_steps(components: Sequence[str]) -> int:
    """1 namespace + 1 CRDs (metrics) + one per Helm release + one per workload + 1 connect."""
    specs = release_specs(components)
    return (
        1
        + (1 if "metrics" in components else 0)
        + len(specs)
        + sum(len(s.workloads) for s in specs)
        + 1
    )


def _cluster_words(exc: Exception, action: str, *, cloud: bool) -> str:
    """A failed cluster call in plain words (cloud clusters keep their privacy rule); never the
    transport's own text for an error OmniKrux doesn't know."""
    if cloud:
        return cloud_kube_error(action, exc=exc).message
    if isinstance(exc, KUBE_ERRORS):
        return _sentence(kube_error_message(exc, action))
    return f"Couldn't {action}."


def _step_failed(exc: Exception, action: str, *, cloud: bool) -> JobFailed:
    log.warning("The install couldn't %s (%s)", action.split(" ")[0], type(exc).__name__)
    return JobFailed(
        messages.INSTALL_STEP_FAILED.format(words=_cluster_words(exc, action, cloud=cloud))
    )


# --- the steps ------------------------------------------------------------------------------


async def create_namespace(api: ApiClient, namespace: str) -> None:
    """Create the namespace; one that already exists is fine."""
    body = {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace}}
    try:
        await call_json(api, "POST", "/api/v1/namespaces", timeout=REQUEST_TIMEOUT, body=body)
    except ApiException as exc:
        if exc.status != 409:
            raise


def _crd_body(doc: Mapping, resource_version: str | None) -> dict:
    """The chart's CRD as a write body: what the server owns (status, uid, creation time) left
    out; the live `resourceVersion` for a replace."""
    body = {k: copy.deepcopy(v) for k, v in doc.items() if k != "status"}
    meta = doc.get("metadata") if isinstance(doc.get("metadata"), Mapping) else {}
    metadata = {k: copy.deepcopy(meta[k]) for k in ("name", "labels", "annotations") if k in meta}
    if resource_version is not None:
        metadata["resourceVersion"] = resource_version
    body["metadata"] = metadata
    return body


async def write_crd(api: ApiClient, doc: Mapping) -> None:
    """Create the CRD (POST), or replace it (PUT with the live `resourceVersion`); a write that
    raced another writer is tried again with what is live then."""
    name = str((doc.get("metadata") or {}).get("name") or "")
    path = f"{CRD_PATH}/{quote(name, safe='')}"
    for attempt in range(_CRD_ATTEMPTS):
        try:
            live = await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)
        except ApiException as exc:
            if exc.status != 404:
                raise
            live = None
        try:
            if live is None:
                await call_json(
                    api, "POST", CRD_PATH, timeout=CRD_WRITE_TIMEOUT, body=_crd_body(doc, None)
                )
            else:
                version = (live.get("metadata") or {}).get("resourceVersion")
                await call_json(
                    api, "PUT", path, timeout=CRD_WRITE_TIMEOUT, body=_crd_body(doc, version)
                )
            return
        except ApiException as exc:
            if exc.status != 409 or attempt + 1 == _CRD_ATTEMPTS:
                raise


async def release_status(api: ApiClient, namespace: str, release: str) -> str:
    """The status Helm recorded on the release's latest revision, or `unknown`."""
    try:
        answer = await call_json(
            api,
            "GET",
            f"/api/v1/namespaces/{quote(namespace, safe='')}/secrets",
            timeout=REQUEST_TIMEOUT,
            query=[("labelSelector", f"owner=helm,name={release}")],
        )
    except Exception as exc:  # noqa: BLE001 (only a detail of the failure's words)
        log.info("Reading Helm's status of %s failed (%s)", release, type(exc).__name__)
        return "unknown"
    best: tuple[int, str] | None = None
    for item in answer.get("items") or []:
        labels = (item.get("metadata") or {}).get("labels") or {}
        try:
            revision = int(labels.get("version") or 0)
        except (TypeError, ValueError):
            continue
        status = labels.get("status")
        if isinstance(status, str) and status and (best is None or revision > best[0]):
            best = (revision, status)
    return best[1] if best is not None else "unknown"


def _write_values(path: Path, values: dict) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(yaml.safe_dump(values, sort_keys=False))


async def helm_install(
    services: MonitoringServices,
    connections: ClusterConnections,
    *,
    cluster: ClusterRef,
    cloud: bool,
    namespace: str,
    spec: ReleaseSpec,
    chart: Path,
    values: dict,
) -> None:
    """`helm upgrade --install` one release, in its own private kubeconfig folder (the values
    file beside it); a failure raises JobFailed with Helm's scrubbed words and its status."""
    helm_step = messages.HELM_INSTALL_STEP.format(release=spec.release)
    try:
        async with helm_kubeconfig(connections, cluster.id) as kubeconfig:
            secrets, hosts = secrets_and_hosts(kubeconfig)
            values_path = kubeconfig.parent / "values.yaml"
            _write_values(values_path, values)
            result: HelmResult = await services.helm.run(
                upgrade_args(
                    spec.release, chart, namespace, values_path, timeout_s=HELM_TIMEOUT_SECONDS
                ),
                kubeconfig=kubeconfig,
                timeout=HELM_CALL_SECONDS,
            )
    except Exception as exc:  # noqa: BLE001 (no kubeconfig, or Helm couldn't start: in words)
        log.warning("Helm couldn't run for %s (%s)", spec.release, type(exc).__name__)
        raise JobFailed(
            messages.INSTALL_STEP_FAILED.format(
                words=messages.HELM_NOT_STARTED.format(release=spec.release)
            )
        ) from None
    if result.code == 0 and result.timeout is None:
        return
    if result.truncated and result.timeout is None:
        words = messages.HELM_ANSWER_TOO_LONG.format(step=helm_step)
    else:
        words = helm_error_message(
            result, step=helm_step, secrets=secrets, hosts=hosts, cloud=cloud
        )
    try:
        async with connections.api(cluster.id) as api:
            status = await release_status(api, namespace, spec.release)
    except Exception as exc:  # noqa: BLE001 (only a detail of the failure's words)
        log.info("Reading Helm's status failed (%s)", type(exc).__name__)
        status = "unknown"
    raise JobFailed(
        messages.INSTALL_HELM_FAILED.format(
            helm_words=_sentence(words), status=status, namespace=namespace
        )
    )


def installed_message(
    namespace: str,
    components: Sequence[str],
    sources: Mapping[str, str | None],
    project: str | None,
) -> str:
    tools = [t for c in COMPONENT_ORDER if c in components for t in TOOL_NAMES[c]]
    n = sum(1 for v in sources.values() if v is not None)
    joined = messages.INSTALLED_PROJECT.format(project=project) if project else ""
    line = messages.INSTALLED_ONE if n == 1 else messages.INSTALLED
    return line.format(namespace=namespace, tools=_and(tools), n=n, project=joined)


# --- the job --------------------------------------------------------------------------------


async def run_install(
    job: Job,
    *,
    services: MonitoringServices,
    connections: ClusterConnections,
    catalog: KindCatalog | None,
    cluster: ClusterRef,
    cloud: bool,
    namespace: str,
    plan_state: Mapping,
    actor: str,
    crds: Sequence[Mapping] = (),
) -> str:
    """Install what the review planned (`plan_state`, the plan's kept state; `crds`, the chart's
    CustomResourceDefinitions read at apply). Returns INSTALLED; raises JobFailed in words. The
    install record (begun before) is finished in every case, unless a newer job owns it."""
    components = list(plan_state["components"])
    specs = release_specs(components)
    settings = settings_from_dict(plan_state["settings"])
    project_id = plan_state.get("project_id")
    job.total = total_steps(components)
    job.done = 0
    ending: tuple[str, str] = ("failed", STOPPED.format(action=ACTION))
    sources: Mapping[str, str | None] | None = None
    try:
        message, sources = await _steps(
            job,
            services=services,
            connections=connections,
            catalog=catalog,
            cluster=cluster,
            cloud=cloud,
            namespace=namespace,
            components=components,
            specs=specs,
            settings=settings,
            plan_state=plan_state,
            project_id=project_id,
            actor=actor,
            crds=crds,
        )
        ending = ("installed", message)
        return message
    except connect.ConnectFailed as exc:
        sources = exc.sources
        ending = ("failed", exc.message)
        raise
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
    finally:
        job.blocked = []
        if catalog is not None:
            catalog.forget(cluster.id)  # the kinds the CRDs serve are read again
        await finish_even_if_cancelled(
            _finish(services, cluster.id, job.id, ending, sources=sources)
        )


async def _finish(
    services: MonitoringServices,
    cluster_id: str,
    job_id: str,
    ending: tuple[str, str],
    *,
    sources: Mapping[str, str | None] | None,
) -> None:
    state, message = ending
    try:
        await services.installs.finish(
            cluster_id,
            state,  # type: ignore[arg-type]
            message,
            sources={k: v for k, v in (sources or {}).items() if v is not None},
            job_id=job_id,
        )
    except KeyError:  # the record went with its cluster
        pass
    except Exception as exc:  # noqa: BLE001 (startup marks a record left running)
        log.warning("Couldn't finish the install record (%s)", type(exc).__name__)


async def _steps(
    job: Job,
    *,
    services: MonitoringServices,
    connections: ClusterConnections,
    catalog: KindCatalog | None,
    cluster: ClusterRef,
    cloud: bool,
    namespace: str,
    components: Sequence[str],
    specs: Sequence[ReleaseSpec],
    settings: InstallSettings,
    plan_state: Mapping,
    project_id: str | None,
    actor: str,
    crds: Sequence[Mapping],
) -> tuple[str, dict[str, str | None]]:
    """The steps; returns the INSTALLED message and the sources connected."""
    # 1. The namespace.
    step(job, messages.STEP_NAMESPACE.format(namespace=namespace))
    action = messages.CREATE_NAMESPACE_STEP.format(namespace=namespace)
    try:
        async with connections.api(cluster.id) as api:
            await create_namespace(api, namespace)
    except Exception as exc:  # noqa: BLE001 (said in words; logged by type)
        raise _step_failed(exc, action, cloud=cloud) from None
    job.done += 1

    # 2. The Prometheus Operator's CustomResourceDefinitions the review listed.
    if "metrics" in components:
        step(job, messages.STEP_CRDS)
        wanted = list(plan_state.get("crds") or [])
        docs = {str((d.get("metadata") or {}).get("name")): d for d in crds}
        if any(name not in docs for name in wanted):
            raise JobFailed(messages.CRDS_GONE)
        if wanted:
            action = messages.WRITE_CRD_STEP.format(crd=wanted[0])
            try:
                async with connections.api(cluster.id) as api:
                    for name in wanted:
                        action = messages.WRITE_CRD_STEP.format(crd=name)
                        await write_crd(api, docs[name])
            except Exception as exc:  # noqa: BLE001 (said in words; logged by type)
                raise _step_failed(exc, action, cloud=cloud) from None
            finally:
                if catalog is not None:
                    catalog.forget(cluster.id)  # the kinds the new CRDs serve are read again
        job.done += 1

    # 3. Helm, one release at a time (a failure stops the rest).
    tools = await services.install_tools.status()
    for spec in specs:
        step(job, messages.STEP_HELM.format(release=spec.release))
        if not tools.available or spec.chart not in tools.charts:
            raise JobFailed(tools.message or messages.TOOLS_NO_HELM.format(where=""))
        values = values_for(spec.release, settings, namespace=namespace, cluster_name=cluster.name)
        await helm_install(
            services,
            connections,
            cluster=cluster,
            cloud=cloud,
            namespace=namespace,
            spec=spec,
            chart=tools.charts[spec.chart],
            values=values,
        )
        job.done += 1

    # 4. Every workload ready (Helm never waits).
    for spec in specs:
        if spec.workloads:
            first = spec.workloads[0]
            step(
                job,
                messages.STEP_WAIT.format(label=first.label, ready=0, total=len(spec.workloads)),
                words=messages.STEP_WAIT_WORDS.format(label=first.label),
            )
        await readiness.wait_ready(
            lambda: connections.api(cluster.id),
            namespace,
            spec.workloads,
            job,
            timeout=readiness.READY_TIMEOUT_SECONDS,
            interval=readiness.READY_INTERVAL_SECONDS,
            clock=CLOCK,
        )

    # 5. The sources.
    step(job, messages.STEP_CONNECT)
    sources = await connect.connect_installed(
        services,
        cluster=cluster,
        namespace=namespace,
        components=components,
        project_id=project_id,
        actor=actor,
    )
    job.done += 1
    project = None
    if project_id is not None:
        try:
            project_obj = await services.projects.get(project_id)
        except UnknownProject:
            project_obj = None
        if project_obj is not None and any(
            link.source_id in {v for v in sources.values() if v} for link in project_obj.links
        ):
            project = project_obj.name
    return installed_message(namespace, components, sources, project), sources
