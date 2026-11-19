"""Cluster membership and teardown for the log and exec WebSockets."""

import asyncio
import json
import logging
from collections import Counter
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager, suppress
from typing import Any, NamedTuple

from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketDisconnected

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.exec.debug import finish_even_if_cancelled

log = logging.getLogger(__name__)
CLOSE_SECONDS = 5
# A node shell's pod cleanup runs before its cluster is removed; removal waits at most this long
# (the pod's own active deadline still ends a pod a stuck cleanup leaves behind).
CLEANUP_SECONDS = 30


class _Stop(NamedTuple):
    message: str
    code: int


_REMOVED = _Stop("The cluster was removed from OmniKrux.", 4404)
_SHUTDOWN = _Stop("The console is stopping.", 1001)


class StreamStopped(Exception):
    def __init__(self, stop: _Stop) -> None:
        super().__init__(stop.message)
        self.message, self.code = stop

    async def close(self, websocket: WebSocket, error: dict[str, str]) -> None:
        with suppress(WebSocketDisconnect, WebSocketDisconnected, TimeoutError):
            async with asyncio.timeout(CLOSE_SECONDS):
                await websocket.send_text(json.dumps({**error, "message": self.message}))
                await websocket.close(code=self.code, reason=self.message)


class StreamSession:
    def __init__(self, cluster_id: str, account_id: str | None, *, cleanup_pod: bool) -> None:
        self.cluster_id = cluster_id
        self.account_id = account_id
        self.cleanup_pod = cleanup_pod
        loop = asyncio.get_running_loop()
        self.done: asyncio.Future[None] = loop.create_future()
        self._stop: asyncio.Future[_Stop] = loop.create_future()

    def stop(self, reason: _Stop) -> None:
        if not self._stop.done():
            self._stop.set_result(reason)

    def check_stopped(self) -> None:
        if self._stop.done():
            raise StreamStopped(self._stop.result())

    async def run[T](self, operation: Coroutine[Any, Any, T]) -> T:
        """Stop a cancellable operation and join it before the route runs its finalizers."""
        task = asyncio.create_task(operation)
        try:
            self.check_stopped()
            done, _ = await asyncio.wait((task, self._stop), return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                return task.result()
            raise StreamStopped(self._stop.result())
        finally:
            if not task.done():
                task.cancel()
                await finish_even_if_cancelled(asyncio.gather(task, return_exceptions=True))
            elif not task.cancelled():
                task.exception()


class StreamSessions:
    def __init__(self, registry: ClusterRegistry) -> None:
        self._registry = registry
        self._lock = asyncio.Lock()
        self._sessions: set[StreamSession] = set()
        self._removing: Counter[tuple[str, str]] = Counter()
        self._closed = False

    async def register(self, cluster_id: str, *, cleanup_pod: bool = False) -> StreamSession:
        async with self._lock:
            if self._closed:
                raise StreamStopped(_SHUTDOWN)
            if ("cluster", cluster_id) in self._removing:
                raise StreamStopped(_REMOVED)
            try:
                info = await self._registry.get(cluster_id)
            except KeyError:
                # Leave unknown IDs to the route's usual authorization and lookup sequence.
                account = None
            else:
                account = info.cloud_account_id
            if account is not None and ("account", account) in self._removing:
                raise StreamStopped(_REMOVED)
            session = StreamSession(cluster_id, account, cleanup_pod=cleanup_pod)
            self._sessions.add(session)
            return session

    def release(self, session: StreamSession) -> None:
        self._sessions.remove(session)
        session.done.set_result(None)

    @asynccontextmanager
    async def removing(
        self, *, cluster_id: str | None = None, account_id: str | None = None
    ) -> AsyncIterator[None]:
        assert (cluster_id is None) != (account_id is None)
        if cluster_id is not None:
            key = ("cluster", cluster_id)
        else:
            assert account_id is not None
            key = ("account", account_id)
        async with self._lock:
            self._removing[key] += 1
            cleaning = [
                session
                for session in self._sessions
                if session.cleanup_pod
                and (
                    session.cluster_id == cluster_id
                    or (account_id is not None and session.account_id == account_id)
                )
            ]
        try:
            # The node-shell finalizer still needs the registered cluster and its credentials.
            await self._stop_all(cleaning, _REMOVED, timeout=CLEANUP_SECONDS)
            yield
        finally:
            self._removing[key] -= 1
            if not self._removing[key]:
                del self._removing[key]

    async def stop_cluster(self, cluster_id: str) -> None:
        sessions = [session for session in self._sessions if session.cluster_id == cluster_id]
        await self._stop_all(sessions, _REMOVED, timeout=CLOSE_SECONDS)

    async def close(self) -> None:
        async with self._lock:
            self._closed = True
            sessions = list(self._sessions)
        await self._stop_all(sessions, _SHUTDOWN)

    async def _stop_all(
        self, sessions: list[StreamSession], reason: _Stop, *, timeout: float | None = None
    ) -> None:
        for session in sessions:
            session.stop(reason)
        if sessions:
            _, pending = await asyncio.wait([s.done for s in sessions], timeout=timeout)
            if pending:
                log.warning("%d WebSocket session(s) still closing", len(pending))
