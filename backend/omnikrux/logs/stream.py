"""One container's log lines, read from the Kubernetes API as they are written.

`LogStream.lines()` yields `LogLine`s and, while following, `Marker`s for what happened to the
container: a restart (the stream then resumes on the new run), or the pod's deletion or
replacement (the end). A container that stopped for good ends the stream without a marker.
"""

import asyncio
import re
from collections.abc import AsyncIterable, AsyncIterator, Callable
from contextlib import AsyncExitStack, aclosing
from datetime import UTC, datetime
from typing import TypedDict

import aiohttp
from kubernetes_asyncio.client import ApiClient, CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.kube.connections import ClusterConnections, kube_error_message
from omnikrux.kube.http import read_json

# (connect, read) for a request that ends by itself; a followed log may stay quiet for hours, so
# it only gets a connect timeout.
REQUEST_TIMEOUT = (30, 120)
FOLLOW_TIMEOUT = aiohttp.ClientTimeout(connect=30, sock_connect=30)
MAX_LINE_BYTES = 1 << 20  # a longer line is cut into pieces of this size
MAX_FAILURES = 5  # consecutive failed reopens before a followed stream gives up
IMMEDIATE_SECONDS = 1.0  # a reopened stream that ends sooner than this, empty, failed
RETRY_DELAY = 1.0  # seconds before reopening after a failure
POLL_INTERVAL = 2.0  # seconds between pod reads while a stopped container waits to restart
FINISHED_PHASES = ("Succeeded", "Failed")  # the pod's containers will not run again

KUBE_ERRORS = (ApiException, aiohttp.ClientError, TimeoutError)


class LogLine(TypedDict):
    pod: str
    container: str
    ts: str | None  # RFC 3339 as the kubelet stamped it; None for a line without a stamp
    text: str


class Marker(TypedDict):
    marker: str


class LogStreamError(Exception):
    """The stream can't start or go on; `message` says why in plain words."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


_TS = re.compile(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})")


def ts_key(ts: str) -> tuple[datetime, int] | None:
    """A sortable key for an RFC 3339 timestamp (fractions of any length), or None if it isn't one.

    Kubernetes trims trailing zeros from the nanoseconds, so the strings don't sort as text."""
    match = _TS.fullmatch(ts)
    if match is None:
        return None
    base, fraction, zone = match.groups()
    try:
        moment = datetime.fromisoformat(base + ("+00:00" if zone == "Z" else zone))
    except ValueError:
        return None
    return moment.astimezone(UTC), int((fraction or "").ljust(9, "0"))


def split_timestamp(raw: str) -> tuple[str | None, str]:
    """`timestamps=true` puts "{RFC3339Nano} " before each line; split it off if it's there."""
    head, _, rest = raw.partition(" ")
    if ts_key(head) is None:
        return None, raw
    return head, rest


def _decode(raw: bytes) -> str:
    return raw.removesuffix(b"\r").decode("utf-8", "replace")


async def iter_lines(chunks: AsyncIterable[bytes]) -> AsyncIterator[str]:
    """Lines from a byte stream, whatever its chunking; a last line without a newline counts."""
    pending = b""
    async for chunk in chunks:
        pending += chunk
        *complete, pending = pending.split(b"\n")
        for raw in complete:
            yield _decode(raw)
        while len(pending) > MAX_LINE_BYTES:
            yield _decode(pending[:MAX_LINE_BYTES])
            pending = pending[MAX_LINE_BYTES:]
    if pending:
        yield _decode(pending)


class ResumePoint:
    """The last timestamp sent and how many lines carried it.

    A stream reopened from that time repeats those lines (and possibly earlier ones, as the API
    server may round `sinceTime`); `repeats()` skips exactly them, so lines that share a
    timestamp are neither sent twice nor lost."""

    def __init__(self) -> None:
        self.ts: str | None = None
        self._key: tuple[datetime, int] | None = None
        self._count = 0

    def sent(self, ts: str | None) -> None:
        key = ts_key(ts) if ts else None
        if key is None:
            return
        if key == self._key:
            self._count += 1
        else:
            self.ts, self._key, self._count = ts, key, 1

    def repeats(self) -> Callable[[str | None], bool]:
        """A filter for the reopened stream: True for a line that was already sent."""
        key, left = self._key, self._count

        def skip(ts: str | None) -> bool:
            nonlocal key, left
            if key is None:
                return False
            line_key = ts_key(ts) if ts else None
            if line_key is not None and line_key < key:
                return True
            if line_key == key and left > 0:
                left -= 1
                return True
            key = None  # past the resume point: everything from here on is new
            return False

        return skip


def container_names(pod: dict) -> list[str]:
    return [c.get("name", "") for c in (pod.get("spec") or {}).get("containers") or []]


def any_container_names(pod: dict) -> list[str]:
    """Every container whose logs can be read: init, regular and ephemeral."""
    spec = pod.get("spec") or {}
    fields = ("initContainers", "containers", "ephemeralContainers")
    return [c.get("name", "") for field in fields for c in spec.get(field) or []]


