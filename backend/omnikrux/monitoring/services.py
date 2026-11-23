"""Everything the Monitoring routes need, built once at startup as `app.state.monitoring`."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.audit.store import AuditLog
from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.kube.connections import ClusterConnections
from omnikrux.monitoring.alerts.contact_points.senders import SenderSet
from omnikrux.monitoring.alerts.contact_points.store import ContactPointStore
from omnikrux.monitoring.alerts.silences import SilenceStore
from omnikrux.monitoring.alerts.store import AlertStore
from omnikrux.monitoring.dashboards.store import DashboardStore
from omnikrux.monitoring.explore.catalog import CatalogCache
from omnikrux.monitoring.projects.store import GroupStore, ProjectStore
from omnikrux.monitoring.sources.capability import CapabilityCache
from omnikrux.monitoring.sources.connector import ConnectorRegistry, default_connectors
from omnikrux.monitoring.sources.discovery import Discovery
from omnikrux.monitoring.sources.health import HealthCache
from omnikrux.monitoring.sources.store import SourceStore
from omnikrux.monitoring.sources.transport import TransportFactory
from omnikrux.security.secrets import SecretBox

if TYPE_CHECKING:
    # Imported in `build_services`: the engine runs queries through `query.run`, which reads
    # these services.
    from omnikrux.monitoring.alerts.engine import AlertEngine
    from omnikrux.monitoring.alerts.notify import Notifier
    from omnikrux.monitoring.alerts.sync import AlertSync

log = logging.getLogger(__name__)

# The longest the app's startup waits for the rules' targets to be brought up to date; the rest
# carries on in the background while the engine runs.
STARTUP_RECONCILE_SECONDS = 15.0


@dataclass
class MonitoringServices:
    sources: SourceStore
    projects: ProjectStore
    groups: GroupStore
    dashboards: DashboardStore
    transports: TransportFactory
    connectors: ConnectorRegistry
    health: HealthCache
    discovery: Discovery
    catalogs: CatalogCache
    alerts: AlertStore
    contact_points: ContactPointStore
    senders: SenderSet
    silences: SilenceStore
    audit: AuditLog
    sessionmaker: async_sessionmaker[AsyncSession]
    capabilities: CapabilityCache
    # Set by `build_services` (they need the services themselves).
    notifier: Notifier = field(init=False)
    engine: AlertEngine = field(init=False)
    alert_sync: AlertSync = field(init=False)
    # The startup pass of `alert_sync.reconcile_all` (`start_alerts`), while it runs.
    startup_reconcile: asyncio.Task | None = field(default=None, init=False)

    async def start_alerts(self, wait: float | None = None) -> None:
        """Bring every rule's targets up to date in the background, wait for that at most
        `wait` seconds (STARTUP_RECONCILE_SECONDS; it isn't cancelled when the time is up), then
        start the engine. Never raises: `reconcile_all` logs its own failures."""
        limit = STARTUP_RECONCILE_SECONDS if wait is None else wait
        task = asyncio.create_task(self.alert_sync.reconcile_all(), name="omnikrux-alert-reconcile")
        self.startup_reconcile = task
        await asyncio.wait({task}, timeout=limit)
        if not task.done():
            log.info(
                "Alert rules are still being brought up to date after %g s; "
                "the engine starts and that carries on.",
                limit,
            )
        self.engine.start()

    async def close(self) -> None:
        """Release what the services hold, before the database engine is disposed: the alert
        engine stops (checks in flight end, their writes finish), the notifier's queued
        deliveries get up to 15 s and the rest are cancelled; then the catalog builds in flight
        (cancelled), then the transports' and the senders' HTTP sessions (the stores share the
        app's engine). A startup reconcile still running is cancelled first; a rule whose
        targets it is writing finishes handing them over before it stops."""
        task, self.startup_reconcile = self.startup_reconcile, None
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await self.engine.stop()
        await self.notifier.drain()
        await self.notifier.close()
        await self.catalogs.close()
        await self.transports.close()
        await self.senders.close()


def build_services(
    sessionmaker: async_sessionmaker[AsyncSession],
    box: SecretBox,
    connections: ClusterConnections,
    registry: ClusterRegistry,
    *,
    audit: AuditLog,
    alert_engine: bool,
) -> MonitoringServices:
    """The one place that wires the Monitoring services; `main.py` calls it in the lifespan.
    `alert_engine` False (OMNIKRUX_ALERT_ENGINE=false): the engine is built but never starts,
    and nothing else that would run in its loop starts either."""
    from omnikrux.monitoring.alerts.engine import AlertEngine
    from omnikrux.monitoring.alerts.notify import Notifier
    from omnikrux.monitoring.alerts.sync import AlertSync

    sources = SourceStore(sessionmaker, box)
    transports = TransportFactory(connections, registry)
    connectors = default_connectors()
    discovery = Discovery(connections, registry, transports, connectors, sources)
    services = MonitoringServices(
        sources=sources,
        projects=ProjectStore(sessionmaker),
        groups=GroupStore(sessionmaker),
        dashboards=DashboardStore(sessionmaker),
        transports=transports,
        connectors=connectors,
        health=HealthCache(sources, transports, connectors, registry),
        discovery=discovery,
        catalogs=CatalogCache(),
        alerts=AlertStore(sessionmaker),
        contact_points=ContactPointStore(sessionmaker, box),
        senders=SenderSet(),
        silences=SilenceStore(sessionmaker),
        audit=audit,
        sessionmaker=sessionmaker,
        capabilities=CapabilityCache(connectors, transports, discovery, registry),
    )
    services.notifier = Notifier(services)
    services.engine = AlertEngine(services, enabled=alert_engine)
    services.alert_sync = AlertSync(services)
    return services
