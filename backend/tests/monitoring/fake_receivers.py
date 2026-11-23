"""Where alert notifications go: a fake webhook receiver and a fake SMTP server, both real servers
on 127.0.0.1 (nothing is mocked inside the code under test).

`FakeWebhookReceiver` records every request (`requests`, each a `FakeRequest` with `body` bytes
and a `json` property). `mode` picks the answer: ok (200), error500, hang (no answer until
`release`) or echo (400 with the request's path, query and `Authorization` header in the body, for
leak tests). `status_codes`, when set, is consumed one request at a time and wins over `mode`.

`FakeSmtp` speaks enough ESMTP over asyncio streams: EHLO, STARTTLS (with a `TlsMaterial`; AUTH is
then offered only once the connection is encrypted), AUTH PLAIN and LOGIN against `user` and
`password`, MAIL, RCPT, DATA, RSET, NOOP and QUIT. Accepted mail lands in `messages`.
`reject_auth` refuses every login (535); `echo_password_on_auth_failure` makes that 535 line repeat
the password it was given, for leak tests; `reject_rcpt` answers every RCPT with
`550 5.1.1 <addr>: {reject_rcpt}`; `refuse_addresses` refuses only those recipients;
`stall_rcpt_seconds` waits that long before answering each RCPT (a slow server);
`require_auth` refuses MAIL until a login succeeded.
"""

import asyncio
import base64
import binascii
import ssl
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Literal

from aiohttp import web

from tests.monitoring.fakes import FakeRequest, TlsMaterial, _serve, _server_ssl

WebhookMode = Literal["ok", "error500", "hang", "echo"]


class FakeWebhookReceiver:
    def __init__(self) -> None:
        self.url = ""
        self.requests: list[FakeRequest] = []
        self.mode: WebhookMode = "ok"
        self.status_codes: list[int] = []
        self.release = asyncio.Event()

    async def handle(self, request: web.Request) -> web.StreamResponse:
        params = {key: request.query.getall(key) for key in request.query}
        body = await request.read()
        self.requests.append(
            FakeRequest(request.method, request.path, params, dict(request.headers), body)
        )
        if self.mode == "hang":
            await self.release.wait()
        if self.status_codes:
            return web.Response(status=self.status_codes.pop(0), text="scripted")
        if self.mode == "error500":
            return web.Response(status=500, text="internal error")
        if self.mode == "echo":
            seen = request.headers.get("Authorization", "")
            return web.Response(
                status=400, text=f"bad request {request.path_qs}\nAuthorization: {seen}"
            )
        return web.Response(text="ok")


@asynccontextmanager
async def serve_fake_webhook(tls: TlsMaterial | None = None):
    server = FakeWebhookReceiver()
    async with _serve(server, tls):
        yield server


@dataclass
class ReceivedMail:
    sender: str
    recipients: list[str]
    data: bytes


