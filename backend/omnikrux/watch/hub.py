import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterable
from typing import Protocol

from omnikrux.clusters.registry import ClusterInfo
from omnikrux.resources.kinds import is_kind_key
from omnikrux.watch.cache import WatchCache
from omnikrux.watch.source import ResourceSource

logger = logging.getLogger(__name__)

Key = tuple[str, str]  # (cluster_id, kind_key)
# (cluster id, kind key) -> a source; raises KindNotServed when the cluster doesn't serve the kind.
SourceFor = Callable[[str, str], Awaitable[ResourceSource]]

_STATE_RANK = {"error": 0, "syncing": 1, "ready": 2}
_CLOSED = object()


async def _wait_all(tasks: Iterable[asyncio.Task]) -> None:
    """Wait for (cancelled) tasks to finish without raising their exceptions.

    Unlike `suppress(CancelledError): await task`, this never swallows a cancellation of the caller.
    """
    if tasks := list(tasks):
        await asyncio.wait(tasks)


class ClusterLister(Protocol):
    async def list(self) -> list[ClusterInfo]: ...


class Subscription:
    """Merged stream of messages from several caches; per-cache order is preserved.

    Messages are shared with other subscribers: treat them as read-only.
    """

    def __init__(
        self,
        hub: "WatchHub",
        kind_key: str,
        queues: dict[Key, asyncio.Queue[dict]],
        *,
        scope_all: bool = False,
    ):
        self._hub = hub
        self.kind_key = kind_key
        self.scope_all = scope_all  # follows clusters added to and removed from the registry
        self._queues: dict[Key, asyncio.Queue[dict]] = {}
        self._tasks: dict[Key, asyncio.Task] = {}
        self._out: asyncio.Queue = asyncio.Queue()
        self._closed = False
        for key, q in queues.items():
            self._attach(key, q)

    def _attach(self, key: Key, q: asyncio.Queue[dict]) -> None:
        cid, kind = key
        self._queues[key] = q
        self._tasks[key] = asyncio.create_task(self._forward(q), name=f"watch-sub:{cid}/{kind}")

    def _detach(self, key: Key) -> tuple[asyncio.Queue[dict], asyncio.Task]:
        """Stop forwarding `key`'s queue; the caller unsubscribes it and awaits the task."""
        task = self._tasks.pop(key)
        task.cancel()
        return self._queues.pop(key), task

    async def _forward(self, q: asyncio.Queue[dict]) -> None:
        while True:
            self._out.put_nowait(await q.get())

    def __aiter__(self) -> "Subscription":
        return self

    async def __anext__(self) -> dict:
        if self._closed:
            raise StopAsyncIteration
        msg = await self._out.get()
        if msg is _CLOSED:
            self._out.put_nowait(_CLOSED)  # wake any other waiter too
            raise StopAsyncIteration
        return msg

    async def close(self) -> None:
        if self._closed:
            return
        # Release synchronously first, so a cancellation of the caller can't skip it.
        self._closed = True
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        self._out.put_nowait(_CLOSED)
        self._hub._release(self, self._queues)
        await _wait_all(tasks)


