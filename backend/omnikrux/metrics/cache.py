"""Metrics for every cluster, fetched at most once per (cluster, kind) per TTL.

A metric is only worth showing while it is live, so a failed fetch answers with no items at all;
the numbers of an earlier good fetch are never kept to fall back on."""

import asyncio
import logging
import time
from contextlib import AsyncExitStack
from datetime import UTC, datetime
from typing import Literal

from kubernetes_asyncio.client import ApiClient

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
        self._node_sizes_cache: dict[str, tuple[float, dict[str, NodeSize]]] = {}
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
        async with AsyncExitStack() as stack:
            try:
                api = await stack.enter_async_context(self._connections.api(cluster_id))
            except KeyError as exc:  # only the cluster lookup says "unknown cluster"
                raise UnknownCluster(cluster_id) from exc
            fetched = datetime.now(UTC)
            nodes = {}
            if kind == "pods":
                items, nodes = await asyncio.gather(
                    fetch_usage(api, kind, timeout=self.timeout, fetched=fetched),
                    self._node_sizes(api, cluster_id),
                    return_exceptions=True,
                )
                if isinstance(items, BaseException):
                    raise items
                if isinstance(nodes, BaseException):
                    raise nodes
            else:
                items = await fetch_usage(api, kind, timeout=self.timeout, fetched=fetched)
        return ClusterMetrics(
            state="ok",
            fetched_at=fetched.isoformat().replace("+00:00", "Z"),
            items=items,
            nodes=nodes,
        )

    async def _node_sizes(self, api: ApiClient, cluster_id: str) -> dict[str, NodeSize]:
        cached = self._node_sizes_cache.get(cluster_id)
        if cached is not None and time.monotonic() - cached[0] < NODE_SIZES_TTL:
            return cached[1]
        timeout = min(5, self.timeout / 2)
        try:
            nodes = await asyncio.wait_for(fetch_node_sizes(api, timeout=timeout), timeout)
        except Exception as exc:  # noqa: BLE001 (optional sizes never fail valid pod usage)
            log.info("Could not read node sizes (%s)", type(exc).__name__)
            return {}
        self._node_sizes_cache[cluster_id] = (time.monotonic(), nodes)
        return nodes

    async def close(self) -> None:
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
