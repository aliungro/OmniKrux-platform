"""Relay fake-cloud Kubernetes traffic to the local kind API over mutual TLS."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import ssl
import subprocess
import threading
from collections.abc import Awaitable, Callable
from concurrent.futures import Future
from contextlib import (
    AbstractAsyncContextManager,
    ExitStack,
    asynccontextmanager,
    suppress,
)
from dataclasses import asdict, dataclass
from pathlib import Path
from tempfile import TemporaryDirectory

import aiohttp
from aiohttp import WSMsgType, hdrs, web
from yarl import URL

_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}
_REQUEST_HEADERS = {
    "authorization",
    "host",
    "cookie",
    "origin",
    "content-length",
}
_WS_PROTOCOLS = {"v4.channel.k8s.io", "v5.channel.k8s.io", "portforward.k8s.io"}


class LoopbackThread[T]:
    """Own a loop and async server context for a synchronous TestClient fixture."""

    def __init__(self, start: Callable[[], AbstractAsyncContextManager[T]]):
        self._start = start
        self._ready: Future[T] = Future()
        self._finished: Future[None] = Future()
        self._stop_requested = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        try:
            self.value = self._ready.result(timeout=10)
        except BaseException:
            self._request_stop()
            self._thread.join(timeout=10)
            raise

    def _run(self) -> None:
        try:
            asyncio.run(self._serve())
        except BaseException as exc:  # noqa: BLE001 (report the thread failure to its owner)
            if not self._ready.done():
                self._ready.set_exception(exc)
            self._finished.set_exception(exc)
        else:
            self._finished.set_result(None)

    async def _serve(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stopping = asyncio.Event()
        async with self._start() as value:
            self._ready.set_result(value)
            if not self._stop_requested.is_set():
                await self._stopping.wait()

    def _request_stop(self) -> None:
        self._stop_requested.set()
        loop = getattr(self, "_loop", None)
        stopping = getattr(self, "_stopping", None)
        if loop is not None and stopping is not None:
            with suppress(RuntimeError):  # The server may already have stopped.
                loop.call_soon_threadsafe(stopping.set)

    def stop(self) -> None:
        self._request_stop()
        self._thread.join(timeout=10)
        if self._thread.is_alive():
            raise RuntimeError("Loopback test server did not stop")
        self._finished.result()


def _named(entries: list[dict], name: str, key: str) -> dict:
    return next(entry[key] for entry in entries if entry["name"] == name)


def _kind_upstream(kubeconfig: dict) -> tuple[URL, ssl.SSLContext]:
    context = _named(kubeconfig["contexts"], "kind-omnikrux-dev", "context")
    cluster = _named(kubeconfig["clusters"], context["cluster"], "cluster")
    user = _named(kubeconfig["users"], context["user"], "user")
    server = URL(cluster["server"])
    if (
        server.scheme != "https"
        or server.raw_host not in {"127.0.0.1", "::1", "localhost"}
        or str(server) not in {str(server.origin()), f"{server.origin()}/"}
    ):
        raise ValueError("The kind test API must be a loopback HTTPS origin")
    ca = base64.b64decode(cluster["certificate-authority-data"], validate=True).decode("ascii")
    tls = ssl.create_default_context(cadata=ca)
    with TemporaryDirectory(prefix="omnikrux-kind-relay-") as temporary:
        cert, key = Path(temporary) / "client.pem", Path(temporary) / "key.pem"
        cert.write_bytes(base64.b64decode(user["client-certificate-data"], validate=True))
        key.write_bytes(base64.b64decode(user["client-key-data"], validate=True))
        tls.load_cert_chain(cert, key)
    return server.origin(), tls


def _filtered_headers(headers, *, request: bool = False):
    connection = {
        name.strip().lower()
        for value in headers.getall(hdrs.CONNECTION, [])
        for name in value.split(",")
    }
    blocked = _HOP_HEADERS | connection
    if request:
        blocked |= _REQUEST_HEADERS
    return [
        (key, value)
        for key, value in headers.items()
        if key.lower() not in blocked
        and not key.lower().startswith("sec-websocket-")
        and not (request and key.lower().startswith(("impersonate-", "x-remote-")))
    ]


def _status(code: int, reason: str, message: str) -> web.Response:
    return web.json_response(
        {
            "apiVersion": "v1",
            "kind": "Status",
            "status": "Failure",
            "code": code,
            "reason": reason,
            "message": message,
        },
        status=code,
    )


def _stream_kind(request: web.Request) -> str:
    if request.query.get("watch", "").lower() in {"true", "1"}:
        return "watch"
    if request.path.endswith("/log") and request.query.get("follow", "").lower() in {"true", "1"}:
        return "logs"
    return "http"


async def _pipe_http(upstream, downstream, *, line_framed: bool) -> None:
    pending = b""
    async for chunk in upstream.content.iter_any():
        if not line_framed:
            await downstream.write(chunk)
            continue
        complete, newline, pending = (pending + chunk).rpartition(b"\n")
        if newline:
            await downstream.write(complete + newline)
    if pending:
        await downstream.write(pending)


async def _pipe_ws(source, destination) -> int:
    async for message in source:
        if message.type == WSMsgType.BINARY:
            await destination.send_bytes(message.data)
        elif message.type == WSMsgType.TEXT:
            await destination.send_str(message.data)
        elif message.type == WSMsgType.ERROR:
            return 1011
    code = source.close_code
    if code in {None, 1006, 1015}:
        return 1011
    return 1000 if code in {1004, 1005} else code


async def _first_done(*operations: Awaitable):
    tasks = [asyncio.create_task(operation) for operation in operations]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        # Surface a simultaneous real transport failure before treating expiry as clean EOF.
        for task in done:
            if task.exception() is not None:
                task.result()
        return next(task.result() for task in tasks if task in done)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@dataclass(frozen=True)
class AcceptedRequest:
    kind: str
    path: str
    raw_path: str
    token: str


class CloudKubeProxy:
    """A fake cloud Kubernetes API backed by kind over mutual TLS.

    Deliberately stricter than the real API server: expiry cleanly ends existing
    watch, follow-log, and WebSocket streams. OmniKrux must reopen using a new token.
    """

    def __init__(self, kubeconfig: dict, token_check: Callable[[str | None], bool]):
        self._upstream, self._tls = _kind_upstream(kubeconfig)
        self._token_check = token_check
        self._lock = threading.Lock()
        self._accepted: list[AcceptedRequest] = []
        self._opened: list[AcceptedRequest] = []
        self._expired: list[AcceptedRequest] = []
        self._server = LoopbackThread(self._serve)
        self.url = self._server.value

    @property
    def accepted(self) -> list[AcceptedRequest]:
        with self._lock:
            return list(self._accepted)

    @property
    def opened(self) -> list[AcceptedRequest]:
        with self._lock:
            return list(self._opened)

    @property
    def expired(self) -> list[AcceptedRequest]:
        with self._lock:
            return list(self._expired)

    @property
    def tokens_seen(self) -> list[str]:
        return [request.token for request in self.accepted]

    def stop(self) -> None:
        self._server.stop()

    @asynccontextmanager
    async def _serve(self):
        timeout = aiohttp.ClientTimeout(total=None, connect=8, sock_connect=8)
        async with aiohttp.ClientSession(
            timeout=timeout,
            auto_decompress=False,
            trust_env=False,
            skip_auto_headers={hdrs.ACCEPT_ENCODING},
        ) as session:
            # aiohttp uses session.request for the WebSocket handshake too.
            send = session.request

            def request(method, url, **kwargs):
                return send(method, url, **(kwargs | {"allow_redirects": False}))

            session.request = request
            self._session = session
            app = web.Application()
            app.router.add_route("*", "/{path:.*}", self._handle)
            runner = web.AppRunner(
                app,
                access_log=None,
                shutdown_timeout=2,
                handler_cancellation=True,
                auto_decompress=False,
            )
            await runner.setup()
            try:
                await web.TCPSite(runner, "127.0.0.1", 0).start()
                yield f"http://127.0.0.1:{runner.addresses[0][1]}"
            finally:
                await runner.cleanup()

    async def _handle(self, request: web.Request) -> web.StreamResponse:
        authorization = request.headers.get(hdrs.AUTHORIZATION)
        if (
            authorization is None
            or not authorization.startswith("Bearer ")
            or not authorization.removeprefix("Bearer ")
            or not self._token_check(authorization)
        ):
            return _status(401, "Unauthorized", "Unauthorized")
        raw_path = request.raw_path
        if not raw_path.startswith("/") or raw_path.startswith("//"):
            return _status(400, "BadRequest", "Invalid request target")
        upstream = URL(f"{self._upstream}{raw_path}", encoded=True)
        websocket = request.headers.get(hdrs.UPGRADE, "").lower() == "websocket"
        seen = AcceptedRequest(
            "ws" if websocket else _stream_kind(request),
            request.path,
            raw_path,
            authorization.removeprefix("Bearer "),
        )
        with self._lock:
            self._accepted.append(seen)
        headers = _filtered_headers(request.headers, request=True)
        if websocket:
            return await self._websocket(request, upstream, headers, authorization, seen)
        return await self._http(request, upstream, headers, authorization, seen)

    async def _expire(self, authorization: str, seen: AcceptedRequest) -> int:
        while self._token_check(authorization):
            await asyncio.sleep(0.1)
        with self._lock:
            self._expired.append(seen)
        return 1000  # also the normal WebSocket close code

    async def _http(self, request, target, headers, authorization, seen):
        body = request.content.iter_any() if request.can_read_body else None
        stream = seen.kind in {"watch", "logs"}
        if stream:
            headers = [(key, value) for key, value in headers if key.lower() != "accept-encoding"]
            headers.append((hdrs.ACCEPT_ENCODING, "identity"))
        downstream = None
        try:
            async with self._session.request(
                request.method,
                target,
                data=body,
                headers=headers,
                ssl=self._tls,
            ) as upstream:
                stream = stream and 200 <= upstream.status < 300
                response_headers = _filtered_headers(upstream.headers)
                if stream:
                    if upstream.headers.get(hdrs.CONTENT_ENCODING, "identity") != "identity":
                        return _status(502, "BadGateway", "Unexpected upstream stream encoding")
                    response_headers = [
                        (key, value)
                        for key, value in response_headers
                        if key.lower() != "content-length"
                    ]
                downstream = web.StreamResponse(status=upstream.status, headers=response_headers)
                await downstream.prepare(request)
                if stream:
                    with self._lock:
                        self._opened.append(seen)
                    await _first_done(
                        _pipe_http(upstream, downstream, line_framed=True),
                        self._expire(authorization, seen),
                    )
                else:
                    await _pipe_http(upstream, downstream, line_framed=False)
                await downstream.write_eof()
                return downstream
        except (aiohttp.ClientError, ConnectionResetError, TimeoutError):
            if downstream is None or not downstream.prepared:
                return _status(502, "BadGateway", "Kind API relay failed")
            # An actual late transport failure must stay distinct from intentional expiry.
            if request.transport is not None:
                request.transport.close()
            return downstream

    async def _websocket(self, request, target, headers, authorization, seen):
        offered = tuple(
            part.strip()
            for value in request.headers.getall(hdrs.SEC_WEBSOCKET_PROTOCOL, [])
            for part in value.split(",")
            if part.strip() in _WS_PROTOCOLS
        )
        if not offered:
            return _status(400, "BadRequest", "Unsupported Kubernetes WebSocket protocol")
        downstream = None
        try:
            async with self._session.ws_connect(
                target,
                method=request.method,
                headers=headers,
                protocols=offered,
                ssl=self._tls,
                timeout=aiohttp.ClientWSTimeout(ws_close=2),
                max_msg_size=0,
            ) as upstream:
                if upstream.protocol not in offered:
                    return _status(502, "BadGateway", "Kind refused the WebSocket protocol")
                downstream = web.WebSocketResponse(
                    protocols=(upstream.protocol,),
                    timeout=2,
                    compress=False,
                    max_msg_size=0,
                )
                await downstream.prepare(request)
                code = await _first_done(
                    _pipe_ws(downstream, upstream),
                    _pipe_ws(upstream, downstream),
                    self._expire(authorization, seen),
                )
                await downstream.close(code=code)
                await upstream.close(code=code)
                return downstream
        except aiohttp.WSServerHandshakeError as exc:
            return _status(exc.status, "UpstreamRejected", "Kind refused the WebSocket upgrade")
        except (aiohttp.ClientError, ConnectionResetError, TimeoutError):
            if downstream is None or not downstream.prepared:
                return _status(502, "BadGateway", "Kind API relay failed")
            await downstream.close(code=1011, drain=False)
            return downstream


async def _serve_smoke(port: int, kubeconfig: dict, state: Path) -> None:
    from tests.fakecloud import serve_fake_cloud, write_gcloud_login

    project = "kind-cloud-test"
    refresh_token = "synthetic-kind-gcp-refresh"
    principal = "gcp-kind@example.test"
    async with serve_fake_cloud(port=port) as cloud:
        with ExitStack() as stack:
            proxy = CloudKubeProxy(kubeconfig, cloud.kube_token_ok("gcp"))
            stack.callback(proxy.stop)
            container_cloud = "http://host.docker.internal"
            endpoints = {
                name: url.replace("http://127.0.0.1", container_cloud, 1)
                for name, url in asdict(cloud.endpoints()).items()
            }
            endpoints_json = json.dumps(endpoints, separators=(",", ":"))
            adc = state / "gcloud"
            env_file = state / "endpoints.env"
            cloud.gcp.refresh_tokens[refresh_token] = principal
            cloud.gcp.add_gke(
                project,
                "gke-dev",
                server=proxy.url.replace("http://127.0.0.1", container_cloud, 1),
            )
            write_gcloud_login(
                adc,
                project=project,
                adc={
                    "type": "authorized_user",
                    "account": principal,
                    "client_id": "fake.apps.googleusercontent.com",
                    "client_secret": "synthetic-kind-gcp-secret",
                    "refresh_token": refresh_token,
                    "token_uri": endpoints["gcp_oauth"],
                },
            )
            env_file.write_text(f"OMNIKRUX_CLOUD_ENDPOINTS={endpoints_json}\n", encoding="utf-8")
            print(f"OMNIKRUX_CLOUD_ENDPOINTS={endpoints_json}", flush=True)
            print(f"Endpoint file {env_file}\nSynthetic ADC directory {adc}", flush=True)
            await asyncio.Event().wait()


def _main() -> None:
    import yaml

    from tests.kube.test_source_kind import find_kind

    parser = argparse.ArgumentParser(description="Serve the local GKE smoke fixture")
    parser.add_argument("--serve", required=True, type=int, metavar="PORT")
    parser.add_argument(
        "--state-dir", type=Path, help="new directory for synthetic ADC and endpoints"
    )
    args = parser.parse_args()
    if not 1 <= args.serve <= 65535:
        parser.error("--serve must be a port between 1 and 65535")
    kind = find_kind()
    if kind is None:
        parser.error("kind is required on PATH or in .tools")
    result = subprocess.run(
        [kind, "get", "kubeconfig", "--name", "omnikrux-dev"],
        capture_output=True,
        encoding="utf-8",
        timeout=20,
        check=False,
    )
    if result.returncode:
        parser.error("could not read the kubeconfig for local kind cluster omnikrux-dev")
    kubeconfig = yaml.safe_load(result.stdout)
    with ExitStack() as stack:
        if args.state_dir is None:
            state = Path(stack.enter_context(TemporaryDirectory(prefix="omnikrux-gke-smoke-")))
        else:
            state = args.state_dir.resolve()
            state.mkdir()
        with suppress(KeyboardInterrupt):
            asyncio.run(_serve_smoke(args.serve, kubeconfig, state))


if __name__ == "__main__":
    _main()
