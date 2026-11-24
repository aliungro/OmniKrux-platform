"""Connecting what OmniKrux installed: one source per tool (Prometheus, Alertmanager, Loki),
reached through the cluster's service proxy, flagged as installed by OmniKrux, tested until it
answers, and added to the project the install was started from.

A source that already reaches the same Service port in that cluster (one discovery or the user
added) is reused, never duplicated. Every source and link written is audited first (no audit,
no change)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal

from omnikrux.actions.jobs import JobFailed
from omnikrux.actions.pipeline import ClusterRef
from omnikrux.audit.store import AppAuditEntry, AuditUnavailable, no_audit_message
from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.settings import COMPONENT_ORDER
from omnikrux.monitoring.install.values import RELEASES
from omnikrux.monitoring.projects.store import UnknownProject
from omnikrux.monitoring.sources.connector import TestResult
from omnikrux.monitoring.sources.health import run_test
from omnikrux.monitoring.sources.store import NewSource
from omnikrux.monitoring.sources.types import ClusterTarget, NameTaken, SourceCheck, SourceConfig

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

ServiceKind = Literal["prometheus", "alertmanager", "loki"]
SERVICE_KINDS: tuple[ServiceKind, ...] = ("prometheus", "alertmanager", "loki")
LABELS: Mapping[str, str] = {
    "prometheus": "Prometheus",
    "alertmanager": "Alertmanager",
    "loki": "Loki",
}
CONNECT_TIMEOUT_SECONDS = 120.0
CONNECT_INTERVAL_SECONDS = 5.0
# The most one test of a source may take.
TEST_SECONDS = 10.0
_NAME_ATTEMPTS = 3


class ConnectFailed(JobFailed):
    """A source never answered; `sources` are the ids of every source made or reused (the others
    stay connected)."""

    def __init__(self, message: str, sources: Mapping[str, str | None]):
        super().__init__(message)
        self.sources = dict(sources)


async def _audited(services: MonitoringServices, entry: AppAuditEntry) -> int:
    try:
        return await services.audit.begin_app(entry)
    except AuditUnavailable as exc:
        raise JobFailed(no_audit_message(exc)) from None


def _entry(actor: str, action, kind: str, name: str, details: dict) -> AppAuditEntry:
    return AppAuditEntry(
        actor=actor, app="monitoring", action=action, kind=kind, name=name, details=details
    )


async def _flag(services: MonitoringServices, source: SourceConfig, actor: str) -> None:
    """Mark a reused source as one of the tools OmniKrux installed (audited `source_change`)."""
    if source.installed_by_omnikrux:
        return
    record = await _audited(
        services,
        _entry(actor, "source_change", "source", source.name, {"installed_by_omnikrux": True}),
    )
    try:
        await services.sources.set_installed_by_omnikrux(source.id, True)
    except BaseException:
        await services.audit.finish(record, "failed", None)
        raise
    await services.audit.finish(record, "succeeded")


async def _create(
    services: MonitoringServices,
    *,
    kind: ServiceKind,
    target: ClusterTarget,
    cluster: ClusterRef,
    actor: str,
) -> SourceConfig:
    """A new source for the tool, flagged as installed in the same transaction (audited
    `source_add`). A name another writer took meanwhile is replaced by the next free one."""
    details = {
        "type": kind,
        "reach": "cluster",
        "target": f"{cluster.name}/{target.namespace}/{target.service}:{target.port}",
        "auth": "none",
        "headers": [],
    }
    base = f"{LABELS[kind]} · {cluster.name}"
    for attempt in range(_NAME_ATTEMPTS):
        name = await services.sources.unique_name(base)
        record = await _audited(services, _entry(actor, "source_add", "source", name, details))
        try:
            async with services.sessionmaker.begin() as session:
                created = await services.sources.create(
                    NewSource(
                        name=name,
                        type=kind,
                        reach="cluster",
                        cluster=target,
                        auth_type="none",
                        created_by_project_id=None,
                    ),
                    session=session,
                )
                await services.sources.set_installed_by_omnikrux(created.id, True, session=session)
        except NameTaken as exc:
            await services.audit.finish(record, "failed", str(exc))
            if attempt + 1 == _NAME_ATTEMPTS:
                raise JobFailed(str(exc)) from None
            continue
        except BaseException:
            await services.audit.finish(record, "failed", None)
            raise
        await services.audit.finish(record, "succeeded")
        return await services.sources.get(created.id)
    raise AssertionError("unreachable")  # pragma: no cover


async def _until_it_answers(
    services: MonitoringServices,
    source: SourceConfig,
    *,
    timeout: float,
    interval: float,
    clock: Callable[[], float],
    sleep: Callable[[float], object],
) -> TestResult:
    """Test the source through its connector every `interval` seconds until it answers or
    `timeout` seconds have passed; the last result is kept as its check."""
    connector = services.connectors.get(source.type)
    deadline = clock() + timeout
    while True:
        transport = services.transports.for_source(source)
        result = await run_test(connector, transport, source.name, TEST_SECONDS)
        if result.ok or clock() + interval > deadline:
            break
        await sleep(interval)  # type: ignore[misc]
    try:
        await services.sources.record_check(
            source.id, SourceCheck(result.ok, result.message, result.version, datetime.now(UTC))
        )
    except KeyError:  # removed meanwhile
        pass
    return result


async def _link(
    services: MonitoringServices, project_id: str, sources: Sequence[SourceConfig], actor: str
) -> bool:
    """Add each source the project doesn't have yet, with no filter (audited `project_change`).
    False when the project no longer exists."""
    try:
        project = await services.projects.get(project_id)
    except UnknownProject:
        return False
    linked = {link.source_id for link in project.links}
    for source in sources:
        if source.id in linked:
            continue
        record = await _audited(
            services,
            _entry(
                actor,
                "project_change",
                "project",
                project.name,
                {"linked": source.name, "filter": ""},
            ),
        )
        try:
            await services.projects.link(project_id, source.id, (), "auto")
        except UnknownProject:
            await services.audit.finish(record, "failed", None)
            return False
        except BaseException:
            await services.audit.finish(record, "failed", None)
            raise
        await services.audit.finish(record, "succeeded")
    return True


async def connect_installed(
    services: MonitoringServices,
    *,
    cluster: ClusterRef,
    namespace: str,
    components: Sequence[str],
    project_id: str | None,
    actor: str,
    timeout: float | None = None,
    interval: float | None = None,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], object] = asyncio.sleep,
) -> dict[str, str | None]:
    """Connect the installed tools as sources; returns `{"prometheus": id, "alertmanager": id,
    "loki": id}` (None for a tool not installed). A source that never answers within `timeout`
    (CONNECT_TIMEOUT_SECONDS) raises ConnectFailed(INSTALL_CONNECT_FAILED) once the others are
    connected and linked."""
    timeout = CONNECT_TIMEOUT_SECONDS if timeout is None else timeout
    interval = CONNECT_INTERVAL_SECONDS if interval is None else interval
    ids: dict[str, str | None] = dict.fromkeys(SERVICE_KINDS)
    made: dict[str, SourceConfig] = {}
    for component in COMPONENT_ORDER:
        if component not in components:
            continue
        for release in RELEASES[component]:
            for kind, (service, port) in release.services.items():
                target = ClusterTarget(
                    cluster_id=cluster.id,
                    namespace=namespace,
                    service=service,
                    port=port,
                    scheme="http",
                )
                existing = await services.sources.find_cluster_target(target)
                if existing is not None:
                    await _flag(services, existing, actor)
                    source = existing
                else:
                    source = await _create(
                        services, kind=kind, target=target, cluster=cluster, actor=actor
                    )
                made[kind] = source
                ids[kind] = source.id

    kinds = list(made)
    results = await asyncio.gather(
        *(
            _until_it_answers(
                services, made[k], timeout=timeout, interval=interval, clock=clock, sleep=sleep
            )
            for k in kinds
        )
    )
    answered = [made[k] for k, r in zip(kinds, results, strict=True) if r.ok]
    linked = False
    if project_id is not None and answered:
        linked = await _link(services, project_id, answered, actor)
    for source in made.values():
        services.health.forget(source.id)
        services.capabilities.forget(source.id)
    if linked and project_id is not None:
        try:
            await services.alert_sync.reconcile_scope("project", project_id)
        except Exception as exc:  # noqa: BLE001 (the links stand; rules converge at start)
            log.warning(
                "Bringing the alert rules of project %s up to date failed (%s)",
                project_id,
                type(exc).__name__,
            )
    for kind, result in zip(kinds, results, strict=True):
        if not result.ok:
            message = result.message or ""
            if message and not message.endswith((".", "!", "?")):
                message += "."
            raise ConnectFailed(
                messages.INSTALL_CONNECT_FAILED.format(tool=LABELS[kind], message=message),
                ids,
            )
    return ids
