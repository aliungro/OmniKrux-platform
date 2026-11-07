"""An interactive shell in a container: the browser's socket on one side, the container's exec
stream on the other.

`KubeExecChannel` speaks Kubernetes' `v4.channel.k8s.io` WebSocket protocol: every binary frame
starts with a channel byte (0 stdin, 1 stdout, 2 stderr, 3 status, 4 resize). The installed
kubernetes_asyncio only offers v4 (it has no `v5.channel.k8s.io` support), which is all a TTY
session needs. `ExecBridge` relays between the browser and any `ExecChannel`.
"""

import asyncio
import codecs
import contextlib
import json
import logging
from contextlib import AsyncExitStack
from typing import Literal, NamedTuple, Protocol, Self

import aiohttp
from kubernetes_asyncio.client import CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketDisconnected

from omnikrux.kube.connections import ClusterConnections

log = logging.getLogger(__name__)

STDIN, STDOUT, STDERR, STATUS, RESIZE = range(5)
PROTOCOL = "v4.channel.k8s.io"
CONNECT_SECONDS = 30  # for the exec handshake
MAX_TERMINAL_SIDE = 10_000  # columns or rows; anything larger is not a terminal
# The browser has gone: a send or close finds the socket closed.
BROWSER_GONE = (WebSocketDisconnect, WebSocketDisconnected)


class ExecChannel(Protocol):
    async def send_stdin(self, data: bytes) -> None: ...

    async def resize(self, cols: int, rows: int) -> None: ...

    async def read(self) -> tuple[int, bytes] | None:
        """The next frame as (channel id, data); None once the stream has ended."""
        ...

    async def close(self) -> None: ...


class KubeExecChannel:
    """One exec stream, opened with `open` and owning its client; `close` releases both."""

    def __init__(self, ws: aiohttp.ClientWebSocketResponse, resources: AsyncExitStack):
        self._ws = ws
        self._resources = resources

    @classmethod
    async def open(
        cls,
        connections: ClusterConnections,
        cluster: str,
        namespace: str,
        pod: str,
        container: str,
        command: list[str],
    ) -> Self:
        """Unknown cluster: KeyError. A refused handshake: ApiException with its status."""
        async with AsyncExitStack() as stack:
            api = await stack.enter_async_context(connections.ws_api(cluster))
            connecting = await CoreV1Api(api).connect_get_namespaced_pod_exec(
                pod,
                namespace,
                command=command,
                container=container,
                stdin=True,
                stdout=True,
                stderr=True,
                tty=True,
                _preload_content=False,
                _headers={"sec-websocket-protocol": PROTOCOL},
            )
            try:
                async with asyncio.timeout(CONNECT_SECONDS):
                    ws = await stack.enter_async_context(connecting)
            except aiohttp.WSServerHandshakeError as exc:  # no body: the status says enough
                raise ApiException(status=exc.status, reason=exc.message) from exc
            return cls(ws, stack.pop_all())

    async def _send(self, channel: int, data: bytes) -> None:
        if self._ws.closed:
            return  # the stream has ended; `read` reports how
        try:
            await self._ws.send_bytes(bytes([channel]) + data)
        except (ConnectionError, aiohttp.ClientError):
            pass  # likewise: a broken stream is reported by `read`

    async def send_stdin(self, data: bytes) -> None:
        await self._send(STDIN, data)

    async def resize(self, cols: int, rows: int) -> None:
        await self._send(RESIZE, json.dumps({"Width": cols, "Height": rows}).encode())

    async def read(self) -> tuple[int, bytes] | None:
        while True:
            msg = await self._ws.receive()
            if msg.type == aiohttp.WSMsgType.ERROR:
                raise msg.data
            if msg.type in (
                aiohttp.WSMsgType.CLOSE,
                aiohttp.WSMsgType.CLOSING,
                aiohttp.WSMsgType.CLOSED,
            ):
                return None
            if msg.type not in (aiohttp.WSMsgType.BINARY, aiohttp.WSMsgType.TEXT):
                continue
            data = msg.data if isinstance(msg.data, bytes) else msg.data.encode()
            if len(data) > 1:  # each stream opens with an empty frame
                return data[0], data[1:]

    async def close(self) -> None:
        await self._resources.aclose()  # closes the socket, then the client; safe to repeat


# Exit codes a shell gives when the command itself couldn't be started.
CANNOT_RUN_CODES = {126: "it can't be executed", 127: "it wasn't found"}


class ShellExit(NamedTuple):
    code: int | None
    message: str | None  # only when the exit code alone doesn't tell the story
    cannot_run: bool  # the command couldn't start in the container (no shell there, say)


def exit_from_status(raw: bytes | None) -> ShellExit:
    """How the shell ended, from the status channel's `Status`."""
    if raw is None:
        return ShellExit(None, "The shell ended without an exit status.", False)
    try:
        status = json.loads(raw)
    except ValueError:
        status = None
    if not isinstance(status, dict):
        return ShellExit(None, "The shell ended with a status the console couldn't read.", False)
    if status.get("status") == "Success":
        return ShellExit(0, None, False)
    message = status.get("message")
    reason = message[:500] if isinstance(message, str) and message else None
    for cause in (status.get("details") or {}).get("causes") or []:
        if cause.get("reason") == "ExitCode":
            try:
                code = int(cause.get("message"))
            except (TypeError, ValueError):
                break
            if code not in CANNOT_RUN_CODES:
                return ShellExit(code, None, False)
            words = f"The command couldn't run in the container (exit {code}: "
            words += CANNOT_RUN_CODES[code] + ")"
            return ShellExit(code, f"{words}: {reason}" if reason else f"{words}.", True)
    if reason:  # the runtime couldn't start the command at all (an InternalError)
        return ShellExit(None, f"The command couldn't run: {reason}", True)
    return ShellExit(None, "The shell ended with an error.", False)


