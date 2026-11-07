import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable, Sequence
from typing import Literal

from omnikrux.kube.client import ClusterUnavailable
from omnikrux.resources.catalog import KindNotServed
from omnikrux.watch.source import Expired, ResourceSource, WatchEvent

logger = logging.getLogger(__name__)

State = Literal["syncing", "ready", "error", "absent"]

SNAPSHOT_PART_SIZE = 500
# How often to ask again whether a cluster that doesn't serve the kind serves it now.
ABSENT_RECHECK_SECONDS = 300


class WatchCache:
    """List+watch one kind on one cluster and fan snapshots and deltas out to subscribers.

    When the factory raises `KindNotServed`, the cache is `absent` (with that message and no
    rows) and asks again every `ABSENT_RECHECK_SECONDS`, or at once on `retry_now`.
    """

    def __init__(
        self,
        cluster_id: str,
        source_factory: Callable[[], Awaitable[ResourceSource]],
        *,
        backoff: Sequence[float] = (1, 2, 5, 10, 30),
        stable_seconds: float = 30,
        min_watch_interval: float = 1,
    ):
        """`backoff` steps reset only once a watch proved stable: it delivered an event or stayed
        up for `stable_seconds`. Watches restart at most once per `min_watch_interval` seconds."""
        self.cluster_id = cluster_id
        self._source_factory = source_factory
        self._backoff = tuple(backoff)
        self._stable_seconds = stable_seconds
        self._min_watch_interval = min_watch_interval
        self._stable = False  # the current attempt's watch has proved stable
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
        loop = asyncio.get_running_loop()
        step = 0
        last_error: str | None = None
        while True:
            self._stable = False
            try:
                # While retrying, keep the last failure's reason visible (with Retry in the UI).
                # An absent kind stays absent while it is asked again.
                syncing = None if last_error is None else f"Retrying — {last_error}"
                if self.state != "absent":
                    self._set_state("syncing", syncing)
                try:
                    source = self._source = await self._source_factory()
                except KindNotServed as exc:
                    self._retry.clear()
                    self.rows = {}
                    self._set_state("absent", exc.message)
                    step, last_error = 0, None
                    await self._wait_backoff(ABSENT_RECHECK_SECONDS)
                    continue
                if self.state == "absent":
                    self._set_state("syncing", None)
                rv = await self._relist(source)
                last_start: float | None = None
                while True:
                    if (
                        last_start is not None
                        and (wait := last_start + self._min_watch_interval - loop.time()) > 0
                    ):
                        await asyncio.sleep(wait)
                    last_start = loop.time()
                    try:
                        rv = await self._watch(source, rv)
                    except Expired:
                        rv = await self._relist(source)
            except Exception as exc:
                await self._discard_source()
                if self._stable:
                    step = 0
                if isinstance(exc, ClusterUnavailable):
                    message = exc.message
                    logger.warning("cluster %s unavailable: %s", self.cluster_id, message)
                else:
                    message = f"Can't reach this cluster: {str(exc) or type(exc).__name__}"
                    logger.warning("watch failed for cluster %s", self.cluster_id, exc_info=True)
                self._retry.clear()
                self._set_state("error", message)
                last_error = message
                delay = self._backoff[min(step, len(self._backoff) - 1)]
                step += 1
                await self._wait_backoff(delay)

    async def _relist(self, source: ResourceSource) -> str:
        items, rv = await source.list()
        rows = {}
        for obj in items:
            if (row := self._row(source, obj)) is not None:
                rows[row["uid"]] = row
        self.rows = rows
        self._set_state("ready", None)
        for msg in self._snapshot_messages():
            self._broadcast(msg)
        return rv

    async def _watch(self, source: ResourceSource, rv: str) -> str:
        """Apply events until the watch ends normally; return the latest resourceVersion.

        Marks the attempt stable once the watch delivers an event or stays up `stable_seconds`.
        """
        started = asyncio.get_running_loop().time()
        events = source.watch(rv)
        try:
            async for event in events:
                self._stable = True
                rv = ((event.object.get("metadata") or {}).get("resourceVersion")) or rv
                self._apply(source, event)
        finally:
            if asyncio.get_running_loop().time() - started >= self._stable_seconds:
                self._stable = True
            aclose = getattr(events, "aclose", None)
            if aclose is not None:
                await aclose()
        return rv

    def _apply(self, source: ResourceSource, event: WatchEvent) -> None:
        if event.type == "DELETED":
            uid = (event.object.get("metadata") or {}).get("uid", "")
            self.rows.pop(uid, None)
            self._broadcast({"type": "delete", "cluster_id": self.cluster_id, "uid": uid})
            return
        if (row := self._row(source, event.object)) is not None:
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

    def _row(self, source: ResourceSource, obj: dict) -> dict | None:
        try:
            return source.to_row(obj, self.cluster_id).model_dump(mode="json")
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
        parts = [
            rows[i : i + SNAPSHOT_PART_SIZE] for i in range(0, len(rows), SNAPSHOT_PART_SIZE)
        ] or [[]]
        return [
            {
                "type": "snapshot",
                "cluster_id": self.cluster_id,
                "rows": part,
                "part": n,
                "last": n == len(parts) - 1,
            }
            for n, part in enumerate(parts)
        ]

    def _broadcast(self, msg: dict) -> None:
        for q in self._subscribers:
            q.put_nowait(msg)