class WatchHub:
    """Shares one `WatchCache` per (cluster, kind) across subscriptions.

    A cache starts with its first subscriber and stops `idle_seconds` after its last one leaves.
    `on_forget` is awaited for every cluster the hub forgets (so per-cluster state elsewhere,
    such as the kind catalog, goes with it).
    """

    def __init__(
        self,
        registry: ClusterLister,
        source_for: SourceFor,
        *,
        idle_seconds: float = 60,
        on_forget: Callable[[str], Awaitable[None]] | None = None,
    ):
        self._registry = registry
        self._source_for = source_for
        self._idle_seconds = idle_seconds
        self._on_forget = on_forget
        self._caches: dict[Key, WatchCache] = {}
        self._refs: dict[Key, int] = {}
        self._evictions: dict[Key, asyncio.Task] = {}
        self._subscriptions: set[Subscription] = set()
        # Serializes reading the registry with attaching to or forgetting its clusters, so a
        # subscription never misses a cluster added (or keeps one removed) while it was listing.
        self._lock = asyncio.Lock()

    async def subscribe(self, kind_key: str, cluster_ids: list[str] | None = None) -> Subscription:
        """Stream `kind_key` from `cluster_ids`, or from every registered cluster (now and
        later: see `clusters_changed`). KeyError when `kind_key` isn't a kind key at all; a
        cluster that doesn't serve the kind streams an `absent` status."""
        if not is_kind_key(kind_key):
            raise KeyError(kind_key)
        async with self._lock:
            scope_all = cluster_ids is None
            if cluster_ids is None:
                cluster_ids = [c.id for c in await self._registry.list()]
            # No awaits from here until every cache is registered: concurrent subscribes and
            # pending evictions see a consistent view of the caches and their ref counts.
            queues: dict[Key, asyncio.Queue[dict]] = {}
            for cid in dict.fromkeys(cluster_ids):
                key = (cid, kind_key)
                queues[key] = self._acquire(key).subscribe()
            sub = Subscription(self, kind_key, queues, scope_all=scope_all)
            self._subscriptions.add(sub)
            for key in queues:
                await self._caches[key].start()
        return sub

    async def clusters_changed(self) -> None:
        """Follow the registry: attach new clusters to all-cluster subscriptions and forget
        clusters that are gone."""
        async with self._lock:
            current = [c.id for c in await self._registry.list()]
            # No awaits until every new queue is attached (see `subscribe`).
            started: list[WatchCache] = []
            for sub in list(self._subscriptions):
                if sub._closed or not sub.scope_all:
                    continue
                for cid in current:
                    key = (cid, sub.kind_key)
                    if key not in sub._queues:
                        cache = self._acquire(key)
                        sub._attach(key, cache.subscribe())
                        started.append(cache)
            for cache in started:
                await cache.start()
            known = {cid for cid, _ in self._caches}
            for sub in self._subscriptions:
                known.update(cid for cid, _ in sub._queues)
            for cid in known.difference(current):
                await self._forget(cid)

    async def forget(self, cluster_id: str) -> None:
        """Stop and drop every cache of a removed cluster and tell its subscribers.

        A no-op for a cluster the hub isn't watching."""
        async with self._lock:
            await self._forget(cluster_id)

    def status(self, cluster_id: str) -> tuple[str, str | None]:
        """The worst state of the cluster's watches; a kind it doesn't serve says nothing about it."""
        caches = [
            c for (cid, _), c in self._caches.items() if cid == cluster_id and c.state != "absent"
        ]
        if not caches:
            return ("unknown", None)
        worst = min(caches, key=lambda c: _STATE_RANK[c.state])
        return (worst.state, worst.message)

    async def retry(self, cluster_id: str) -> None:
        for (cid, _), cache in list(self._caches.items()):
            if cid == cluster_id:
                await cache.retry_now()

    async def close(self) -> None:
        for sub in list(self._subscriptions):
            await sub.close()
        evictions, self._evictions = self._evictions, {}
        for task in evictions.values():
            task.cancel()
        await _wait_all(evictions.values())
        caches, self._caches, self._refs = self._caches, {}, {}
        for cache in caches.values():
            await cache.stop()

    # --- internals ------------------------------------------------------------

    async def _forget(self, cluster_id: str) -> None:
        # Detach and drop everything synchronously, then wait for the stopped tasks.
        tasks: list[asyncio.Task] = []
        for sub in list(self._subscriptions):
            keys = [key for key in sub._queues if key[0] == cluster_id]
            if sub._closed or not keys:
                continue
            for key in keys:
                q, task = sub._detach(key)
                tasks.append(task)
                if (cache := self._caches.get(key)) is not None:
                    cache.unsubscribe(q)
            sub._out.put_nowait({"type": "cluster_removed", "cluster_id": cluster_id})
        caches: list[WatchCache] = []
        for key in [key for key in self._caches if key[0] == cluster_id]:
            if (pending := self._evictions.pop(key, None)) is not None:
                pending.cancel()
                tasks.append(pending)
            self._refs.pop(key, None)
            caches.append(self._caches.pop(key))
        if caches:
            logger.debug("forgetting the watches of removed cluster %s", cluster_id)
        await _wait_all(tasks)
        for cache in caches:
            await cache.stop()
        if self._on_forget is not None:
            try:
                await self._on_forget(cluster_id)
            except Exception:
                logger.warning("forgetting cluster %s elsewhere failed", cluster_id, exc_info=True)

    def _acquire(self, key: Key) -> WatchCache:
        if (pending := self._evictions.pop(key, None)) is not None:
            pending.cancel()
        cache = self._caches.get(key)
        if cache is None:
            cid, kind_key = key
            cache = self._caches[key] = WatchCache(cid, lambda: self._source_for(cid, kind_key))
        self._refs[key] = self._refs.get(key, 0) + 1
        return cache

    def _release(self, sub: Subscription, queues: dict[Key, asyncio.Queue[dict]]) -> None:
        self._subscriptions.discard(sub)
        for key, q in queues.items():
            cache = self._caches.get(key)
            if cache is None:  # the hub is closed
                continue
            cache.unsubscribe(q)
            self._refs[key] -= 1
            if self._refs[key] == 0:
                self._evictions[key] = asyncio.create_task(
                    self._evict_later(key), name=f"watch-evict:{key}"
                )

    async def _evict_later(self, key: Key) -> None:
        await asyncio.sleep(self._idle_seconds)
        # Still idle: a subscribe in the meantime would have cancelled this task.
        self._evictions.pop(key, None)
        self._refs.pop(key, None)
        if (cache := self._caches.pop(key, None)) is not None:
            logger.debug("stopping idle watch %s", key)
            await cache.stop()
