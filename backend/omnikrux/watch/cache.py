import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable, Sequence
from typing import Literal

from omnikrux.kube.client import ClusterUnavailable
from omnikrux.resources.rows import ResourceRow
from omnikrux.watch.source import Expired, ResourceSource, WatchEvent

logger = logging.getLogger(__name__)

State = Literal["syncing", "ready", "error"]

SNAPSHOT_PART_SIZE = 500


class WatchCache:
    """List+watch one kind on one cluster and fan snapshots and deltas out to subscribers."""

    def __init__(
        self,
        cluster_id: str,
        source_factory: Callable[[], Awaitable[ResourceSource]],
        to_row: Callable[[dict, str], ResourceRow],
        *,
        backoff: Sequence[float] = (1, 2, 5, 10, 30),
    ):
        self.cluster_id = cluster_id
        self._source_factory = source_factory
        self._to_row = to_row
        self._backoff = tuple(backoff)
        self.state: State = "syncing"
        self.message: str | None = None
        self.rows: dict[str, dict] = {}  # uid -> JSON-ready row
        self._subscribers: list[asyncio.Queue[dict]] = []
        self._retry = asyncio.Event()
        self._task: asyncio.Task | None = None
        self._source: ResourceSource | None = None

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run(), name=f"watch-cache:{self.cluster_id}")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self._discard_source()

    def subscribe(self) -> asyncio.Queue[dict]:
        q: asyncio.Queue[dict] = asyncio.Queue()
        q.put_nowait(self._status_message())
        if self.state == "ready":
            for msg in self._snapshot_messages():
                q.put_nowait(msg)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict]) -> None:
        with contextlib.suppress(ValueError):
            self._subscribers.remove(q)

    async def retry_now(self) -> None:
        self._retry.set()

    # --- loop -----------------------------------------------------------------

    async def _run(self) -> None:
        step = 0
        while True:
            try:
                self._set_state("syncing", None)
                source = self._source = await self._source_factory()
                rv = await self._relist(source)
                step = 0
                while True:
                    try:
                        rv = await self._watch(source, rv)
                    except Expired:
                        rv = await self._relist(source)
            except Exception as exc:
                await self._discard_source()
                if isinstance(exc, ClusterUnavailable):
                    message = exc.message
                    logger.warning("cluster %s unavailable: %s", self.cluster_id, message)
                else:
                    message = f"Can't reach this cluster: {str(exc) or type(exc).__name__}"
                    logger.warning("watch failed for cluster %s", self.cluster_id, exc_info=True)
                self._retry.clear()
                self._set_state("error", message)
                delay = self._backoff[min(step, len(self._backoff) - 1)]
                step += 1
                await self._wait_backoff(delay)

    async def _relist(self, source: ResourceSource) -> str:
        items, rv = await source.list()
        rows = {}
        for obj in items:
            if (row := self._row(obj)) is not None:
                rows[row["uid"]] = row
        self.rows = rows
        self._set_state("ready", None)
        for msg in self._snapshot_messages():
            self._broadcast(msg)
        return rv

    async def _watch(self, source: ResourceSource, rv: str) -> str:
        """Apply events until the watch ends normally; return the latest resourceVersion."""
        events = source.watch(rv)
        try:
            async for event in events:
                rv = ((event.object.get("metadata") or {}).get("resourceVersion")) or rv
                self._apply(event)
        finally:
            aclose = getattr(events, "aclose", None)
            if aclose is not None:
                await aclose()
        return rv

    def _apply(self, event: WatchEvent) -> None:
        if event.type == "DELETED":
            uid = (event.object.get("metadata") or {}).get("uid", "")
            self.rows.pop(uid, None)
            self._broadcast({"type": "delete", "cluster_id": self.cluster_id, "uid": uid})
            return
        if (row := self._row(event.object)) is not None:
            self.rows[row["uid"]] = row
            self._broadcast({"type": "upsert", "cluster_id": self.cluster_id, "row": row})

    async def _discard_source(self) -> None:
        """Release the current source's resources (its API client), if it has any."""
        source, self._source = self._source, None
        aclose = getattr(source, "aclose", None)
        if aclose is None:
            return
        try:
            await aclose()
        except Exception:
            logger.debug("closing the source for cluster %s failed", self.cluster_id, exc_info=True)

    async def _wait_backoff(self, delay: float) -> None:
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(delay):
                await self._retry.wait()

    # --- helpers --------------------------------------------------------------

    def _row(self, obj: dict) -> dict | None:
        try:
            return self._to_row(obj, self.cluster_id).model_dump(mode="json")
        except Exception:
            md = (obj.get("metadata") or {}) if isinstance(obj, dict) else {}
            logger.warning(
                "skipping object %s/%s on cluster %s: could not build its row",
                md.get("namespace"),
                md.get("name"),
                self.cluster_id,
                exc_info=True,
            )
            return None

    def _set_state(self, state: State, message: str | None) -> None:
        if (state, message) == (self.state, self.message):
            return
        self.state, self.message = state, message
        self._broadcast(self._status_message())

    def _status_message(self) -> dict:
        return {
            "type": "cluster_status",
            "cluster_id": self.cluster_id,
            "state": self.state,
            "message": self.message,
        }

    def _snapshot_messages(self) -> list[dict]:
        rows = list(self.rows.values())
        parts = [rows[i : i + SNAPSHOT_PART_SIZE] for i in range(0, len(rows), SNAPSHOT_PART_SIZE)] or [[]]
        return [
            {"type": "snapshot", "cluster_id": self.cluster_id, "rows": part, "part": n, "last": n == len(parts) - 1}
            for n, part in enumerate(parts)
        ]

    def _broadcast(self, msg: dict) -> None:
        for q in self._subscribers:
            q.put_nowait(msg)