class FakeSmtp:
    def __init__(self, tls: TlsMaterial | None = None) -> None:
        self.host = "127.0.0.1"
        self.port = 0
        self.user = "user"
        self.password = "password"
        self.messages: list[ReceivedMail] = []
        self.reject_auth = False
        self.reject_rcpt: str | None = None
        self.echo_password_on_auth_failure = False
        self.require_auth = False
        self.refuse_addresses: set[str] = set()
        self.stall_rcpt_seconds = 0.0
        self._tls = tls
        self._context: ssl.SSLContext | None = None
        self._writers: set[asyncio.StreamWriter] = set()

    async def _session(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._writers.add(writer)
        encrypted, authed = False, False
        sender: str | None = None
        recipients: list[str] = []

        async def say(line: str) -> None:
            writer.write(line.encode() + b"\r\n")
            await writer.drain()

        async def ask(prompt: str) -> bytes:
            await say(f"334 {base64.b64encode(prompt.encode()).decode()}")
            return await reader.readline()

        try:
            await say("220 fake.test ESMTP ready")
            while line := await reader.readline():
                verb, _, rest = line.decode(errors="replace").strip().partition(" ")
                verb = verb.upper()
                if verb in ("EHLO", "HELO"):
                    features = ["fake.test", "8BITMIME"]
                    if self._context is not None and not encrypted:
                        features.append("STARTTLS")
                    if self._context is None or encrypted:
                        features.append("AUTH PLAIN LOGIN")
                    for each in features[:-1]:
                        await say(f"250-{each}")
                    await say(f"250 {features[-1]}")
                elif verb == "STARTTLS":
                    if self._context is None or encrypted:
                        await say("502 5.5.1 STARTTLS not available")
                        continue
                    await say("220 2.0.0 Ready to start TLS")
                    await writer.start_tls(self._context)
                    encrypted, authed, sender, recipients = True, False, None, []
                elif verb == "AUTH":
                    if self._context is not None and not encrypted:
                        await say("530 5.7.0 Must issue a STARTTLS command first")
                        continue
                    authed = await self._auth(rest, ask, say)
                elif verb == "MAIL":
                    if self.require_auth and not authed:
                        await say("530 5.7.0 Authentication required")
                        continue
                    sender = _address(rest)
                    recipients = []
                    await say("250 2.1.0 OK")
                elif verb == "RCPT":
                    address = _address(rest)
                    if self.stall_rcpt_seconds:
                        await asyncio.sleep(self.stall_rcpt_seconds)
                    if sender is None:
                        await say("503 5.5.1 need MAIL first")
                    elif address in self.refuse_addresses:
                        await say(f"550 5.1.1 <{address}>: no such user")
                    elif self.reject_rcpt is not None:
                        await say(f"550 5.1.1 <{address}>: {self.reject_rcpt}")
                    else:
                        recipients.append(address)
                        await say("250 2.1.5 OK")
                elif verb == "DATA":
                    if sender is None or not recipients:
                        await say("503 5.5.1 need MAIL and RCPT first")
                        continue
                    await say("354 End data with <CR><LF>.<CR><LF>")
                    data = await _read_data(reader)
                    self.messages.append(ReceivedMail(sender, recipients, data))
                    sender, recipients = None, []
                    await say("250 2.0.0 OK queued")
                elif verb == "RSET":
                    sender, recipients = None, []
                    await say("250 2.0.0 OK")
                elif verb == "NOOP":
                    await say("250 2.0.0 OK")
                elif verb == "QUIT":
                    await say("221 2.0.0 bye")
                    break
                else:
                    await say("502 5.5.2 command not recognised")
        except (ConnectionError, ssl.SSLError):
            pass
        finally:
            self._writers.discard(writer)
            writer.close()

    async def _auth(self, rest: str, ask, say) -> bool:
        mechanism, _, initial = rest.partition(" ")
        try:
            if mechanism.upper() == "PLAIN":
                raw = initial.strip().encode() or (await ask("")).strip()
                _, user, password = base64.b64decode(raw).decode().split("\0")
            elif mechanism.upper() == "LOGIN":
                raw = initial.strip().encode() or (await ask("Username:")).strip()
                user = base64.b64decode(raw).decode()
                password = base64.b64decode((await ask("Password:")).strip()).decode()
            else:
                await say("504 5.5.4 unrecognised authentication type")
                return False
        except (binascii.Error, ValueError):
            await say("501 5.5.2 cannot decode the response")
            return False
        if not self.reject_auth and (user, password) == (self.user, self.password):
            await say("235 2.7.0 Authentication successful")
            return True
        reason = "Authentication credentials invalid"
        if self.echo_password_on_auth_failure:
            reason = f"{reason} (password {password})"
        await say(f"535 5.7.8 {reason}")
        return False


def _address(rest: str) -> str:
    _, _, tail = rest.partition(":")
    return tail.strip().split(">")[0].lstrip("<").split(" ")[0]


async def _read_data(reader: asyncio.StreamReader) -> bytes:
    lines = []
    while (line := await reader.readline()) not in (b".\r\n", b".\n", b""):
        lines.append(line[1:] if line.startswith(b"..") else line)
    return b"".join(lines)


@asynccontextmanager
async def serve_fake_smtp(tls: TlsMaterial | None = None):
    """A `FakeSmtp` on 127.0.0.1; with `tls` it offers STARTTLS (and AUTH only after it)."""
    server = FakeSmtp(tls)
    if tls is not None:
        with _server_ssl(tls, require_client_cert=False) as context:
            server._context = context  # loaded in memory: the temporary files may go
    listener = await asyncio.start_server(server._session, "127.0.0.1", 0)
    server.port = listener.sockets[0].getsockname()[1]
    try:
        yield server
    finally:
        listener.close()
        for writer in list(server._writers):
            writer.close()
        await listener.wait_closed()
