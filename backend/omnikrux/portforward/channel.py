"""One TCP connection's stream to a port in a pod, over Kubernetes' port-forward WebSocket.

The API server hands the stream to the kubelet, which speaks the `v4.channel.k8s.io` framing:
every binary frame starts with a channel byte. One port is forwarded per stream, so there are
two channels: 0 carries the data both ways and 1 carries the kubelet's error text. Each opens
with the port number (2 bytes, little endian), which is not data. The kubelet dials the pod's
port once per stream, so every local connection gets a stream of its own."""

import asyncio
import contextlib
from contextlib import AsyncExitStack
from typing import Self

import aiohttp
from kubernetes_asyncio.client import CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.kube.connections import ClusterConnections

DATA, ERROR = 0, 1
PROTOCOL = "v4.channel.k8s.io"
PORT_PREFIX = 2  # bytes of port number that open each channel
CONNECT_SECONDS = 30  # for the WebSocket handshake
MAX_DETAIL = 300
CLOSED = (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSING, aiohttp.WSMsgType.CLOSED)


class ForwardError(Exception):
    """The stream to the pod's port failed; `message` says why in plain words."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def error_message(text: str, pod: str, port: int) -> str:
    """The kubelet's error text, in plain words."""
    if "connection refused" in text:
        return f"Nothing in pod {pod} is listening on port {port} (connection refused)."
    detail = " ".join(text.split())[:MAX_DETAIL]
    return f"The port-forward to pod {pod} port {port} failed: {detail}"


class PortForwardChannel:
    """One stream to one port, opened with `open` and owning its client; `close` releases both."""

    def __init__(
        self, ws: aiohttp.ClientWebSocketResponse, resources: AsyncExitStack, pod: str, port: int
    ):
        self._ws = ws
        self._resources = resources
        self._pod = pod
        self._port = port
        self._prefix = {DATA: PORT_PREFIX, ERROR: PORT_PREFIX}  # port bytes still to drop

    @classmethod
    async def open(
        cls, connections: ClusterConnections, cluster: str, namespace: str, pod: str, port: int
    ) -> Self:
        """Unknown cluster: KeyError. A refused handshake: ApiException with its status (404:
        the pod is gone)."""
        async with AsyncExitStack() as stack:
            api = await stack.enter_async_context(connections.ws_api(cluster))
            connecting = await CoreV1Api(api).connect_get_namespaced_pod_portforward(
                pod,
                namespace,
                ports=port,
                _preload_content=False,
                _headers={"sec-websocket-protocol": PROTOCOL},
            )
            try:
                async with asyncio.timeout(CONNECT_SECONDS):
                    ws = await stack.enter_async_context(connecting)
            except aiohttp.WSServerHandshakeError as exc:  # no body: the status says enough
                raise ApiException(status=exc.status, reason=exc.message) from exc
            return cls(ws, stack.pop_all(), pod, port)

    def _payload(self, channel: int, data: bytes) -> bytes:
        """`data` without what is left of the channel's port prefix."""
        drop = min(self._prefix[channel], len(data))
        self._prefix[channel] -= drop
        return data[drop:]

    async def write(self, data: bytes) -> None:
        """Send bytes to the pod's port. A closed or broken stream is reported by `read`."""
        if self._ws.closed:
            return
        with contextlib.suppress(ConnectionError, aiohttp.ClientError):
            await self._ws.send_bytes(bytes([DATA]) + data)

    async def read(self) -> bytes | None:
        """The next bytes from the pod's port; None once the stream has ended. ForwardError when
        the kubelet reports an error or the stream breaks."""
        while True:
            msg = await self._ws.receive()
            if msg.type == aiohttp.WSMsgType.ERROR:
                raise ForwardError(
                    f"The port-forward stream to pod {self._pod} broke ({type(msg.data).__name__})."
                )
            if msg.type in CLOSED:
                return None
            if msg.type not in (aiohttp.WSMsgType.BINARY, aiohttp.WSMsgType.TEXT):
                continue
            frame = msg.data if isinstance(msg.data, bytes) else msg.data.encode()
            if not frame or frame[0] not in self._prefix:
                continue  # another port's channel: there is none
            channel = frame[0]
            data = self._payload(channel, frame[1:])
            if not data:
                continue
            if channel == ERROR:
                text = data.decode("utf-8", "replace")
                raise ForwardError(error_message(text, self._pod, self._port))
            return data

    async def close(self) -> None:
        await self._resources.aclose()  # closes the socket, then the client; safe to repeat
