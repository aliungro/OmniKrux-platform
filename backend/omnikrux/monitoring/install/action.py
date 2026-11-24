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
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

from kubernetes_asyncio.client import ApiClient

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
from omnikrux.monitoring.install.facts import OPERATOR_VERSION, read_facts
from omnikrux.monitoring.install.pins import CHARTS
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
    Resources,
    effective_settings,
    validate_settings,
)
from omnikrux.monitoring.install.store import InstallRecord
from omnikrux.monitoring.install.values import MANAGED_BY, RELEASES, ReleaseSpec, values_for
from omnikrux.monitoring.projects.store import UnknownProject
from omnikrux.monitoring.query.run import PROJECT_GONE
from omnikrux.resources.kinds import KindSpec, object_name_problem

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

KIND_KEY = "namespaces"
_RUNNING = {"installing": "installing", "uninstalling": "uninstalling"}


def settings_from_dict(values: Mapping[str, Any]) -> InstallSettings:
    """InstallSettings from `asdict` output (the plan's params and state)."""
    data = dict(values)
    for name in ("prometheus", "alertmanager", "loki", "alloy"):
        if isinstance(data.get(name), Mapping):
            data[name] = Resources(**data[name])
    return InstallSettings(**data)


def ordered(components: Sequence[str]) -> list[Component]:
    return [c for c in COMPONENT_ORDER if c in components]


def release_specs(components: Sequence[str]) -> list[ReleaseSpec]:
    return [spec for c in ordered(components) for spec in RELEASES[c]]


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


def crds_to_write(chart: Mapping[str, str | None], facts: ClusterFacts) -> tuple[list, list]:
    """(to create, to update): a CRD the cluster has at the chart's version is left alone."""
    served = facts.served_monitoring_crds
    create = sorted(name for name in chart if name not in served)
    update = sorted(name for name, v in chart.items() if name in served and served[name] != v)
    return create, update


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

        create, update = crds_to_write(chart_crds_found, facts)
        summary = self._summary(
            components, specs, rendered, facts, effective, namespace, cluster, project_name,
            create, update,
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
                "kube_version": facts.kube_version,
                "default_storage_class": facts.default_storage_class,
            },
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        raise ActionError(501, messages.APPLY_NOT_YET)

    # -- parts -----------------------------------------------------------------------------

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
