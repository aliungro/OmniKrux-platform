"""WS /api/logs streams pod logs in batches; GET .../logs/download returns one log as a file."""

import asyncio
import json
import logging
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack, aclosing

from fastapi import APIRouter, HTTPException, Request, WebSocket
from fastapi.responses import StreamingResponse
from kubernetes_asyncio.client import ApiClient, CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException
from starlette.websockets import WebSocketDisconnect

from omnikrux.kube.connections import ClusterConnections, kube_error_message
from omnikrux.kube.http import KUBE_ERRORS, read_json
from omnikrux.kube.pods import (
    SLOW_REQUEST_TIMEOUT,
    any_container_names,
    container_names,
    read_pod,
)
from omnikrux.logs.stream import (
    LogLine,
    LogStream,
    LogStreamError,
    Marker,
    log_error_message,
    open_log,
)
from omnikrux.web_security import is_cross_origin

log = logging.getLogger(__name__)

router = APIRouter()

QUEUE_LIMIT = 10_000  # entries waiting for a slow client; beyond this the oldest are dropped
MAX_SELECTOR_PODS = 20  # pods one selector session streams at once
BATCH_MAX = 500  # entries per `lines` message
FLUSH_SECONDS = 0.1  # the longest an entry waits for company before it is sent


class LineBuffer:
    """Between the log producers and the socket sender. Bounded: when it is full the oldest line
    is dropped and counted, so a slow client loses old lines instead of memory growing. Markers
    (restarts, deletions, errors) are kept."""

    def __init__(self, limit: int = QUEUE_LIMIT):
        self._items: deque[LogLine | Marker] = deque()
        self._limit = limit
        self._wake = asyncio.Event()
        self.dropped = 0
        self.first_at = 0.0  # loop time the oldest unsent entry arrived
        self.finished = False
        self.error: str | None = None

    def __len__(self) -> int:
        return len(self._items)

    def put(self, item: LogLine | Marker) -> None:
        if not self._items:
            self.first_at = asyncio.get_running_loop().time()
        elif len(self._items) >= self._limit:
            for i, old in enumerate(self._items):
                if "marker" not in old:
                    del self._items[i]  # almost always i == 0
                    break
            else:  # nothing but markers: drop the oldest of them
                self._items.popleft()
            self.dropped += 1
        self._items.append(item)
        self._wake.set()

    def take(self, n: int) -> list[LogLine | Marker]:
        return [self._items.popleft() for _ in range(min(n, len(self._items)))]

    def finish(self, error: str | None = None) -> None:
        """No more entries: the sender drains what is left and stops."""
        self.finished, self.error = True, error
        self._wake.set()

    async def wait(self, timeout: float | None = None) -> None:
        """Until something is put or finished (or `timeout` passes); callers re-check state."""
        self._wake.clear()
        try:
            async with asyncio.timeout(timeout):
                await self._wake.wait()
        except TimeoutError:
            pass


async def send_batches(websocket: WebSocket, buffer: LineBuffer) -> None:
    """Send `lines` messages of at most BATCH_MAX entries, each as soon as it is full or its
    oldest entry has waited FLUSH_SECONDS. When lines were lost, a `dropped` count goes right
    before the batch that follows the gap. Returns once the buffer is finished and drained."""
    loop = asyncio.get_running_loop()
    while True:
        while not len(buffer) and not buffer.finished:
            await buffer.wait()
        if not len(buffer):
            return
        while len(buffer) < BATCH_MAX and not buffer.finished:
            remaining = buffer.first_at + FLUSH_SECONDS - loop.time()
            if remaining <= 0:
                break
            await buffer.wait(remaining)
        # Take the batch and the count together: lines dropped while we send are newer than
        # this batch and are announced before the next one.
        batch, dropped = buffer.take(BATCH_MAX), buffer.dropped
        buffer.dropped = 0
        if dropped:
            await websocket.send_text(json.dumps({"type": "dropped", "count": dropped}))
        await websocket.send_text(json.dumps({"type": "lines", "lines": batch}))


async def _status(websocket: WebSocket, state: str, message: str | None = None) -> None:
    await websocket.send_text(json.dumps({"type": "status", "state": state, "message": message}))


async def _fail(websocket: WebSocket, message: str, code: int, reason: str | None = None) -> None:
    await _status(websocket, "error", message)
    await websocket.close(code=code, reason=reason)


