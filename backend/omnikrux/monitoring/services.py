"""Everything the Monitoring routes need, built once at startup as `app.state.monitoring`."""

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.kube.connections import ClusterConnections
from omnikrux.monitoring.projects.store import GroupStore, ProjectStore
from omnikrux.monitoring.sources.store import SourceStore
from omnikrux.monitoring.sources.transport import TransportFactory
from omnikrux.security.secrets import SecretBox


@dataclass
class MonitoringServices:
    sources: SourceStore
    projects: ProjectStore
    groups: GroupStore
    transports: TransportFactory

    async def close(self) -> None:
        """Release what the services hold: the transports' HTTP session (the stores share the
        app's engine)."""
        await self.transports.close()


def build_services(
    sessionmaker: async_sessionmaker[AsyncSession],
    box: SecretBox,
    connections: ClusterConnections,
    registry: ClusterRegistry,
) -> MonitoringServices:
    """The one place that wires the Monitoring services; `main.py` calls it in the lifespan."""
    return MonitoringServices(
        sources=SourceStore(sessionmaker, box),
        projects=ProjectStore(sessionmaker),
        groups=GroupStore(sessionmaker),
        transports=TransportFactory(connections, registry),
    )
