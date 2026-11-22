"""Everything the Monitoring routes need, built once at startup as `app.state.monitoring`."""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.kube.connections import ClusterConnections
from omnikrux.monitoring.dashboards.store import DashboardStore
from omnikrux.monitoring.explore.catalog import CatalogCache
from omnikrux.monitoring.projects.store import GroupStore, ProjectStore
from omnikrux.monitoring.sources.connector import ConnectorRegistry, default_connectors
from omnikrux.monitoring.sources.discovery import Discovery
from omnikrux.monitoring.sources.health import HealthCache
from omnikrux.monitoring.sources.store import SourceStore
from omnikrux.monitoring.sources.transport import TransportFactory
from omnikrux.security.secrets import SecretBox


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

    async def close(self) -> None:
        """Release what the services hold: the catalog builds in flight (cancelled), then the
        transports' HTTP session (the stores share the app's engine)."""
        await self.catalogs.close()
        await self.transports.close()


def build_services(
    sessionmaker: async_sessionmaker[AsyncSession],
    box: SecretBox,
    connections: ClusterConnections,
    registry: ClusterRegistry,
) -> MonitoringServices:
    """The one place that wires the Monitoring services; `main.py` calls it in the lifespan."""
    sources = SourceStore(sessionmaker, box)
    transports = TransportFactory(connections, registry)
    connectors = default_connectors()
    return MonitoringServices(
        sources=sources,
        projects=ProjectStore(sessionmaker),
        groups=GroupStore(sessionmaker),
        dashboards=DashboardStore(sessionmaker),
        transports=transports,
        connectors=connectors,
        health=HealthCache(sources, transports, connectors, registry),
        discovery=Discovery(connections, registry, transports, connectors, sources),
        catalogs=CatalogCache(),
    )