async def _targets(
    connections: ClusterConnections,
    cluster: str,
    namespace: str,
    pod: str | None,
    selector: str | None,
    container: str | None,
) -> tuple[list[tuple[str, str]], str | None]:
    """(pod, container) pairs to stream, and a notice for the user (or None). Unknown cluster:
    KeyError; anything else that stops the session before it starts: LogStreamError."""
    async with AsyncExitStack() as stack:
        try:
            api = await stack.enter_async_context(connections.api(cluster))
        except KeyError:
            raise
        except Exception as exc:  # e.g. a missing exec plugin, said in words
            raise LogStreamError(kube_error_message(exc, "connect to the cluster")) from exc
        if pod is not None:
            return [await _pod_target(api, namespace, pod, container)], None
        return await _selector_targets(api, namespace, selector or "", container)


async def _pod_target(
    api: ApiClient, namespace: str, pod: str, container: str | None
) -> tuple[str, str]:
    try:
        found = await read_pod(api, namespace, pod, timeout=SLOW_REQUEST_TIMEOUT)
    except KUBE_ERRORS as exc:
        raise LogStreamError(
            log_error_message(exc, namespace, pod, container or "", False)
        ) from exc
    names = container_names(found)
    if container is None:
        if not names:
            raise LogStreamError(f"Pod {namespace}/{pod} has no containers.")
        return pod, names[0]
    if container not in any_container_names(found):
        raise LogStreamError(
            f'Pod {namespace}/{pod} has no container "{container}". '
            f"Pick one of: {', '.join(any_container_names(found))}."
        )
    return pod, container


async def _selector_targets(
    api: ApiClient, namespace: str, selector: str, container: str | None
) -> tuple[list[tuple[str, str]], str | None]:
    """Pods matching now, at most MAX_SELECTOR_PODS of them (running first, then the newest);
    `container` where the pod has it, else the pod's first."""
    try:
        listing = await read_json(
            CoreV1Api(api).list_namespaced_pod(
                namespace,
                label_selector=selector,
                _preload_content=False,
                _request_timeout=SLOW_REQUEST_TIMEOUT,
            )
        )
    except KUBE_ERRORS as exc:
        action = f"list pods matching {selector} in {namespace}"
        raise LogStreamError(kube_error_message(exc, action)) from exc
    pods = [p for p in listing.get("items") or [] if container_names(p)]
    if not pods:
        raise LogStreamError(f"No pods match {selector} in {namespace}")
    # Stable sorts, least significant first: name, then newest, then running before the rest.
    pods.sort(key=lambda p: (p.get("metadata") or {}).get("name", ""))
    pods.sort(key=lambda p: (p.get("metadata") or {}).get("creationTimestamp") or "", reverse=True)
    pods.sort(key=lambda p: (p.get("status") or {}).get("phase") != "Running")
    notice = None
    if len(pods) > MAX_SELECTOR_PODS:
        notice = f"Showing logs from {MAX_SELECTOR_PODS} of {len(pods)} pods matching {selector}"
    targets = []
    for found in pods[:MAX_SELECTOR_PODS]:
        name = (found.get("metadata") or {}).get("name", "")
        has_it = container is not None and container in any_container_names(found)
        targets.append((name, container if has_it else container_names(found)[0]))
    return sorted(targets), notice


async def _pump(buffer: LineBuffer, pod: str, stream: LogStream, merged: bool) -> None:
    """One pod's stream into the buffer. A merged (selector) session names the pod in every
    marker, and a pod's failure there is a marker, not the end of the session."""
    try:
        async with aclosing(stream.lines()) as items:
            async for item in items:
                if merged and "marker" in item:
                    item = Marker(marker=f"{pod}: {item['marker']}")
                buffer.put(item)
    except LogStreamError as exc:
        if not merged:
            raise
        buffer.put(Marker(marker=f"{pod}: {exc.message}"))  # the other pods go on


async def _produce(
    buffer: LineBuffer, streams: list[tuple[str, LogStream]], *, merged: bool
) -> None:
    error = None
    try:
        async with asyncio.TaskGroup() as group:
            for pod, stream in streams:
                group.create_task(_pump(buffer, pod, stream, merged))
    except* LogStreamError as group_error:
        error = group_error.exceptions[0].message
    except* Exception as group_error:  # a bug: plain words out, details in the log
        log.warning("log stream failed", exc_info=group_error.exceptions[0])
        error = "Couldn't read the logs: something went wrong in the console. Try again."
    finally:
        buffer.finish(error)


async def _send_all(websocket: WebSocket, buffer: LineBuffer) -> int:
    """Send every entry, then the final status; returns the close code."""
    await send_batches(websocket, buffer)
    if buffer.error is None:
        await _status(websocket, "ended")
        return 1000
    await _status(websocket, "error", buffer.error)
    return 1011


async def _until_disconnect(websocket: WebSocket) -> None:
    """Return once the client goes away; incoming messages are ignored."""
    while (await websocket.receive())["type"] != "websocket.disconnect":
        pass


