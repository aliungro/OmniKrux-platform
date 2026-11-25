"""Whether each source answers: checked at most every 30 seconds, a few at a time.

A source never checked reads `unknown`; a failed check is `down` with the transport's words. Two
things are known without asking the tool, whatever the cache holds: a cluster-reached source
whose cluster OmniKrux no longer knows, and a source whose saved secrets can't be decrypted."""

import asyncio
import logging
import time
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.monitoring.sources import messages
from omnikrux.monitoring.sources.connector import (
    Connector,
    ConnectorRegistry,
    TestResult,
    is_not_an_api,
)
from omnikrux.monitoring.sources.store import SourceStore
from omnikrux.monitoring.sources.transport import SourceTransport, TransportFactory
from omnikrux.monitoring.sources.types import SourceCheck, SourceConfig

log = logging.getLogger(__name__)

SECRETS_UNREADABLE = (
    "OmniKrux can't read this source's saved credentials: its encryption key changed. "
    "Enter the credentials and header values again."
)
CHECK_FAILED = "Couldn't check {name}. Try again."


class HealthOut(BaseModel):
    state: Literal["up", "down", "unknown"]
    message: str | None
    version: str | None
    checked_at: datetime | None
    # The tool answered over HTTP, but not as its type: down, with the address or type to check.
    answered: bool = False


UNKNOWN = HealthOut(state="unknown", message=None, version=None, checked_at=None)


@dataclass
class _Entry:
    health: HealthOut
    updated_at: datetime  # the source's, so an edited source is checked again
    at: float  # monotonic time of the check


async def run_test(
    connector: Connector, transport: SourceTransport, name: str, timeout: float
) -> TestResult:
    """The connector's test within `timeout` seconds; never raises."""
    try:
        async with asyncio.timeout(timeout):
            return await connector.test(transport, name)
    except TimeoutError:
        return TestResult(False, None, messages.TIMEOUT.format(name=name, seconds=f"{timeout:g}"))
    except Exception as exc:  # noqa: BLE001 - becomes the test's answer, in words
        log.warning("Could not test a monitoring source (%s)", type(exc).__name__)
        return TestResult(False, None, CHECK_FAILED.format(name=name))


def _from_check(check: SourceCheck) -> HealthOut:
    return HealthOut(
        state="up" if check.ok else "down",
        message=check.message,
        version=check.version,
        checked_at=check.checked_at,
        answered=check.answered or (not check.ok and is_not_an_api(check.message)),
    )


class HealthCache:
    def __init__(
        self,
        sources: SourceStore,
        transports: TransportFactory,
        connectors: ConnectorRegistry,
        registry: ClusterRegistry,
        *,
        ttl: float = 30.0,
        timeout: float = 5.0,
        concurrency: int = 8,
    ) -> None:
        self._sources = sources
        self._transports = transports
        self._connectors = connectors
        self._registry = registry
        self.ttl = ttl
        self.timeout = timeout
        self._limit = asyncio.Semaphore(concurrency)
        self._entries: dict[str, _Entry] = {}

    async def _cluster_ids(self) -> set[str]:
        return {c.id for c in await self._registry.list()}

    @staticmethod
    def _known_down(source: SourceConfig, clusters: set[str]) -> HealthOut | None:
        """The health that needs no check: the cluster is gone, or the secrets can't be read."""
        if source.reach == "cluster" and (
            source.cluster is None or source.cluster.cluster_id not in clusters
        ):
            message = messages.UNKNOWN_CLUSTER.format(name=source.name)
            return HealthOut(state="down", message=message, version=None, checked_at=None)
        if source.secrets_unreadable:
            return HealthOut(
                state="down", message=SECRETS_UNREADABLE, version=None, checked_at=None
            )
        return None

    def _fresh(self, source: SourceConfig) -> HealthOut | None:
        entry = self._entries.get(source.id)
        if (
            entry is not None
            and entry.updated_at == source.updated_at
            and time.monotonic() - entry.at < self.ttl
        ):
            return entry.health
        return None

    def _last(self, source: SourceConfig) -> HealthOut:
        """The newest known health without checking: the cache, else the stored check (unless
        the source changed after it), else unknown."""
        entry = self._entries.get(source.id)
        if entry is not None and entry.updated_at == source.updated_at:
            return entry.health
        check = source.check
        if check is not None and check.checked_at >= source.updated_at:
            return _from_check(check)
        return UNKNOWN

    async def peek(self, sources: Iterable[SourceConfig]) -> dict[str, HealthOut]:
        """Every source's last known health; asks no tool."""
        clusters = await self._cluster_ids()
        return {s.id: self._known_down(s, clusters) or self._last(s) for s in sources}

    async def all(self, sources: Iterable[SourceConfig], *, refresh: bool) -> dict[str, HealthOut]:
        """Every source's health: from the cache when it is fresh (and `refresh` is false),
        otherwise checked now, at most `concurrency` at a time."""
        sources = list(sources)
        clusters = await self._cluster_ids()

        async def one(source: SourceConfig) -> HealthOut:
            known = self._known_down(source, clusters)
            if known is not None:
                return known
            if not refresh and (cached := self._fresh(source)) is not None:
                return cached
            return await self._check(source, self.timeout)

        answers = await asyncio.gather(*(one(s) for s in sources))
        return {s.id: answer for s, answer in zip(sources, answers, strict=True)}

    async def check(self, source: SourceConfig, *, timeout: float | None = None) -> HealthOut:
        """Check the source now, keep the result in the cache and as its last check."""
        known = self._known_down(source, await self._cluster_ids())
        if known is not None:
            return known
        return await self._check(source, timeout or self.timeout)

    async def _check(self, source: SourceConfig, timeout: float) -> HealthOut:
        async with self._limit:
            try:
                connector = self._connectors.get(source.type)
                transport = self._transports.for_source(source)
            except Exception as exc:  # noqa: BLE001 - a stored row OmniKrux can't use
                log.warning("Could not check a monitoring source (%s)", type(exc).__name__)
                result = TestResult(False, None, CHECK_FAILED.format(name=source.name))
            else:
                result = await run_test(connector, transport, source.name, timeout)
        ok, version, message = result.ok, result.version, result.message
        checked_at = datetime.now(UTC)
        health = HealthOut(
            state="up" if ok else "down",
            message=message,
            version=version,
            checked_at=checked_at,
            answered=result.answered,
        )
        self._entries[source.id] = _Entry(health, source.updated_at, time.monotonic())
        try:
            await self._sources.record_check(
                source.id, SourceCheck(ok, message, version, checked_at)
            )
        except KeyError:  # removed meanwhile
            self._entries.pop(source.id, None)
        return health

    def forget(self, source_id: str) -> None:
        self._entries.pop(source_id, None)
