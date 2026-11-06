import asyncio
import logging
from collections.abc import Awaitable, Callable, Iterable
from typing import Protocol

from omnikrux.clusters.registry import ClusterInfo
from omnikrux.resources.kinds import KINDS, KindSpec
from omnikrux.watch.cache import WatchCache
from omnikrux.watch.source import ResourceSource

logger = logging.getLogger(__name__)

Key = tuple[str, str]  # (cluster_id, kind_key)
SourceFor = Callable[[str, KindSpec], Awaitable[ResourceSource]]

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

    def __init__(self, hub: "WatchHub", queues: dict[Key, asyncio.Queue[dict]]):
        self._hub = hub
        self._queues = queues
        self._out: asyncio.Queue = asyncio.Queue()
        self._closed = False
        self._tasks = [
            asyncio.create_task(self._forward(q), name=f"watch-sub:{cid}/{kind}") for (cid, kind), q in queues.items()
        ]

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
        for task in self._tasks:
            task.cancel()
        self._out.put_nowait(_CLOSED)
        self._hub._release(self, self._queues)
        await _wait_all(self._tasks)


class WatchHub:
    """Shares one `WatchCache` per (cluster, kind) across subscriptions.

    A cache starts with its first subscriber and stops `idle_seconds` after its last one leaves.
    """

    def __init__(self, registry: ClusterLister, source_for: SourceFor, *, idle_seconds: float = 60):
        self._registry = registry
        self._source_for = source_for
        self._idle_seconds = idle_seconds
        self._caches: dict[Key, WatchCache] = {}
        self._refs: dict[Key, int] = {}
        self._evictions: dict[Key, asyncio.Task] = {}
        self._subscriptions: set[Subscription] = set()

    async def subscribe(self, kind_key: str, cluster_ids: list[str] | None = None) -> Subscription:
        spec = KINDS[kind_key]
        if cluster_ids is None:
            cluster_ids = [c.id for c in await self._registry.list()]
        # No awaits from here until every cache is registered: concurrent subscribes and
        # pending evictions see a consistent view of the caches and their ref counts.
        queues: dict[Key, asyncio.Queue[dict]] = {}
        for cid in dict.fromkeys(cluster_ids):
            key = (cid, kind_key)
            queues[key] = self._acquire(key, spec).subscribe()
        sub = Subscription(self, queues)
        self._subscriptions.add(sub)
        for key in queues:
            await self._caches[key].start()
        return sub

    def status(self, cluster_id: str) -> tuple[str, str | None]:
        caches = [c for (cid, _), c in self._caches.items() if cid == cluster_id]
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

    def _acquire(self, key: Key, spec: KindSpec) -> WatchCache:
        if (pending := self._evictions.pop(key, None)) is not None:
            pending.cancel()
        cache = self._caches.get(key)
        if cache is None:
            cid = key[0]
            cache = self._caches[key] = WatchCache(cid, lambda: self._source_for(cid, spec), spec.to_row)
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
                self._evictions[key] = asyncio.create_task(self._evict_later(key), name=f"watch-evict:{key}")

    async def _evict_later(self, key: Key) -> None:
        await asyncio.sleep(self._idle_seconds)
        # Still idle: a subscribe in the meantime would have cancelled this task.
        self._evictions.pop(key, None)
        self._refs.pop(key, None)
        if (cache := self._caches.pop(key, None)) is not None:
            logger.debug("stopping idle watch %s", key)
            await cache.stop()
