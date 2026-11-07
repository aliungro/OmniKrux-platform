"""Metrics for every cluster, fetched at most once per (cluster, kind) per TTL.

A metric is only worth showing while it is live, so a failed fetch answers with no items at all;
the numbers of an earlier good fetch are never kept to fall back on."""

import asyncio
import logging
import time
from datetime import UTC, datetime
from typing import Literal

from omnikrux.kube.connections import ClusterConnections
from omnikrux.metrics.client import NOT_ANSWERING, NOT_INSTALLED, failure_of, fetch_usage
from omnikrux.metrics.models import ClusterMetrics

__all__ = ["NOT_ANSWERING", "NOT_INSTALLED", "MetricsCache"]

log = logging.getLogger(__name__)

Kind = Literal["pods", "nodes"]


class _Entry:
    def __init__(self) -> None:
        self.task: asyncio.Task[ClusterMetrics] | None = None
        self.result: ClusterMetrics | None = None
        self.finished = 0.0


class MetricsCache:
    def __init__(self, connections: ClusterConnections, *, ttl: float = 10, timeout: float = 10):
        self._connections = connections
        self.ttl = ttl
        self.timeout = timeout  # per cluster: a slow one answers `error`, the others go on
        self._entries: dict[tuple[str, str], _Entry] = {}
        self._tasks: set[asyncio.Task] = set()

    @property
    def in_flight(self) -> int:
        return len(self._tasks)

    async def get(self, cluster_id: str, kind: Kind) -> ClusterMetrics:
        entry = self._entries.setdefault((cluster_id, kind), _Entry())
        if entry.result is not None and time.monotonic() - entry.finished < self.ttl:
            return entry.result
        if entry.task is None:
            task = asyncio.create_task(self._fetch(entry, cluster_id, kind))
            entry.task = task
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        # Shielded: a caller that gives up must not cancel the fetch the others wait on.
        return await asyncio.shield(entry.task)

    async def _fetch(self, entry: _Entry, cluster_id: str, kind: Kind) -> ClusterMetrics:
        try:
            result = await asyncio.wait_for(self._read(cluster_id, kind), self.timeout)
        except Exception as exc:  # noqa: BLE001 (every failure becomes words, with no items)
            state, message = failure_of(exc)
            if state == "error" and not isinstance(exc, TimeoutError):
                log.info(
                    "Could not read %s metrics of %s (%s)", kind, cluster_id, type(exc).__name__
                )
            result = ClusterMetrics(state=state, message=message)
        finally:
            entry.task = None
        entry.result = result  # a failure replaces any earlier good answer
        entry.finished = time.monotonic()
        return result

    async def _read(self, cluster_id: str, kind: Kind) -> ClusterMetrics:
        async with self._connections.api(cluster_id) as api:
            fetched = datetime.now(UTC)
            items = await fetch_usage(api, kind, timeout=self.timeout, fetched=fetched)
        return ClusterMetrics(
            state="ok", fetched_at=fetched.isoformat().replace("+00:00", "Z"), items=items
        )

    async def close(self) -> None:
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
