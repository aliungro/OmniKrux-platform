"""The install review: installing (or updating) the monitoring tools in a cluster is a
server-built plan through the action pipeline (`make_plan`), so it is reviewed, confirmed,
audited and only then applied, like every other change to a cluster.

`InstallAction` is not in the pipeline's `ACTIONS`: the browser can never ask for `install`
through `POST /api/actions/plan`; `POST /api/monitoring/install/plan` builds the plan's params
itself. Planning reads the cluster (`read_facts`), renders every chart through the injected
Helm runner (`render`, which never gets a kubeconfig), and blocks or warns in words before
anything is written. The plan's `state` holds what the apply checks again: the effective
settings, the chart sums, each release's revision, the CustomResourceDefinitions to write and a
digest of the values."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import secrets
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

from kubernetes_asyncio.client import ApiClient

from omnikrux.actions.jobs import Job
from omnikrux.actions.pipeline import (
    ActionError,
    Applied,
    ApplyContext,
    ClusterRef,
    Planned,
    Target,
)
from omnikrux.clusters.models import Environment
from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.facts import (
    NO_VOLUME,
    OPERATOR_VERSION,
    loki_volume,
    read_facts,
)
from omnikrux.monitoring.install.job import release_specs, run_install, settings_from_dict
from omnikrux.monitoring.install.pins import CHARTS
from omnikrux.monitoring.install.readiness import step_words
from omnikrux.monitoring.install.render import (
    Rendered,
    RenderRefused,
    chart_crds,
    objects_sentence,
    render,
)
from omnikrux.monitoring.install.settings import (
    COMPONENT_ORDER,
    ClusterFacts,
    Component,
    InstallSettings,
    effective_settings,
    validate_settings,
)
from omnikrux.monitoring.install.store import InstallBusy, InstallRecord
from omnikrux.monitoring.install.values import MANAGED_BY, ReleaseSpec, values_for
from omnikrux.monitoring.projects.store import UnknownProject
from omnikrux.monitoring.query.run import PROJECT_GONE
from omnikrux.monitoring.sources.discovery import CLUSTER_GONE
from omnikrux.resources.kinds import KindSpec, object_name_problem

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

KIND_KEY = "namespaces"
_RUNNING = {"installing": "installing", "uninstalling": "uninstalling"}


def ordered(components: Sequence[str]) -> list[Component]:
    return [c for c in COMPONENT_ORDER if c in components]


def values_digest(values: Mapping[str, dict]) -> str:
    text = json.dumps(values, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()


def _object_line(kind: str, name: str, namespace: str | None) -> str:
    return f"{kind} {namespace}/{name}" if namespace else f"{kind} {name}"


def _and(words: Sequence[str]) -> str:
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


def _what(components: Sequence[str]) -> str:
    metrics = messages.WHAT_METRICS.format(version=CHARTS["kube-prometheus-stack"].version)
    logs = messages.WHAT_LOGS.format(
        loki=CHARTS["loki"].app_version, alloy=CHARTS["alloy"].app_version
    )
    if "metrics" in components and "logs" in components:
        return messages.WHAT_BOTH.format(metrics=metrics, logs=logs)
    return metrics if "metrics" in components else logs


def _volumes_line(s: InstallSettings, components: Sequence[str], storage_class: str) -> str:
    sizes: list[str] = []
    if "metrics" in components:
        sizes.append(f"Prometheus {s.prometheus_storage}")
    if "logs" in components:
        sizes.append(f"Loki {s.loki_storage}")
    if "metrics" in components:
        sizes.append(f"Alertmanager {s.alertmanager_storage}")
    return messages.SUMMARY_VOLUMES.format(
        days=s.retention_days, volumes=", ".join(sizes), storage_class=storage_class
    )


def _connect_line(components: Sequence[str], project: str | None) -> str:
    tools: list[str] = []
    if "metrics" in components:
        tools += ["Prometheus", "Alertmanager"]
    if "logs" in components:
        tools.append("Loki")
    one = len(tools) == 1
    joined = ""
    if project is not None:
        joined = (
            messages.SUMMARY_CONNECT_PROJECT_ONE if one else messages.SUMMARY_CONNECT_PROJECT
        ).format(project=project)
    line = messages.SUMMARY_CONNECT_ONE if one else messages.SUMMARY_CONNECT
    return line.format(tools=_and(tools), project=joined)


def _pending(status: str) -> bool:
    """Helm's `pending-install`, `pending-upgrade` and `pending-rollback`."""
    return status.startswith("pending-")


