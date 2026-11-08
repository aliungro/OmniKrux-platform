"""Port-forwards: TCP listeners in the console, each connection bridged to a port in a pod.

A forward owns its listener and every connection's task; each connection owns its stream to the
pod (`PortForwardChannel`). Stopping a forward (by id, when its cluster is removed, or when the
console stops) closes the listener, then every connection and stream, then finishes its audit
record. A service forward looks for a ready pod again on every new connection, as kubectl
picks one; a pod forward whose pod is gone says so and leaves the listener for the user to stop.
"""

import asyncio
import logging
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import partial
from typing import Literal

from kubernetes_asyncio.client import CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException
from pydantic import BaseModel, ConfigDict, Field

from omnikrux.actions import authz
from omnikrux.audit.store import (
    AuditEntry,
    AuditLog,
    AuditUnavailable,
    no_audit_message,
)
from omnikrux.clusters.registry import ClusterInfo
from omnikrux.exec.debug import finish_even_if_cancelled
from omnikrux.kube.connections import ClusterConnections, kube_error_message
from omnikrux.kube.http import KUBE_ERRORS, read_json
from omnikrux.kube.pods import REQUEST_TIMEOUT, pod_missing_message, read_pod
from omnikrux.portforward.channel import ForwardError, PortForwardChannel
from omnikrux.resources.kinds import object_name_problem

log = logging.getLogger(__name__)

EXHAUSTED = "All {n} port-forward ports ({first}–{last}) are in use. Stop one first."
NO_READY_PODS = "Service {name} has no ready pods to forward to."
POD_GONE = "Pod {name} is gone; stop this forward and start a new one."
SERVICE_GONE = "Service {name} is gone; stop this forward and start a new one."
CLUSTER_REMOVED = "The cluster was removed from Omnikrux."
CONSOLE_STOPPED = "The console stopped."
NOT_RUNNING = "This port-forward isn't running any more."
POD_NOT_RUNNING = (
    "Pod {name} isn't running ({phase}), so nothing in it can be reached. "
    "Wait for it to start, or pick a running pod."
)
CLUSTER_GONE_NOW = "The cluster was removed from Omnikrux; stop this forward."
UNEXPECTED = (
    "The port-forward connection failed unexpectedly ({type}). "
    "Connect again; if it keeps failing, stop this forward and start a new one."
)

CHUNK = 32 * 1024  # bytes read from a local connection at a time
# After the local side stops sending (the stream can't tell the pod), the pod's answer is still
# relayed until nothing has come back for this long.
IDLE_AFTER_EOF_SECONDS = 5.0
CLOSE_SECONDS = 5.0  # for a stopped forward's connections to close


class ForwardIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cluster_id: str
    namespace: str
    kind: Literal["pod", "service"]
    name: str
    port: int = Field(ge=1, le=65535)


class ForwardOut(BaseModel):
    id: str
    cluster_id: str
    cluster_name: str
    provider: str
    namespace: str
    kind: Literal["pod", "service"]
    name: str
    remote_port: int
    local_port: int
    address: str  # "127.0.0.1:30001": the listener (or the published port) is IPv4 only
    pod: str | None  # the pod the latest connection went to
    state: Literal["listening", "error"]
    message: str | None
    connections: int
    started_at: datetime


class ForwardRefused(Exception):
    """The forward can't start (or a connection can't be bridged); `message` says why."""

    def __init__(self, status: int, message: str, *, gone: bool = False, no_cluster: bool = False):
        super().__init__(message)
        self.status = status
        self.message = message
        self.gone = gone  # the pod or service isn't there
        self.no_cluster = no_cluster  # the cluster isn't registered (any more)


@dataclass(frozen=True)
class Target:
    pod: str
    port: int


