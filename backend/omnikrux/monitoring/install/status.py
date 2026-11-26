"""What the Monitoring tools page shows for a cluster, read live each time: OmniKrux's install
record, Helm's own record of each release (revision, status, chart version, when it was
deployed), each workload's ready and wanted Pods (and why one isn't ready), and the Prometheus,
Loki and Alertmanager the user runs in other namespaces. A read that fails says so in words (the
pipeline's, cloud privacy kept) and shows no release at all, never an old one as current."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from kubernetes_asyncio.client import ApiClient

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.kube.connections import ClusterConnections
from omnikrux.monitoring.install import messages, readiness
from omnikrux.monitoring.install.facts import read_releases
from omnikrux.monitoring.install.job import _cluster_words, release_specs
from omnikrux.monitoring.install.pins import CHARTS
from omnikrux.monitoring.install.settings import ReleaseRef
from omnikrux.monitoring.install.store import InstallRecord
from omnikrux.monitoring.install.values import ReleaseSpec, WorkloadRef
from omnikrux.monitoring.sources.discovery import FoundTool

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

# The tools the page lists when the user runs them elsewhere (Grafana is M6's).
OTHER_TYPES = ("prometheus", "loki", "alertmanager")


@dataclass(frozen=True)
class WorkloadStatus:
    kind: str
    name: str
    label: str
    ready: int
    desired: int
    why: str | None  # why it isn't ready; None when it is


@dataclass(frozen=True)
class ReleaseStatus:
    release: str
    label: str
    chart: str
    version: str | None  # the chart version Helm recorded
    status: str  # Helm's status, or RELEASE_MISSING when Helm has no record of it
    revision: int | None
    deployed_at: datetime | None
    workloads: tuple[WorkloadStatus, ...]


@dataclass(frozen=True)
class InstallStatus:
    cluster_id: str
    cluster_name: str
    record: InstallRecord | None
    releases: tuple[ReleaseStatus, ...]
    others: tuple[FoundTool, ...]
    checked_at: datetime
    problem: str | None


def update_available(record: InstallRecord) -> bool:
    """Whether OmniKrux ships another chart version than the one a release was installed with."""
    return any(
        record.charts.get(spec.chart) != CHARTS[spec.chart].version
        for spec in release_specs(record.components)
    )


def shipped(record: InstallRecord) -> dict[str, str]:
    """The chart versions this OmniKrux ships, for the record's components."""
    return {spec.chart: CHARTS[spec.chart].version for spec in release_specs(record.components)}


def _int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def counts(kind: str, obj: dict) -> tuple[int, int]:
    """(ready, desired) Pods of a workload as its status says."""
    spec = obj.get("spec") if isinstance(obj.get("spec"), dict) else {}
    status = obj.get("status") if isinstance(obj.get("status"), dict) else {}
    if kind == "DaemonSet":
        return _int(status.get("numberReady")), _int(status.get("desiredNumberScheduled"))
    replicas = spec.get("replicas", 1)
    return _int(status.get("readyReplicas")), (_int(replicas) if replicas is not None else 1)


def _when(text: str | None) -> datetime | None:
    if not text:
        return None
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)


async def _workload(api: ApiClient, namespace: str, w: WorkloadRef) -> WorkloadStatus:
    seen = await readiness.look(api, namespace, w)
    ready, desired = counts(w.kind, seen.obj) if seen.obj is not None else (0, 0)
    return WorkloadStatus(
        kind=w.kind,
        name=w.name,
        label=w.label,
        ready=ready,
        desired=desired,
        why=None if seen.ready else seen.why,
    )


async def _release(
    api: ApiClient, namespace: str, spec: ReleaseSpec, ref: ReleaseRef | None
) -> ReleaseStatus:
    workloads = await asyncio.gather(*(_workload(api, namespace, w) for w in spec.workloads))
    return ReleaseStatus(
        release=spec.release,
        label=messages.RELEASE_LABELS[spec.release],
        chart=spec.chart,
        version=ref.chart_version if ref is not None else None,
        status=(ref.status or "unknown") if ref is not None else messages.RELEASE_MISSING,
        revision=ref.revision if ref is not None else None,
        deployed_at=_when(ref.deployed_at) if ref is not None else None,
        workloads=tuple(workloads),
    )


async def _releases(
    connections: ClusterConnections, cluster_id: str, record: InstallRecord
) -> tuple[ReleaseStatus, ...]:
    specs = release_specs(record.components)
    async with connections.api(cluster_id) as api:
        refs = await read_releases(api, record.namespace)
        return tuple(
            await asyncio.gather(
                *(_release(api, record.namespace, s, refs.get(s.release)) for s in specs)
            )
        )


def _others(found: Sequence[FoundTool], namespace: str | None) -> tuple[FoundTool, ...]:
    """The Prometheus, Loki and Alertmanager discovery found outside OmniKrux's namespace."""
    return tuple(
        t
        for t in found
        if t.type in OTHER_TYPES
        and t.state != "missing"
        and t.namespace is not None
        and t.namespace != namespace
    )


async def read_status(
    services: MonitoringServices,
    cluster_id: str,
    *,
    connections: ClusterConnections,
    registry: ClusterRegistry,
) -> InstallStatus:
    """The cluster's monitoring tools as they are now. KeyError when OmniKrux doesn't know the
    cluster. (`connections` and `registry` are the app's: the Monitoring services hold neither.)"""
    info = await registry.get(cluster_id)
    record = await services.installs.get(cluster_id)
    namespace = record.namespace if record is not None else None

    async def releases() -> tuple[tuple[ReleaseStatus, ...], str | None]:
        if record is None:
            return (), None
        try:
            return await _releases(connections, cluster_id, record), None
        except KeyError:
            raise
        except Exception as exc:  # noqa: BLE001 (said in words; logged by type)
            log.info("Reading the monitoring tools failed (%s)", type(exc).__name__)
            cloud = bool(await registry.is_cloud(cluster_id))
            action = messages.READ_TOOLS_STEP.format(namespace=record.namespace)
            return (), _cluster_words(exc, action, cloud=cloud, cluster=info.name)

    (found_releases, problem), discovered = await asyncio.gather(
        releases(), services.discovery.find(cluster_id)
    )
    others = _others(discovered.found, namespace) if discovered.state == "ok" else ()
    if problem is None and discovered.state != "ok":
        problem = discovered.message
    return InstallStatus(
        cluster_id=cluster_id,
        cluster_name=info.name,
        record=record,
        releases=found_releases,
        others=others,
        checked_at=datetime.now(UTC),
        problem=problem,
    )
