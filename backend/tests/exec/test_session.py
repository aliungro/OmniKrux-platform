"""ExecBridge between a browser socket and an exec channel, both faked."""

import asyncio
import json
import logging

import pytest
from starlette.websockets import WebSocketDisconnect, WebSocketDisconnected

from omnikrux.exec.session import ExecBridge


class FakeExecChannel:
    """A container's shell: tests push what it prints with `emit`, and end it with `finish`."""

    def __init__(self) -> None:
        self.stdin: list[bytes] = []
        self.resizes: list[tuple[int, int]] = []
        self.closed = False
        self.outbox: asyncio.Queue[tuple[int, bytes] | None | Exception] = asyncio.Queue()
        self.got_input = asyncio.Event()

    def emit(self, channel: int, data: bytes) -> None:
        self.outbox.put_nowait((channel, data))

    def finish(self, status: dict | None = None) -> None:
        if status is not None:
            self.emit(3, json.dumps(status).encode())
        self.outbox.put_nowait(None)

    async def send_stdin(self, data: bytes) -> None:
        self.stdin.append(data)
        self.got_input.set()

    async def resize(self, cols: int, rows: int) -> None:
        self.resizes.append((cols, rows))
        self.got_input.set()

    async def read(self) -> tuple[int, bytes] | None:
        if self.closed:
            return None
        item = await self.outbox.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def close(self) -> None:
        self.closed = True
        self.outbox.put_nowait(None)


class BrowserSocket:
    """The browser's end: `type` sends a message, `leave` disconnects; records what it got."""

    def __init__(self, app=None) -> None:
        self.app = app
        self.headers = {"host": "testserver"}
        self.inbox: asyncio.Queue[dict] = asyncio.Queue()
        self.sent: list[dict] = []
        self.closed: tuple[int, str | None] | None = None

    def type(self, message: dict | str) -> None:
        text = message if isinstance(message, str) else json.dumps(message)
        self.inbox.put_nowait({"type": "websocket.receive", "text": text})

    def leave(self) -> None:
        self.inbox.put_nowait({"type": "websocket.disconnect", "code": 1001})

    async def accept(self) -> None: ...

    async def receive(self) -> dict:
        return await self.inbox.get()

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed = (code, reason)

    def output(self, kind: str) -> str:
        return "".join(m["data"] for m in self.sent if m["type"] == kind)


NON_ZERO = {
    "metadata": {},
    "status": "Failure",
    "message": "command terminated with non-zero exit code: exit status 3",
    "reason": "NonZeroExitCode",
    "details": {"causes": [{"reason": "ExitCode", "message": "3"}]},
}


async def run(channel: FakeExecChannel, ws: BrowserSocket) -> None:
    await asyncio.wait_for(ExecBridge(channel).run(ws), 5)


async def test_stdin_and_resize_forwarded():
    channel, ws = FakeExecChannel(), BrowserSocket()
    bridge = asyncio.create_task(run(channel, ws))
    ws.type({"type": "stdin", "data": "ls -l\r"})
    ws.type({"type": "resize", "cols": 120, "rows": 40})
    ws.type("not json")  # ignored, like every malformed message
    ws.type({"type": "resize", "cols": "wide", "rows": 40})
    ws.type({"type": "resize", "cols": 0, "rows": 40})
    ws.type({"type": "stdin", "data": 42})
    ws.type({"type": "launch"})
    ws.type({"type": "stdin", "data": "é\x03"})
    for _ in range(500):
        if len(channel.stdin) == 2:
            break
        await asyncio.sleep(0.01)
    channel.finish({"metadata": {}, "status": "Success"})
    await bridge

    assert channel.stdin == [b"ls -l\r", "é\x03".encode()]
    assert channel.resizes == [(120, 40)]
    assert ws.sent == [{"type": "exit", "code": 0, "message": None, "cannot_run": False}]


async def test_stdout_stderr_relayed_as_utf8_with_replacement():
    channel, ws = FakeExecChannel(), BrowserSocket()
    euro = "€".encode()  # three bytes, split across frames
    channel.emit(1, b"price: " + euro[:1])
    channel.emit(2, b"bad \xff byte")
    channel.emit(1, euro[1:2])
    channel.emit(1, b"")  # Kubernetes opens each stream with an empty frame
    channel.emit(1, euro[2:] + b"\r\n")
    channel.emit(2, b" and a cut-off " + euro[:2])  # the stream ends mid-character
    channel.finish({"metadata": {}, "status": "Success"})

    await run(channel, ws)

    assert ws.output("stdout") == "price: €\r\n"
    assert ws.output("stderr") == "bad � byte and a cut-off �"
    assert all(m["data"] for m in ws.sent if m["type"] in ("stdout", "stderr"))
    assert ws.sent[-1] == {"type": "exit", "code": 0, "message": None, "cannot_run": False}


NO_SH = 'OCI runtime exec failed: exec: "/bin/sh": stat /bin/sh: no such file or directory'


@pytest.mark.parametrize(
    ("status", "code", "message", "cannot_run"),
    [
        ({"metadata": {}, "status": "Success"}, 0, None, False),
        (NON_ZERO, 3, None, False),
        (
            {
                "status": "Failure",
                "message": 'exec: "bash": executable file not found in $PATH',
                "reason": "InternalError",
            },
            None,
            'The command couldn\'t run: exec: "bash": executable file not found in $PATH',
            True,
        ),
        (
            {
                "status": "Failure",
                "message": NO_SH,
                "reason": "NonZeroExitCode",
                "details": {"causes": [{"reason": "ExitCode", "message": "126"}]},
            },
            126,
            f"The command couldn't run in the container (exit 126: it can't be executed): {NO_SH}",
            True,
        ),
        (
            {
                "status": "Failure",
                "reason": "NonZeroExitCode",
                "details": {"causes": [{"reason": "ExitCode", "message": "127"}]},
            },
            127,
            "The command couldn't run in the container (exit 127: it wasn't found).",
            True,
        ),
        (None, None, "The shell ended without an exit status.", False),
    ],
)
async def test_exit_code_from_status_channel(status, code, message, cannot_run):
    channel, ws = FakeExecChannel(), BrowserSocket()
    channel.finish(status)

    await run(channel, ws)

    assert ws.sent == [{"type": "exit", "code": code, "message": message, "cannot_run": cannot_run}]
    assert ws.closed == (1000, None)
    assert channel.closed


