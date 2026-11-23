"""Everything the Monitoring routes need, built once at startup as `app.state.monitoring`."""

from __future__ import annotations

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
    # Set by `build_services` (they need the services themselves).
    notifier: Notifier = field(init=False)
    engine: AlertEngine = field(init=False)

    async def close(self) -> None:
        """Release what the services hold, before the database engine is disposed: the alert
        engine stops (checks in flight end, their writes finish), the notifier's queued
        deliveries get up to 15 s and the rest are cancelled; then the catalog builds in flight
        (cancelled), then the transports' and the senders' HTTP sessions (the stores share the
        app's engine)."""
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

    sources = SourceStore(sessionmaker, box)
    transports = TransportFactory(connections, registry)
    connectors = default_connectors()
    services = MonitoringServices(
        sources=sources,
        projects=ProjectStore(sessionmaker),
        groups=GroupStore(sessionmaker),
        dashboards=DashboardStore(sessionmaker),
        transports=transports,
        connectors=connectors,
        health=HealthCache(sources, transports, connectors, registry),
        discovery=Discovery(connections, registry, transports, connectors, sources),
        catalogs=CatalogCache(),
        alerts=AlertStore(sessionmaker),
        contact_points=ContactPointStore(sessionmaker, box),
        senders=SenderSet(),
        silences=SilenceStore(sessionmaker),
        audit=audit,
        sessionmaker=sessionmaker,
    )
    services.notifier = Notifier(services)
    services.engine = AlertEngine(services, enabled=alert_engine)
    return services