def container_status(pod: dict, container: str) -> dict:
    """The container's entry in the pod's status (init, regular or ephemeral); {} if none yet."""
    status = pod.get("status") or {}
    fields = ("initContainerStatuses", "containerStatuses", "ephemeralContainerStatuses")
    for field in fields:
        for entry in status.get(field) or []:
            if entry.get("name") == container:
                return entry
    return {}


def state_words(state: dict) -> str:
    """How a container that isn't running is doing, in a word or two (Kubernetes' reason)."""
    if "waiting" in state:
        return (state["waiting"] or {}).get("reason") or "waiting"
    if "terminated" in state:
        return (state["terminated"] or {}).get("reason") or "terminated"
    return "not started"


def will_restart(pod: dict, container: str, terminated: dict) -> bool:
    """Whether the kubelet starts this terminated container again."""
    spec = pod.get("spec") or {}
    if any(c.get("name") == container for c in spec.get("ephemeralContainers") or []):
        return False
    exit_code = terminated.get("exitCode")
    for init in spec.get("initContainers") or []:
        if init.get("name") == container:
            if init.get("restartPolicy") == "Always":  # a sidecar: restarted like the pod's
                break
            if exit_code == 0:  # a completed init container never runs again
                return False
    policy = spec.get("restartPolicy", "Always")
    return policy == "Always" or (policy == "OnFailure" and exit_code != 0)


def pod_missing_message(namespace: str, pod: str) -> str:
    return (
        f"Pod {namespace}/{pod} not found. It may have been deleted; pick it again from the list."
    )


async def open_log(
    api: ApiClient,
    namespace: str,
    pod: str,
    container: str,
    *,
    follow: bool = False,
    previous: bool = False,
    timestamps: bool = False,
    since_time: str | None = None,
    tail_lines: int | None = None,
) -> aiohttp.ClientResponse:
    """GET .../pods/{pod}/log, unread; the caller closes it. Non-2xx raises ApiException.

    The generated `read_namespaced_pod_log` has no `sinceTime`, so this calls the API directly."""
    query: list[tuple[str, str | int]] = [("container", container)]
    query += [(name, "true") for name, on in [("follow", follow), ("previous", previous),
                                               ("timestamps", timestamps)] if on]  # fmt: skip
    if since_time is not None:
        query.append(("sinceTime", since_time))
    if tail_lines is not None:
        query.append(("tailLines", tail_lines))
    resp = await api.call_api(
        "/api/v1/namespaces/{namespace}/pods/{name}/log",
        "GET",
        path_params={"namespace": namespace, "name": pod},
        query_params=query,
        # Accept must name a serializer type too: the API server answers 406 to "text/plain" alone.
        header_params={"Accept": "text/plain, application/json"},
        auth_settings=["BearerToken"],
        _preload_content=False,
        _request_timeout=FOLLOW_TIMEOUT if follow else REQUEST_TIMEOUT,
    )
    if not 200 <= resp.status < 300:
        try:
            body = await resp.read()
        finally:
            resp.close()
        exc = ApiException(status=resp.status, reason=resp.reason)
        exc.body = body.decode("utf-8", "replace")
        raise exc
    return resp


