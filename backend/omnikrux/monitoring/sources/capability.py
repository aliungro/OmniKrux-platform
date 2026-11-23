"""Whether a source's own tool can run alert rules, remembered for a while.

A capability is read again after `ttl` seconds, or at once when the source was edited (its
`updated_at` moved). A check that fails is never remembered: the next ask tries again, and the
caller gets `CapabilityUnknown` with words it can show."""

import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.monitoring.sources.connector import (
    AlertingCapability,
    ClusterProbe,
    ConnectorRegistry,
    QueryRejected,
    UnknownSourceType,
)
from omnikrux.monitoring.sources.discovery import Discovery
from omnikrux.monitoring.sources.transport import SourceUnreachable, TransportFactory
from omnikrux.monitoring.sources.types import SourceConfig


class CapabilityUnknown(Exception):
    """The capability couldn't be read. `message` is plain words; `status` the HTTP status a
    route answers with (504 when the tool took too long, else 502 or the tool's refusal)."""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


@dataclass(frozen=True)
class _Entry:
    capability: AlertingCapability
    updated_at: datetime  # the source's, so an edited source is read again
    at: float  # monotonic time of the read


class CapabilityCache:
    def __init__(
        self,
        connectors: ConnectorRegistry,
        transports: TransportFactory,
        discovery: Discovery,
        registry: ClusterRegistry,
        *,
        ttl: float = 300.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._connectors = connectors
        self._transports = transports
        self._discovery = discovery
        self._registry = registry
        self._ttl = ttl
        self._clock = clock
        self._entries: dict[str, _Entry] = {}

    async def get(self, source: SourceConfig, *, refresh: bool = False) -> AlertingCapability:
        """What the source's tool can run; read again when `refresh`, when the source changed,
        or after `ttl` seconds. CapabilityUnknown when it can't be read."""
        hit = self._entries.get(source.id)
        if (
            not refresh
            and hit is not None
            and hit.updated_at == source.updated_at
            and 0 <= self._clock() - hit.at < self._ttl
        ):
            return hit.capability
        try:
            connector = self._connectors.get(source.type)
        except UnknownSourceType as exc:
            raise CapabilityUnknown(exc.message) from None
        probe: ClusterProbe | None = None
        if source.reach == "cluster" and source.cluster is not None:
            try:
                await self._registry.get(source.cluster.cluster_id)
            except KeyError:  # a cluster OmniKrux no longer knows serves nothing
                pass
            else:
                probe = self._discovery.probe(source.cluster.cluster_id)
        try:
            capability = await connector.alerting(
                self._transports.for_source(source), cluster=probe
            )
        except SourceUnreachable as exc:
            self._entries.pop(source.id, None)
            raise CapabilityUnknown(exc.message, 504 if exc.code == "timeout" else 502) from None
        except QueryRejected as exc:
            self._entries.pop(source.id, None)
            raise CapabilityUnknown(exc.message, exc.status) from None
        self._entries[source.id] = _Entry(capability, source.updated_at, self._clock())
        return capability

    def forget(self, source_id: str) -> None:
        self._entries.pop(source_id, None)