def _loki_volume_problem(installed: str | None, s: InstallSettings) -> str | None:
    """Why the installed Loki can't take these settings: Kubernetes never lets a StatefulSet's
    volume claim change, so Helm would refuse the update half way. None when nothing is installed
    or the volume stays as it is."""
    wanted = s.loki_storage if s.persist else NO_VOLUME
    if installed is None or installed == wanted:
        return None
    if installed == NO_VOLUME:
        return messages.BLOCK_LOKI_VOLUME_ADDED
    if wanted == NO_VOLUME:
        return messages.BLOCK_LOKI_VOLUME_REMOVED.format(size=installed)
    return messages.BLOCK_LOKI_VOLUME_SIZE.format(size=installed)


def _chart_crds_by_name(docs: Sequence[dict]) -> dict[str, str | None]:
    """CRD name -> the chart's operator version annotation."""
    out: dict[str, str | None] = {}
    for doc in docs:
        if doc.get("kind") != "CustomResourceDefinition":
            continue
        meta = doc.get("metadata") if isinstance(doc.get("metadata"), dict) else {}
        name = meta.get("name")
        if not isinstance(name, str) or object_name_problem(name, None) is not None:
            continue
        annotations = meta.get("annotations") if isinstance(meta.get("annotations"), dict) else {}
        version = annotations.get(OPERATOR_VERSION)
        out[name] = version if isinstance(version, str) else None
    return out


_VERSION = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")


def _version_key(text: str | None) -> tuple[int, int, int] | None:
    match = _VERSION.match(text or "")
    return (int(match[1]), int(match[2]), int(match[3])) if match else None


def is_newer(version: str | None, than: str | None) -> bool:
    """Whether `version` is a later release than `than` (False when either can't be read)."""
    a, b = _version_key(version), _version_key(than)
    return a is not None and b is not None and a > b


def crds_to_write(
    chart: Mapping[str, str | None], facts: ClusterFacts
) -> tuple[list[str], list[str], list[tuple[str, str]]]:
    """(to create, to update, kept as they are with their version). A CRD the cluster has at the
    chart's version is left alone; one at a newer version is never downgraded (kept, and the
    review says so)."""
    served = facts.served_monitoring_crds
    create = sorted(name for name in chart if name not in served)
    update: list[str] = []
    kept: list[tuple[str, str]] = []
    for name in sorted(n for n in chart if n in served):
        have, ships = served[name], chart[name]
        if have is not None and is_newer(have, ships):
            kept.append((name, have))
        elif have != ships:
            update.append(name)
    return create, update, kept