@dataclass(eq=False)
class Forward:
    id: str
    req: ForwardIn
    cluster: ClusterInfo
    local_port: int
    pod: str | None
    audit_id: int = 0
    server: asyncio.Server | None = None
    started_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    state: Literal["listening", "error"] = "listening"
    message: str | None = None
    tasks: set[asyncio.Task] = field(default_factory=set)
    stopping: bool = False

    def fail(self, message: str) -> None:
        self.state, self.message = "error", message

    def works(self) -> None:
        self.state, self.message = "listening", None

    def out(self) -> ForwardOut:
        req = self.req
        return ForwardOut(
            id=self.id,
            cluster_id=req.cluster_id,
            cluster_name=self.cluster.name,
            provider=str(self.cluster.provider.value),
            namespace=req.namespace,
            kind=req.kind,
            name=req.name,
            remote_port=req.port,
            local_port=self.local_port,
            address=f"127.0.0.1:{self.local_port}",
            pod=self.pod,
            state=self.state,
            message=self.message,
            connections=len(self.tasks),
            started_at=self.started_at,
        )


def is_ready(pod: dict) -> bool:
    if (pod.get("metadata") or {}).get("deletionTimestamp"):
        return False
    status = pod.get("status") or {}
    return status.get("phase") == "Running" and any(
        c.get("type") == "Ready" and c.get("status") == "True"
        for c in status.get("conditions") or []
    )


def container_port(pod: dict, target: int | str) -> int | None:
    """The pod's port for a service's `targetPort`: a number is itself, a name is looked up
    in the containers' ports (None when the pod has no port by that name)."""
    if isinstance(target, int):
        return target
    for container in (pod.get("spec") or {}).get("containers") or []:
        for entry in container.get("ports") or []:
            if entry.get("name") == target and isinstance(entry.get("containerPort"), int):
                return entry["containerPort"]
    return None


def service_target(service: dict, name: str, port: int) -> int | str:
    """The `targetPort` behind the service's `port` (the same number when it has none)."""
    entries = (service.get("spec") or {}).get("ports") or []
    for entry in entries:
        if entry.get("port") == port:
            return entry.get("targetPort", port)
    numbers = ", ".join(str(e.get("port")) for e in entries)
    if not numbers:
        raise ForwardRefused(422, f"Service {name} has no ports to forward to.")
    raise ForwardRefused(
        422, f"Service {name} has no port {port}. Pick one of its ports: {numbers}."
    )


def pick_pod(pods: list[dict], target: int | str, name: str) -> Target:
    """The first ready pod (by name) that has the target port, as kubectl picks one."""
    for found in sorted(pods, key=lambda p: (p.get("metadata") or {}).get("name") or ""):
        number = container_port(found, target) if is_ready(found) else None
        if number is not None:
            return Target(found["metadata"]["name"], number)
    raise ForwardRefused(422, NO_READY_PODS.format(name=name))