@pytest.mark.parametrize("code", [126, 127])
@pytest.mark.parametrize("channel_id", [1, 2])
async def test_exit_127_after_output_is_a_normal_exit(code, channel_id):
    """A working shell whose last command failed also exits 126 or 127: not a missing shell."""
    channel, ws = FakeExecChannel(), BrowserSocket()
    channel.emit(channel_id, b"zsh: command not found: typo\r\n")
    channel.finish(
        {
            "status": "Failure",
            "message": f"command terminated with exit code {code}",
            "reason": "NonZeroExitCode",
            "details": {"causes": [{"reason": "ExitCode", "message": str(code)}]},
        }
    )

    await run(channel, ws)

    assert ws.sent[-1] == {"type": "exit", "code": code, "message": None, "cannot_run": False}


async def test_exit_127_without_output_cannot_run_said_once():
    channel, ws = FakeExecChannel(), BrowserSocket()
    channel.emit(1, b"")  # Kubernetes opens each stream with an empty frame: not output
    channel.finish(
        {
            "status": "Failure",
            "message": "command terminated with exit code 127",
            "reason": "NonZeroExitCode",
            "details": {"causes": [{"reason": "ExitCode", "message": "127"}]},
        }
    )

    await run(channel, ws)

    [exited] = ws.sent
    assert exited["cannot_run"] is True and exited["code"] == 127
    assert (
        exited["message"]
        == "The command couldn't run in the container (exit 127: it wasn't found)."
    )
    assert exited["message"].count("127") == 1


async def test_browser_close_closes_channel():
    channel, ws = FakeExecChannel(), BrowserSocket()
    bridge = asyncio.create_task(run(channel, ws))
    ws.type({"type": "stdin", "data": "top\r"})
    await asyncio.wait_for(channel.got_input.wait(), 5)
    ws.leave()
    await bridge

    assert channel.closed
    assert ws.sent == []  # the browser is gone: no exit, nothing to close
    assert ws.closed is None


async def test_broken_channel_is_an_error_1011():
    channel, ws = FakeExecChannel(), BrowserSocket()
    channel.emit(1, b"$ ")
    channel.outbox.put_nowait(ConnectionResetError("Connection lost"))

    await run(channel, ws)

    assert ws.sent[0] == {"type": "stdout", "data": "$ "}
    [error] = ws.sent[1:]
    assert error["type"] == "error"
    assert error["message"].startswith("The connection to the shell broke")
    assert "Traceback" not in error["message"]
    assert ws.closed == (1011, None)
    assert channel.closed


async def test_broken_pasted_text_is_forwarded_with_replacement():
    """A lone surrogate is valid JSON (what JSON.stringify gives for broken pasted text)."""
    channel, ws = FakeExecChannel(), BrowserSocket()
    bridge = asyncio.create_task(run(channel, ws))
    ws.inbox.put_nowait({"type": "websocket.receive", "text": '{"type":"stdin","data":"a\ud800b"}'})
    await asyncio.wait_for(channel.got_input.wait(), 5)
    channel.finish({"metadata": {}, "status": "Success"})
    await bridge

    assert channel.stdin == [b"a?b"]
    assert ws.sent == [{"type": "exit", "code": 0, "message": None, "cannot_run": False}]


class RefusingChannel(FakeExecChannel):
    async def send_stdin(self, data: bytes) -> None:
        raise RuntimeError("stdin refused")


async def test_failed_browser_input_is_an_error_1011():
    channel, ws = RefusingChannel(), BrowserSocket()
    ws.type({"type": "stdin", "data": "ls\r"})

    await run(channel, ws)

    [error] = ws.sent
    assert error["type"] == "error"
    assert error["message"] == (
        "The console couldn't pass your typing to the shell (RuntimeError). "
        "Reconnect to start a new shell."
    )
    assert ws.closed == (1011, None)
    assert channel.closed


class LeavingSocket(BrowserSocket):
    """A browser that is gone by the time the bridge writes to it."""

    async def send_text(self, text: str) -> None:
        raise WebSocketDisconnect(1006)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        raise WebSocketDisconnected('Cannot call "send" once a close message has been sent.')


async def test_browser_gone_while_writing_is_quiet(caplog):
    channel, ws = FakeExecChannel(), LeavingSocket()
    channel.emit(1, b"$ ")

    with caplog.at_level(logging.INFO, logger="omnikrux.exec.session"):
        await run(channel, ws)

    assert channel.closed
    assert caplog.records == []  # not a broken stream, not a failure: the browser left


async def test_browser_gone_at_the_end_is_quiet():
    channel, ws = FakeExecChannel(), BrowserSocket()

    async def gone(code: int = 1000, reason: str | None = None) -> None:
        raise WebSocketDisconnected('Cannot call "send" once a close message has been sent.')

    ws.close = gone
    channel.finish({"metadata": {}, "status": "Success"})

    await run(channel, ws)  # does not raise

    assert ws.sent == [{"type": "exit", "code": 0, "message": None, "cannot_run": False}]
    assert channel.closed
