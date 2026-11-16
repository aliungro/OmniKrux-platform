"""Metrics for every cluster, fetched at most once per (cluster, kind) per TTL.

A metric is only worth showing while it is live, so a failed fetch answers with no items at all;
the numbers of an earlier good fetch are never kept to fall back on."""

import asyncio
import logging
import time
from contextlib import AsyncExitStack
from datetime import UTC, datetime
from typing import Literal

from omnikrux.kube.connections import ClusterConnections
from omnikrux.metrics.client import (
    NOT_ANSWERING,
    NOT_INSTALLED,
    UnknownCluster,
    failure_of,
    fetch_node_sizes,
    fetch_usage,
)
from omnikrux.metrics.models import ClusterMetrics, NodeSize

__all__ = ["NOT_ANSWERING", "NOT_INSTALLED", "MetricsCache"]

log = logging.getLogger(__name__)

Kind = Literal["pods", "nodes"]
NODE_SIZES_TTL = 300
# Node sizes are optional context for pod usage: they have their own budget (never the pods'),
# a failed list is not tried again for this long, and a pods answer waits at most
# NODE_SIZES_GRACE_SECONDS for a node list in flight, and only when it has no sizes at all.
NODE_SIZES_TIMEOUT = 5
NODE_SIZES_RETRY_SECONDS = 60
NODE_SIZES_GRACE_SECONDS = 0.5


class _Entry:
    def __init__(self) -> None:
        self.task: asyncio.Task[ClusterMetrics] | None = None
        self.result: ClusterMetrics | None = None
        self.finished = 0.0


class _NodeSizes:
    """One cluster's node sizes: the last good list, when to fetch again, the fetch in flight."""

    def __init__(self) -> None:
        self.sizes: dict[str, NodeSize] | None = None
        self.next_fetch = 0.0
        self.task: asyncio.Task[None] | None = None


class MetricsCache:
    def __init__(self, connections: ClusterConnections, *, ttl: float = 10, timeout: float = 10):
        self._connections = connections
        self.ttl = ttl
        self.timeout = timeout  # per cluster: a slow one answers `error`, the others go on
        self._entries: dict[tuple[str, str], _Entry] = {}
        self._node_sizes_cache: dict[str, _NodeSizes] = {}
        self._tasks: set[asyncio.Task] = set()

    @property
    def in_flight(self) -> int:
        return len(self._tasks)

    def _track(self, task: asyncio.Task) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def get(self, cluster_id: str, kind: Kind) -> ClusterMetrics:
        entry = self._entries.setdefault((cluster_id, kind), _Entry())
        if entry.result is not None and time.monotonic() - entry.finished < self.ttl:
            return entry.result
        if entry.task is None:
            task = asyncio.create_task(self._fetch(entry, cluster_id, kind))
            entry.task = task
            self._track(task)
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
        async with AsyncExitStack() as stack:
            try:
                api = await stack.enter_async_context(self._connections.api(cluster_id))
            except KeyError as exc:  # only the cluster lookup says "unknown cluster"
                raise UnknownCluster(cluster_id) from exc
            fetched = datetime.now(UTC)
            nodes: dict[str, NodeSize] = {}
            if kind == "pods":
                sizes = self._start_node_sizes(cluster_id)
                items = await fetch_usage(api, kind, timeout=self.timeout, fetched=fetched)
                nodes = await self._node_sizes(sizes)
            else:
                items = await fetch_usage(api, kind, timeout=self.timeout, fetched=fetched)
        return ClusterMetrics(
            state="ok",
            fetched_at=fetched.isoformat().replace("+00:00", "Z"),
            items=items,
            nodes=nodes,
        )

    def _start_node_sizes(self, cluster_id: str) -> _NodeSizes:
        """Start a node list in the background when one is due; never more than one at once."""
        sizes = self._node_sizes_cache.setdefault(cluster_id, _NodeSizes())
        if sizes.task is None and time.monotonic() >= sizes.next_fetch:
            sizes.task = asyncio.create_task(self._fetch_node_sizes(cluster_id, sizes))
            self._track(sizes.task)
        return sizes

    async def _node_sizes(self, sizes: _NodeSizes) -> dict[str, NodeSize]:
        """The last good sizes (also while a refresh runs); with none yet, a short wait for the
        list in flight. Never raises and never waits past NODE_SIZES_GRACE_SECONDS."""
        if sizes.sizes is None and sizes.task is not None:
            await asyncio.wait({sizes.task}, timeout=NODE_SIZES_GRACE_SECONDS)
        return sizes.sizes or {}

    async def _fetch_node_sizes(self, cluster_id: str, sizes: _NodeSizes) -> None:
        budget = min(NODE_SIZES_TIMEOUT, self.timeout / 2)
        try:
            async with asyncio.timeout(budget):
                async with self._connections.api(cluster_id) as api:
                    found = await fetch_node_sizes(api, timeout=budget)
        except Exception as exc:  # noqa: BLE001 (optional sizes never fail valid pod usage)
            log.info("Could not read node sizes (%s)", type(exc).__name__)
            sizes.sizes = None  # a failed list shows no sizes rather than old ones
            sizes.next_fetch = time.monotonic() + NODE_SIZES_RETRY_SECONDS
        else:
            sizes.sizes = found
            sizes.next_fetch = time.monotonic() + NODE_SIZES_TTL
        finally:
            sizes.task = None

    async def close(self) -> None:
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