class PortForwardManager:
    def __init__(
        self,
        connections: ClusterConnections,
        registry,
        audit: AuditLog,
        *,
        ports: range,
        bind: str,
    ):
        self._connections = connections
        self._registry = registry
        self._audit = audit
        self._ports = ports
        self._bind = bind
        self._forwards: dict[str, Forward] = {}
        self._lock = asyncio.Lock()  # one start at a time picks a port
        self._closed = False

    @property
    def ports(self) -> range:
        return self._ports

    @property
    def bind(self) -> str:
        return self._bind

    async def start(self, req: ForwardIn, actor: str) -> ForwardOut:
        """Listen on the lowest free port and forward every connection to the pod's (or a ready
        service pod's) port. Raises NotAllowed, or ForwardRefused with a status and words."""
        kind_key = "pods" if req.kind == "pod" else "services"
        if problem := object_name_problem(req.name, req.namespace):
            raise ForwardRefused(422, problem)
        await authz.authorize(
            actor, "port_forward", req.cluster_id, req.namespace, kind_key, req.name
        )
        try:
            cluster = await self._registry.get(req.cluster_id)
        except KeyError as exc:
            raise ForwardRefused(404, "Unknown cluster") from exc
        target = await self._resolve(req)
        forward = Forward(
            id=secrets.token_urlsafe(9), req=req, cluster=cluster, local_port=0, pod=target.pod
        )
        async with self._lock:  # stop_cluster and close sweep under it too: none slips by
            if self._closed:
                raise ForwardRefused(503, "The console is stopping.")
            try:
                await self._registry.get(req.cluster_id)  # not removed meanwhile
            except KeyError as exc:
                raise ForwardRefused(404, "Unknown cluster") from exc
            server = await self._listen(forward)
            details: dict = {"remote_port": req.port, "local_port": forward.local_port}
            if req.kind == "service":
                details["pod"] = target.pod
            entry = AuditEntry(
                actor=actor,
                action="port_forward",
                cluster_id=req.cluster_id,
                namespace=req.namespace,
                kind=kind_key,
                name=req.name,
                details=details,
            )
            try:
                forward.audit_id = await self._audit.begin(entry)
                await server.start_serving()
            except AuditUnavailable as exc:
                server.close()  # nothing was accepted yet
                raise ForwardRefused(503, no_audit_message(exc)) from exc
            except BaseException:  # cancelled: the request or the console is stopping
                server.close()
                if forward.audit_id:
                    await finish_even_if_cancelled(
                        self._audit.finish(forward.audit_id, "failed", "The forward didn't start.")
                    )
                raise
            forward.server = server
            self._forwards[forward.id] = forward
        log.info(
            "port-forward %s started: %s:%d -> cluster=%s %s %s/%s port %d",
            forward.id,
            self._bind,
            forward.local_port,
            req.cluster_id,
            req.kind,
            req.namespace,
            req.name,
            req.port,
        )
        return forward.out()

    async def stop(self, forward_id: str, actor: str) -> None:
        """Stop one forward. KeyError when it isn't running."""
        forward = self._forwards.get(forward_id)
        if forward is None:
            raise KeyError(forward_id)
        req = forward.req
        kind_key = "pods" if req.kind == "pod" else "services"
        await authz.authorize(
            actor, "port_forward", req.cluster_id, req.namespace, kind_key, req.name
        )
        if self._forwards.pop(forward_id, None) is None:
            raise KeyError(forward_id)  # stopped meanwhile
        await finish_even_if_cancelled(self._end(forward, f"Stopped by {actor}."))

    async def stop_cluster(self, cluster_id: str) -> None:
        """Stop every forward to a cluster that was removed."""
        async with self._lock:
            ending = [f for f in self._forwards.values() if f.req.cluster_id == cluster_id]
            self._drop(ending)
        await self._end_all(ending, CLUSTER_REMOVED)

    async def close(self) -> None:
        """Stop every forward (the console is stopping); no forward starts afterwards."""
        self._closed = True
        async with self._lock:
            ending = list(self._forwards.values())
            self._drop(ending)
        await self._end_all(ending, CONSOLE_STOPPED)

    def _drop(self, forwards: list[Forward]) -> None:
        for forward in forwards:
            del self._forwards[forward.id]

    async def _end_all(self, forwards: list[Forward], message: str) -> None:
        if forwards:
            work = asyncio.gather(*(self._end(f, message) for f in forwards))
            await finish_even_if_cancelled(work)

    async def _end(self, forward: Forward, message: str) -> None:
        """Close the listener, every connection and its stream, then finish the record."""
        forward.stopping = True
        if forward.server is not None:
            forward.server.close()
        tasks = list(forward.tasks)
        for task in tasks:
            task.cancel()
        if tasks:  # capped: stop_cluster runs under the watch hub's lock
            _, pending = await asyncio.wait(tasks, timeout=CLOSE_SECONDS)
            if pending:
                log.warning(
                    "port-forward %s: %d connection(s) didn't stop in %.0f s",
                    forward.id,
                    len(pending),
                    CLOSE_SECONDS,
                )
        if forward.server is not None:
            try:
                async with asyncio.timeout(CLOSE_SECONDS):
                    await forward.server.wait_closed()
            except TimeoutError:
                log.warning("port-forward %s: connections still closing", forward.id)
        await self._audit.finish(forward.audit_id, "ended", message)
        log.info("port-forward %s stopped: %s", forward.id, message)

    async def _listen(self, forward: Forward) -> asyncio.Server:
        """Bind the lowest free port (not yet accepting); ForwardRefused 409 when none is."""
        taken = {f.local_port for f in self._forwards.values()}
        for port in self._ports:
            if port in taken:
                continue
            try:
                server = await asyncio.start_server(
                    partial(self._connection, forward), self._bind, port, start_serving=False
                )
            except OSError as exc:  # another program has it
                log.info("port-forward port %d is in use (%s)", port, exc.strerror or exc)
                continue
            forward.local_port = port
            return server
        first, last = self._ports[0], self._ports[-1]
        raise ForwardRefused(409, EXHAUSTED.format(n=len(self._ports), first=first, last=last))

    async def _resolve(self, req: ForwardIn) -> Target:
        """The pod and port a connection goes to: the pod itself, or a ready pod of the service
        with its `targetPort` mapped. ForwardRefused 404 (`gone`) when the object isn't there,
        422 when a pod isn't running or a service has no ready pod."""
        what = f"{req.kind} {req.namespace}/{req.name}"
        try:
            async with self._connections.api(req.cluster_id) as api:
                if req.kind == "pod":
                    found = await read_pod(api, req.namespace, req.name, timeout=REQUEST_TIMEOUT)
                    phase = (found.get("status") or {}).get("phase") or "phase unknown"
                    if phase != "Running":
                        raise ForwardRefused(
                            422, POD_NOT_RUNNING.format(name=req.name, phase=phase)
                        )
                    return Target(req.name, req.port)
                core = CoreV1Api(api)
                found = await read_json(
                    core.read_namespaced_service(
                        req.name,
                        req.namespace,
                        _preload_content=False,
                        _request_timeout=REQUEST_TIMEOUT,
                    )
                )
                target = service_target(found, req.name, req.port)
                selector = (found.get("spec") or {}).get("selector") or {}
                if not selector:  # no pods of its own (an ExternalName or a manual endpoint)
                    raise ForwardRefused(422, NO_READY_PODS.format(name=req.name))
                pods = await read_json(
                    core.list_namespaced_pod(
                        req.namespace,
                        label_selector=",".join(f"{k}={v}" for k, v in selector.items()),
                        _preload_content=False,
                        _request_timeout=REQUEST_TIMEOUT,
                    )
                )
                return pick_pod(pods.get("items") or [], target, req.name)
        except ForwardRefused:
            raise
        except KeyError as exc:
            raise ForwardRefused(404, "Unknown cluster", no_cluster=True) from exc
        except ApiException as exc:
            if exc.status == 404:
                if req.kind == "pod":
                    missing = pod_missing_message(req.namespace, req.name)
                    raise ForwardRefused(404, missing, gone=True) from exc
                missing = (
                    f"Service {req.namespace}/{req.name} not found. It may have been deleted; "
                    "pick it again from the list."
                )
                raise ForwardRefused(404, missing, gone=True) from exc
            raise ForwardRefused(502, kube_error_message(exc, f"read {what}")) from exc
        except Exception as exc:  # unreachable, a missing exec plugin: said in words
            if not isinstance(exc, KUBE_ERRORS):
                log.warning("port-forward: could not read %s (%s)", what, type(exc).__name__)
            raise ForwardRefused(502, kube_error_message(exc, f"read {what}")) from exc

    async def _connection(
        self, forward: Forward, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """One local connection, bridged to the pod until either side ends. Never raises: what
        went wrong becomes the forward's state."""
        if forward.stopping:
            writer.close()
            return
        task = asyncio.current_task()
        forward.tasks.add(task)
        try:
            await self._bridge(forward, reader, writer)
        except Exception as exc:  # noqa: BLE001 (becomes the forward's state; logged by type)
            log.warning("port-forward %s connection failed (%s)", forward.id, type(exc).__name__)
            forward.fail(UNEXPECTED.format(type=type(exc).__name__))
        finally:
            forward.tasks.discard(task)
            writer.close()

    async def _bridge(
        self, forward: Forward, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        req = forward.req
        if req.kind == "pod":
            target = Target(req.name, req.port)
        else:
            try:
                target = await self._resolve(req)
            except ForwardRefused as exc:
                if exc.gone:
                    forward.fail(SERVICE_GONE.format(name=req.name))
                else:
                    forward.fail(CLUSTER_GONE_NOW if exc.no_cluster else exc.message)
                return
        forward.pod = target.pod
        try:
            channel = await PortForwardChannel.open(
                self._connections, req.cluster_id, req.namespace, target.pod, target.port
            )
        except KeyError:
            forward.fail(CLUSTER_GONE_NOW)
            return
        except Exception as exc:  # noqa: BLE001 (refused, unreachable: said in words)
            if isinstance(exc, ApiException) and exc.status == 404:
                forward.fail(POD_GONE.format(name=target.pod))
            else:
                action = f"forward to pod {req.namespace}/{target.pod} port {target.port}"
                forward.fail(kube_error_message(exc, action))
            return
        try:
            await self._relay(forward, channel, reader, writer)
        finally:
            await finish_even_if_cancelled(channel.close())

    async def _relay(
        self,
        forward: Forward,
        channel: PortForwardChannel,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        """Bytes both ways until either side ends; a failure of the pod's side becomes the
        forward's state. The local side going away is normal."""

        async def to_pod() -> None:
            while data := await reader.read(CHUNK):
                await channel.write(data)

        loop = asyncio.get_running_loop()
        heard = [loop.time()]  # when the pod last sent something

        async def to_local() -> None:
            answered = False
            while (data := await channel.read()) is not None:
                heard[0] = loop.time()
                if not answered:
                    answered = True
                    forward.works()
                writer.write(data)
                await writer.drain()

        up = asyncio.create_task(to_pod())
        down = asyncio.create_task(to_local())
        try:
            await asyncio.wait((up, down), return_when=asyncio.FIRST_COMPLETED)
            if up.done() and not down.done() and up.exception() is None:
                # The local side stopped sending, and the stream can't tell the pod so: keep
                # relaying its answer for as long as it keeps coming.
                heard[0] = max(heard[0], loop.time())
                while not down.done():
                    quiet_left = heard[0] + IDLE_AFTER_EOF_SECONDS - loop.time()
                    if quiet_left <= 0:
                        break
                    await asyncio.wait((down,), timeout=quiet_left)
        finally:
            for task in (up, down):
                task.cancel()
            await asyncio.wait((up, down))
        for task in (up, down):
            if task.cancelled() or (exc := task.exception()) is None:
                continue
            if isinstance(exc, ForwardError):
                forward.fail(exc.message)
            elif not isinstance(exc, ConnectionError):  # the local side reset: normal
                log.warning("port-forward %s relay failed (%s)", forward.id, type(exc).__name__)
                forward.fail(UNEXPECTED.format(type=type(exc).__name__))

    # Last in the class: `list` would shadow the builtin in the annotations below it.
    def bound_addresses(self, forward_id: str) -> list[tuple[str, int]]:
        """Where the forward's listener is bound (host, port)."""
        server = self._forwards[forward_id].server
        return [sock.getsockname()[:2] for sock in server.sockets] if server else []

    def list(self) -> list[ForwardOut]:
        return [f.out() for f in self._forwards.values()]