class LogStream:
    """One container's logs. `container=None` picks the pod's first container.

    While following it survives the stream closing: a restart (seen through `restartCount`) emits
    a marker and resumes on the new run from its start time; a pod that is gone emits
    "Pod deleted", and one recreated under the same name (new uid) "Pod replaced", and ends; a
    container that stopped and won't be restarted (completed init container, restartPolicy Never,
    OnFailure with exit 0, finished pod) ends it; otherwise it reopens from the last timestamp it
    saw, skipping lines it already sent. It gives up after `MAX_FAILURES` consecutive immediate
    failures (an attempt that sent lines or lived `IMMEDIATE_SECONDS` resets the count).
    """

    def __init__(
        self,
        connections: ClusterConnections,
        cluster_id: str,
        namespace: str,
        pod: str,
        container: str | None,
        *,
        previous: bool,
        follow: bool,
        since_time: str | None,
        tail_lines: int | None,
    ):
        self._connections = connections
        self._cluster_id = cluster_id
        self._namespace = namespace
        self._pod = pod
        self._container = container
        self._previous = previous
        self._follow = follow and not previous  # a previous run has ended: nothing to follow
        self._since_time = since_time
        self._tail_lines = tail_lines
        self._action = f"read logs for pod {namespace}/{pod}"

    async def lines(self) -> AsyncIterator[LogLine | Marker]:
        async with AsyncExitStack() as stack:
            try:
                api = await stack.enter_async_context(self._connections.api(self._cluster_id))
            except KeyError:
                raise LogStreamError("Unknown cluster") from None
            except Exception as exc:  # e.g. a missing exec plugin, said in words
                raise LogStreamError(kube_error_message(exc, self._action)) from exc
            async with aclosing(self._run(api)) as items:
                async for item in items:
                    yield item

    async def _run(self, api: ApiClient) -> AsyncIterator[LogLine | Marker]:
        loop = asyncio.get_running_loop()
        try:
            pod = await self._read_pod(api)
        except KUBE_ERRORS as exc:
            raise LogStreamError(self._message(exc, self._container or "")) from exc
        names = container_names(pod)
        container = self._container or (names[0] if names else None)
        if container is None:
            raise LogStreamError(f"Pod {self._namespace}/{self._pod} has no containers.")
        uid = (pod.get("metadata") or {}).get("uid")
        restarts = container_status(pod, container).get("restartCount", 0)
        since, tail = self._since_time, self._tail_lines
        position = ResumePoint()
        skip = position.repeats()  # nothing sent yet: nothing to skip
        failures = 0
        opened_once = False
        while True:
            opened_at, sent, error = None, 0, None
            try:
                resp = await self._open(api, container, since, tail)
                opened_at = loop.time()  # a slow connect that then fails never lived
            except KUBE_ERRORS as exc:
                if not opened_once or not self._follow:  # nothing to resume: say why now
                    raise LogStreamError(self._message(exc, container)) from exc
                error = exc
            else:
                opened_once = True
                try:
                    async with aclosing(iter_lines(resp.content.iter_any())) as raws:
                        async for raw in raws:
                            ts, text = split_timestamp(raw)
                            if skip(ts):
                                continue
                            position.sent(ts)
                            sent += 1
                            yield LogLine(pod=self._pod, container=container, ts=ts, text=text)
                except KUBE_ERRORS as exc:
                    if not self._follow:
                        raise LogStreamError(self._message(exc, container)) from exc
                    error = exc
                finally:
                    resp.close()
            if not self._follow:
                return
            lived = sent > 0 or (
                opened_at is not None and loop.time() - opened_at >= IMMEDIATE_SECONDS
            )
            if lived:  # only immediate failures count, and only consecutive ones
                failures = 0
            if error is not None:
                failures += 1
            quick_empty = error is None and not lived
            # The stream ended: find out why, and where to resume.
            while True:
                if failures >= MAX_FAILURES:
                    reason = (
                        self._message(error, container)
                        if error is not None
                        else "the cluster kept closing it straight away."
                    )
                    message = f"Lost the log stream after {MAX_FAILURES} attempts: {reason}"
                    raise LogStreamError(message)
                if failures:
                    await asyncio.sleep(RETRY_DELAY)
                try:
                    pod = await self._read_pod(api)
                except ApiException as exc:
                    if exc.status == 404:
                        yield Marker(marker="Pod deleted")
                        return
                    failures, error = failures + 1, exc
                    continue
                except KUBE_ERRORS as exc:
                    failures, error = failures + 1, exc
                    continue
                status = container_status(pod, container)
                state = status.get("state") or {}
                count = status.get("restartCount", 0)
                if (pod.get("metadata") or {}).get("uid") != uid or count < restarts:
                    yield Marker(marker="Pod replaced")  # same name, a different pod
                    return
                run = state.get("running") or state.get("terminated")
                if count > restarts and run is not None:
                    restarts = count
                    started = run.get("startedAt")
                    yield Marker(
                        marker=f"Container restarted at {started or 'unknown time'}, restart {count}"
                    )
                    since, tail = started, None
                    position, skip = ResumePoint(), ResumePoint().repeats()  # a new run
                    break
                if "running" in state:  # same run: the stream itself just closed
                    if quick_empty:
                        failures, quick_empty = failures + 1, False
                        continue
                    if position.ts is not None:
                        since, tail, skip = position.ts, None, position.repeats()
                    break
                if (pod.get("status") or {}).get("phase") in FINISHED_PHASES:
                    return
                if "terminated" in state and not will_restart(pod, container, state["terminated"]):
                    return
                await asyncio.sleep(POLL_INTERVAL)  # stopped; wait for the kubelet to restart it

    async def _read_pod(self, api: ApiClient) -> dict:
        return await read_json(
            CoreV1Api(api).read_namespaced_pod(
                self._pod, self._namespace, _preload_content=False, _request_timeout=REQUEST_TIMEOUT
            )
        )

    async def _open(
        self, api: ApiClient, container: str, since: str | None, tail: int | None
    ) -> aiohttp.ClientResponse:
        return await open_log(
            api,
            self._namespace,
            self._pod,
            container,
            follow=self._follow,
            previous=self._previous,
            timestamps=True,
            since_time=since,
            tail_lines=tail,
        )

    def _message(self, exc: Exception, container: str) -> str:
        return log_error_message(exc, self._namespace, self._pod, container, self._previous)


def log_error_message(
    exc: Exception, namespace: str, pod: str, container: str, previous: bool
) -> str:
    """Plain words for a failed log read, with what to try next where there is something."""
    if isinstance(exc, ApiException):
        if exc.status == 404:
            return pod_missing_message(namespace, pod)
        if exc.status == 400 and previous:
            return (
                f'No previous run of container "{container}" in pod {namespace}/{pod}: it has not '
                "restarted, or its earlier logs were already cleaned up. Try the current logs."
            )
    return kube_error_message(exc, f"read logs for pod {namespace}/{pod}")