class InstallAction:
    """The pipeline handler for installing the monitoring tools into a namespace. `params` are
    made by the server (`api.plan_install`): `components`, `settings` (as `asdict`) and
    `project_id`. Built per review with the Monitoring services and the app's state (the install
    job needs the state's catalog, which `ApplyContext` doesn't carry)."""

    kinds = frozenset({KIND_KEY})

    def __init__(self, services: MonitoringServices, state: Any = None) -> None:
        self._services = services
        self._state = state

    async def plan(
        self, api: ApiClient, spec: KindSpec, target: Target, params: dict, *, cluster: ClusterRef
    ) -> Planned:
        services = self._services
        components = ordered(params["components"])
        settings = settings_from_dict(params["settings"])
        project_id: str | None = params.get("project_id")
        project_name = await self._project_name(project_id)
        namespace = target.name  # the settings' namespace when it is a valid one
        problems = validate_settings(settings)
        record = await services.installs.get(cluster.id)
        specs = release_specs(components)

        blocked: list[str] = []
        tools = await services.install_tools.status()
        if not tools.available:
            blocked.append(tools.message or messages.TOOLS_NO_HELM.format(where=""))
        render_problem: str | None = None
        chart_crds_found: dict[str, str | None] = {}
        if tools.available and "metrics" in components:
            try:
                chart_crds_found = _chart_crds_by_name(await chart_crds(services.helm, tools))
            except RenderRefused as exc:
                render_problem = str(exc)

        facts = await read_facts(api, cluster, namespace, crd_names=list(chart_crds_found))
        effective, warnings = effective_settings(settings, facts)

        if "metrics" in components and facts.foreign_operator is not None:
            blocked.append(messages.BLOCK_FOREIGN_OPERATOR.format(where=facts.foreign_operator))
        for release in specs:
            ref = facts.releases.get(release.release)
            if ref is not None and ref.owner_label != MANAGED_BY:
                blocked.append(
                    messages.BLOCK_FOREIGN_RELEASE.format(
                        release=release.release, namespace=namespace
                    )
                )
        if record is not None and record.namespace != settings.namespace:
            blocked.append(messages.BLOCK_OTHER_NAMESPACE.format(namespace=record.namespace))
        if record is not None and record.state in _RUNNING:
            blocked.append(
                messages.BLOCK_BUSY.format(doing=_RUNNING[record.state], cluster=cluster.name)
            )
        else:
            # No job of OmniKrux's runs here, so a release still "pending" was left by a Helm
            # that was stopped half way: Helm refuses to change it until it is uninstalled.
            for release in specs:
                ref = facts.releases.get(release.release)
                if ref is not None and ref.owner_label == MANAGED_BY and _pending(ref.status):
                    blocked.append(
                        messages.BLOCK_RELEASE_PENDING.format(
                            release=release.release, status=ref.status
                        )
                    )
        if "logs" in components and (problem := _loki_volume_problem(
            await loki_volume(api, namespace), effective
        )):  # fmt: skip
            blocked.append(problem)

        values = {
            r.release: values_for(
                r.release, effective, namespace=namespace, cluster_name=cluster.name
            )
            for r in specs
        }
        rendered: dict[str, Rendered] = {}
        if tools.available and not problems and render_problem is None:
            rendered, render_problem = await self._render(
                tools, specs, values, namespace, facts.kube_version
            )
        if render_problem is not None:
            blocked.append(render_problem)
        blocked += [p.message for p in problems]

        create, update, kept = crds_to_write(chart_crds_found, facts)
        summary = self._summary(
            components, specs, rendered, facts, effective, namespace, cluster, project_name,
            create, update, kept,
        )  # fmt: skip
        ours = any(ref.owner_label == MANAGED_BY for ref in facts.releases.values())
        after: dict[str, Any] = {
            "namespace": namespace,
            "releases": {
                r.release: {
                    "chart": r.chart,
                    "version": CHARTS[r.chart].version,
                    "values": values[r.release],
                    **(
                        {
                            "objects": [
                                _object_line(o.kind, o.name, o.namespace)
                                for o in rendered[r.release].objects
                            ]
                        }
                        if r.release in rendered
                        else {}
                    ),
                }
                for r in specs
            },
            "customResourceDefinitions": create + update,
        }
        return Planned(
            title=(messages.UPDATE_TITLE if ours else messages.INSTALL_TITLE).format(
                namespace=namespace
            ),
            summary=summary,
            warnings=warnings,
            blocked=blocked,
            before=self._before(record, facts, cluster) if ours else None,
            after=after,
            typed=cluster.environment == Environment.PRODUCTION,
            apply_label=messages.UPDATE_LABEL if ours else messages.INSTALL_LABEL,
            state={
                "namespace": namespace,
                "components": list(components),
                "settings": asdict(effective),
                "charts": {r.release: CHARTS[r.chart].sha256 for r in specs},
                "revisions": {
                    r.release: (
                        facts.releases[r.release].revision if r.release in facts.releases else None
                    )
                    for r in specs
                },
                "crds": sorted(create + update),
                "project_id": project_id,
                "values_digest": values_digest(values),
                # What was asked for: the apply works out the effective settings again from it.
                "requested": asdict(settings),
                "kube_version": facts.kube_version,
                "default_storage_class": facts.default_storage_class,
            },
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        """Check that the review still holds (nothing is written otherwise), begin the install
        record (a job already running there answers 409 with the busy words), then start the
        install job, which takes the record over under its own id."""
        jobs = ctx.jobs
        if jobs is None or jobs.closed:
            raise ActionError(503, messages.INSTALL_NO_JOBS)
        services, state = self._services, planned.state
        namespace: str = state["namespace"]
        cluster, cloud = await self._cluster(target.cluster_id)
        record = await services.installs.get(cluster.id)
        if record is not None and record.state in _RUNNING:
            raise ActionError(409, self._busy(record.state, cluster))
        crd_docs = await self._still_as_reviewed(ctx.api, cluster, record, state)
        components = ordered(state["components"])
        specs = release_specs(components)
        # The record is begun here, before the job (a job already running there is refused with
        # 409, nothing started); the job takes it over under its own id as its first step.
        pending = f"pending-{secrets.token_urlsafe(12)}"
        try:
            await services.installs.begin(
                cluster.id,
                namespace,
                components,
                settings_from_dict(state["settings"]),
                {r.chart: CHARTS[r.chart].version for r in specs},
                job_id=pending,
                project_id=state.get("project_id"),
            )
        except InstallBusy as exc:
            raise ActionError(409, self._busy(exc.state, cluster)) from None
        except Exception as exc:  # noqa: BLE001 (a store failure: in words, logged by type)
            log.warning("The install record couldn't be begun (%s)", type(exc).__name__)
            raise ActionError(503, messages.INSTALL_NOT_SAVED) from None

        async def work(job: Job) -> str:
            return await run_install(
                job,
                services=services,
                connections=ctx.connections,
                catalog=getattr(self._state, "catalog", None),
                cluster=cluster,
                cloud=cloud,
                namespace=namespace,
                plan_state=state,
                actor=ctx.actor,
                crds=crd_docs,
                record_job=pending,
            )

        first = messages.STEP_NAMESPACE.format(namespace=namespace)
        try:
            job_id = jobs.start(
                "install",
                work,
                actor=ctx.actor,
                audit_id=ctx.audit_id,
                cancelled_message=messages.INSTALL_CANCELLED.format(step=step_words(first)),
                message=first,
                cluster_id=cluster.id,
            )
        except RuntimeError:  # the runner closed while the record was begun
            await services.installs.finish(
                cluster.id, "failed", messages.INSTALL_NO_JOBS, job_id=pending
            )
            raise ActionError(503, messages.INSTALL_NO_JOBS) from None
        return Applied(messages.INSTALL_STARTED.format(namespace=namespace), job_id=job_id)

    # -- parts -----------------------------------------------------------------------------

    async def _cluster(self, cluster_id: str) -> tuple[ClusterRef, bool]:
        registry = self._state.registry
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

    @staticmethod
    def _busy(state: str, cluster: ClusterRef) -> str:
        return messages.BLOCK_BUSY.format(doing=_RUNNING.get(state, state), cluster=cluster.name)

    async def _still_as_reviewed(
        self, api: ApiClient, cluster: ClusterRef, record: InstallRecord | None, state: dict
    ) -> list[dict]:
        """Read the cluster and the chart again; refuse (409 "Review it again", nothing
        written) when a release's revision, the chart sums, the CustomResourceDefinitions to
        write, the effective settings or the values differ from what was reviewed, or another
        Prometheus Operator or release owner appeared. Returns the chart's CRDs (the job writes
        those the review listed)."""
        services = self._services
        namespace: str = state["namespace"]
        stale = ActionError(409, messages.INSTALL_STALE.format(namespace=namespace))
        components = ordered(state["components"])
        specs = release_specs(components)
        if record is not None and record.namespace != namespace:
            raise stale
        tools = await services.install_tools.status()
        if not tools.available:
            raise stale
        crd_docs: list[dict] = []
        if "metrics" in components:
            try:
                crd_docs = await chart_crds(services.helm, tools)
            except RenderRefused:
                raise stale from None
        chart = _chart_crds_by_name(crd_docs)
        facts = await read_facts(api, cluster, namespace, crd_names=list(chart))
        effective, _ = effective_settings(settings_from_dict(state["requested"]), facts)
        create, update, _kept = crds_to_write(chart, facts)
        values = {
            r.release: values_for(
                r.release, effective, namespace=namespace, cluster_name=cluster.name
            )
            for r in specs
        }
        now = {
            "settings": asdict(effective),
            "charts": {r.release: CHARTS[r.chart].sha256 for r in specs},
            "revisions": {
                r.release: (
                    facts.releases[r.release].revision if r.release in facts.releases else None
                )
                for r in specs
            },
            "crds": sorted(create + update),
            "values_digest": values_digest(values),
            "default_storage_class": facts.default_storage_class,
        }
        if any(now[key] != state.get(key) for key in now):
            raise stale
        if "metrics" in components and facts.foreign_operator is not None:
            raise stale
        if any(
            r.release in facts.releases and facts.releases[r.release].owner_label != MANAGED_BY
            for r in specs
        ):
            raise stale
        return crd_docs

    async def _project_name(self, project_id: str | None) -> str | None:
        if project_id is None:
            return None
        try:
            return (await self._services.projects.get(project_id)).name
        except UnknownProject:
            raise ActionError(404, PROJECT_GONE) from None

    async def _render(
        self,
        tools,
        specs: Sequence[ReleaseSpec],
        values: Mapping[str, dict],
        namespace: str,
        kube_version: str,
    ) -> tuple[dict[str, Rendered], str | None]:
        """Every release rendered (at once); the first refusal, in release order."""
        helm = self._services.helm

        async def one(release: ReleaseSpec) -> Rendered | RenderRefused:
            try:
                return await render(
                    helm,
                    tools,
                    release,
                    values[release.release],
                    namespace=namespace,
                    kube_version=kube_version,
                )
            except RenderRefused as exc:
                return exc

        results = await asyncio.gather(*(one(r) for r in specs))
        for result in results:
            if isinstance(result, RenderRefused):
                return {}, str(result)
        return {r.release: r for r in results if isinstance(r, Rendered)}, None

    def _summary(
        self,
        components: Sequence[str],
        specs: Sequence[ReleaseSpec],
        rendered: Mapping[str, Rendered],
        facts: ClusterFacts,
        effective: InstallSettings,
        namespace: str,
        cluster: ClusterRef,
        project: str | None,
        create: Sequence[str],
        update: Sequence[str],
        kept: Sequence[tuple[str, str]],
    ) -> list[str]:
        lines = [
            messages.SUMMARY_INSTALLS.format(
                what=_what(components), cluster=cluster.name, namespace=namespace
            )
        ]
        for release in specs:
            if release.release in rendered:
                lines.append(
                    messages.SUMMARY_RELEASE.format(
                        release=release.release,
                        chart=release.chart,
                        version=CHARTS[release.chart].version,
                        objects=objects_sentence(rendered[release.release].objects),
                    )
                )
        if not facts.namespace_exists:
            lines.append(messages.SUMMARY_NAMESPACE.format(namespace=namespace))
        if create or update:
            lines.append(messages.SUMMARY_CRDS.format(created=len(create), updated=len(update)))
        lines += [messages.SUMMARY_NEWER_CRD.format(crd=n, version=v) for n, v in kept]
        if effective.persist and facts.default_storage_class is not None:
            lines.append(_volumes_line(effective, components, facts.default_storage_class))
        else:
            lines.append(messages.SUMMARY_MEMORY.format(days=effective.retention_days))
        lines.append(_connect_line(components, project))
        return lines

    def _before(
        self, record: InstallRecord | None, facts: ClusterFacts, cluster: ClusterRef
    ) -> dict:
        """What is installed now: the record's releases with the values it installed them
        with; without a record, what Helm's own records say (no values)."""
        if record is not None:
            return {
                "releases": {
                    r.release: {
                        "chart": r.chart,
                        "version": record.charts.get(r.chart),
                        "values": values_for(
                            r.release,
                            record.settings,
                            namespace=record.namespace,
                            cluster_name=cluster.name,
                        ),
                    }
                    for r in release_specs(record.components)
                }
            }
        return {
            "releases": {
                r.release: {
                    "chart": r.chart,
                    "version": facts.releases[r.release].chart_version,
                }
                for r in release_specs(COMPONENT_ORDER)
                if r.release in facts.releases
                and facts.releases[r.release].owner_label == MANAGED_BY
            }
        }