class SessionEnd(NamedTuple):
    """How a session ended, for its audit record."""

    outcome: Literal["ended", "failed"]
    message: str


BROWSER_LEFT = SessionEnd("ended", "The browser closed the shell.")


def session_end(ended: ShellExit) -> SessionEnd:
    """`ended` with the exit code when the shell exited; `failed` when it couldn't run."""
    if ended.code is not None and not ended.cannot_run:
        return SessionEnd("ended", f"exit {ended.code}")
    return SessionEnd("failed", ended.message or "The shell ended with an error.")


def _browser_message(text: str) -> dict | None:
    try:
        msg = json.loads(text)
    except ValueError:
        return None
    return msg if isinstance(msg, dict) else None


def _side(value: object) -> bool:
    return type(value) is int and 0 < value <= MAX_TERMINAL_SIDE


class ExecBridge:
    def __init__(self, channel: ExecChannel):
        self._channel = channel

    async def run(self, websocket: WebSocket) -> SessionEnd:
        """Relay until either side ends, and return how it ended. The channel is always closed.
        If the shell ended, the browser gets `exit` (or `error` if the stream broke) and the
        socket is closed; if the browser's input couldn't be passed on, it gets `error` and the
        socket is closed; if the browser left, nothing more is sent."""
        to_shell = asyncio.create_task(self._from_browser(websocket))
        to_browser = asyncio.create_task(self._to_browser(websocket))
        tasks = (to_shell, to_browser)
        try:
            try:
                await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.wait(tasks)  # never raises the tasks' exceptions or swallows ours
        finally:
            await self._channel.close()
        failed = {
            task: exc
            for task in tasks
            if not task.cancelled()
            and (exc := task.exception())
            and not isinstance(exc, BROWSER_GONE)
        }
        for exc in failed.values():
            log.warning("exec socket failed", exc_info=exc)
        end = BROWSER_LEFT
        with contextlib.suppress(*BROWSER_GONE):  # the browser may leave at this very moment
            if to_browser.done() and not to_browser.cancelled() and not to_browser.exception():
                code, end = to_browser.result()  # the shell ended
                await websocket.close(code=code)
            elif to_shell in failed:
                message = (
                    "The console couldn't pass your typing to the shell "
                    f"({type(failed[to_shell]).__name__}). Reconnect to start a new shell."
                )
                end = SessionEnd("failed", message)
                await websocket.send_text(json.dumps({"type": "error", "message": message}))
                await websocket.close(code=1011)
            elif to_browser in failed:
                end = SessionEnd(
                    "failed", f"The shell session failed ({type(failed[to_browser]).__name__})."
                )
        return end

    async def _from_browser(self, websocket: WebSocket) -> None:
        """Keystrokes and resizes into the channel until the browser goes away. Messages that
        aren't one of the two are ignored."""
        while True:
            event = await websocket.receive()
            if event["type"] == "websocket.disconnect":
                return
            msg = _browser_message(event.get("text") or "")
            if msg is None:
                continue
            if msg.get("type") == "stdin" and isinstance(msg.get("data"), str):
                # "replace": a lone surrogate (broken pasted text) is valid JSON, not valid UTF-8
                await self._channel.send_stdin(msg["data"].encode("utf-8", "replace"))
            elif msg.get("type") == "resize" and _side(msg.get("cols")) and _side(msg.get("rows")):
                await self._channel.resize(msg["cols"], msg["rows"])

    async def _to_browser(self, websocket: WebSocket) -> tuple[int, SessionEnd]:
        """The shell's output to the browser, then how it ended; returns the close code and
        how the session ended."""
        decoders = {
            channel: codecs.getincrementaldecoder("utf-8")(errors="replace")
            for channel in (STDOUT, STDERR)
        }
        kinds = {STDOUT: "stdout", STDERR: "stderr"}
        status: bytes | None = None

        async def send(channel: int, text: str) -> None:
            if text:
                await websocket.send_text(json.dumps({"type": kinds[channel], "data": text}))

        while True:
            try:
                frame = await self._channel.read()
            except Exception as exc:  # noqa: BLE001 (the stream broke; said in words, logged by type)
                log.info("exec stream broke (%s)", type(exc).__name__)
                message = (
                    f"The connection to the shell broke ({type(exc).__name__}). "
                    "Reconnect to start a new shell."
                )
                await websocket.send_text(json.dumps({"type": "error", "message": message}))
                return 1011, SessionEnd("failed", message)
            if frame is None:
                break
            channel, data = frame
            if channel in decoders:
                await send(channel, decoders[channel].decode(data))
            elif channel == STATUS:
                status = data
        for channel, decoder in decoders.items():  # a character cut off at the very end
            await send(channel, decoder.decode(b"", final=True))
        ended = exit_from_status(status)
        await websocket.send_text(json.dumps({"type": "exit", **ended._asdict()}))
        return 1000, session_end(ended)