@router.websocket("/api/logs")
async def logs(
    websocket: WebSocket,
    cluster: str,
    namespace: str,
    pod: str | None = None,
    selector: str | None = None,
    container: str | None = None,
    previous: bool = False,
    follow: bool = True,
    since_time: str | None = None,
    tail_lines: int = 1000,
) -> None:
    if is_cross_origin(websocket):
        await websocket.close(code=4403, reason="Cross-origin request refused")  # HTTP 403
        return
    await websocket.accept()
    pod, selector, container = pod or None, selector or None, container or None
    if (pod is None) == (selector is None):
        await _fail(websocket, "Choose a pod or a label selector (one of them, not both).", 1008)
        return
    connections = websocket.app.state.connections
    try:
        targets, notice = await _targets(connections, cluster, namespace, pod, selector, container)
    except KeyError:
        await _fail(websocket, "Unknown cluster", 4404, reason="Unknown cluster")
        return
    except LogStreamError as exc:
        await _fail(websocket, exc.message, 1011)
        return
    streams = [
        (
            name,
            LogStream(
                connections,
                cluster,
                namespace,
                name,
                chosen,
                previous=previous,
                follow=follow,
                since_time=since_time,
                tail_lines=tail_lines,
            ),
        )
        for name, chosen in targets
    ]
    what = f"pod={pod}" if pod is not None else f"selector={selector}"
    where = f"cluster={cluster} ns={namespace} {what} container={container or targets[0][1]}"
    log.info("log stream opened %s previous=%s follow=%s", where, previous, follow)
    buffer = LineBuffer()
    if notice is not None:
        buffer.put(Marker(marker=notice))
    try:
        await _status(websocket, "streaming")
        producer = asyncio.create_task(_produce(buffer, streams, merged=selector is not None))
        sender = asyncio.create_task(_send_all(websocket, buffer))
        receiver = asyncio.create_task(_until_disconnect(websocket))
        tasks = (producer, sender, receiver)
        try:
            await asyncio.wait((sender, receiver), return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.wait(tasks)  # never raises the tasks' exceptions or swallows ours
        for task in tasks:
            if (
                not task.cancelled()
                and (exc := task.exception())
                and not isinstance(exc, WebSocketDisconnect)
            ):
                log.warning("log socket failed (%s)", where, exc_info=exc)
        if sender.done() and not sender.cancelled() and sender.exception() is None:
            await websocket.close(code=sender.result())
    finally:
        log.info("log stream closed %s", where)


class _ReleasingStreamingResponse(StreamingResponse):
    """Runs `release` once the response is over, however it ends: finished, failed, or the
    client gone before the body started (when a body generator's own `finally` never runs)."""

    def __init__(self, content, release: Callable[[], Awaitable[None]], **kwargs):
        super().__init__(content, **kwargs)
        self._release = release

    async def __call__(self, scope, receive, send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            await self._release()


@router.get("/api/clusters/{cluster_id}/pods/{namespace}/{name}/logs/download")
async def download(
    cluster_id: str,
    namespace: str,
    name: str,
    request: Request,
    container: str | None = None,
    previous: bool = False,
) -> StreamingResponse:
    """The container's whole log as raw text (no timestamps), not followed."""
    connections: ClusterConnections = request.app.state.connections
    try:
        api = await connections.open_api(cluster_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown cluster") from exc
    except Exception as exc:  # e.g. a missing exec plugin, said in words
        detail = kube_error_message(exc, f"read logs for pod {namespace}/{name}")
        raise HTTPException(status_code=502, detail=detail) from exc
    try:
        if not container:
            pod = await read_pod(api, namespace, name, timeout=SLOW_REQUEST_TIMEOUT)
            names = container_names(pod)
            if not names:
                raise HTTPException(
                    status_code=404, detail=f"Pod {namespace}/{name} has no containers."
                )
            container = names[0]
        resp = await open_log(api, namespace, name, container, previous=previous)
    except BaseException as exc:
        await api.close()
        if isinstance(exc, KUBE_ERRORS):
            code = exc.status if isinstance(exc, ApiException) else None
            status = code if code in (400, 404) else 502  # 400: e.g. no previous run
            detail = log_error_message(exc, namespace, name, container or "", previous)
            raise HTTPException(status_code=status, detail=detail) from exc
        raise

    async def body():
        async for chunk in resp.content.iter_any():
            yield chunk

    async def release() -> None:
        resp.close()
        await api.close()

    log.info(
        "log download cluster=%s ns=%s pod=%s container=%s previous=%s",
        cluster_id, namespace, name, container, previous,
    )  # fmt: skip
    suffix = "-previous" if previous else ""
    return _ReleasingStreamingResponse(
        body(),
        release,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}-{container}{suffix}.log"'},
    )
