"""Fake Prometheus, Loki and Grafana over real HTTP, shared by every Monitoring test.

Nothing is mocked inside the code under test: it talks to a real aiohttp server on 127.0.0.1.
`url` is where to reach one; `requests` records every request (method, path, parameters from the
query string and a form body, headers). `mode` picks how a Prometheus or Loki answers:

    ok: everything works; hang: never answers until `release`; error500: 500 everywhere;
    not_prometheus: 200 with an HTML page everywhere; no_buildinfo: only the build info is 404.

Seed `results` (exact query text -> the `data` object a query answers with; any other query gets
an empty result of the right type), `errors` (exact query -> a `bad_data` error text, answered
400), `labels`, `label_values` and `metadata`. `require` makes a request without the matching
credentials answer 401; `echo_auth_in_errors` makes error bodies repeat the request's
`Authorization` header, for leak tests. With a `TlsMaterial` the server speaks HTTPS, and a
`ClientCert` requirement also demands a client certificate signed by the material's CA.
"""

import asyncio
import base64
import datetime
import ipaddress
import re
import ssl
import tempfile
from contextlib import ExitStack, asynccontextmanager, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import ClassVar, Literal

from aiohttp import web
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

Mode = Literal["ok", "hang", "error500", "not_prometheus", "no_buildinfo"]


@dataclass
class FakeRequest:
    method: str
    path: str
    params: dict[str, list[str]]
    headers: dict[str, str]


@dataclass(frozen=True)
class Basic:
    user: str
    password: str


@dataclass(frozen=True)
class Bearer:
    token: str


@dataclass(frozen=True)
class Header:
    name: str
    value: str


@dataclass(frozen=True)
class ClientCert:
    """A client certificate signed by the fake CA; checked by the TLS handshake."""


AuthRequirement = Basic | Bearer | Header | ClientCert


def _satisfied(require: AuthRequirement | None, headers: dict[str, str]) -> bool:
    lowered = {name.lower(): value for name, value in headers.items()}
    match require:
        case None | ClientCert():
            return True
        case Basic(user, password):
            token = base64.b64encode(f"{user}:{password}".encode()).decode()
            return lowered.get("authorization") == f"Basic {token}"
        case Bearer(token):
            return lowered.get("authorization") == f"Bearer {token}"
        case Header(name, value):
            return lowered.get(name.lower()) == value
    return False


class _FakeTool:
    """What a fake Prometheus and a fake Loki share: modes, auth, recording and seeded answers."""

    version = ""
    empty_instant: ClassVar[dict] = {}
    empty_range: ClassVar[dict] = {}

    def __init__(self) -> None:
        self.url = ""
        self.requests: list[FakeRequest] = []
        self.mode: Mode = "ok"
        self.release = asyncio.Event()
        self.require: AuthRequirement | None = None
        self.results: dict[str, dict] = {}
        self.errors: dict[str, str] = {}
        self.labels: list[str] = []
        self.label_values: dict[str, list[str]] = {}
        self.metadata: dict[str, list[dict]] = {}
        self.echo_auth_in_errors = False

    async def handle(self, request: web.Request) -> web.StreamResponse:
        params = {key: request.query.getall(key) for key in request.query}
        if request.method == "POST" and request.can_read_body:
            form = await request.post()
            for key in form:
                params.setdefault(key, []).extend(str(v) for v in form.getall(key))
        headers = dict(request.headers)
        self.requests.append(FakeRequest(request.method, request.path, params, headers))
        if self.mode == "hang":
            await self.release.wait()
        if not _satisfied(self.require, headers):
            return self._error(401, "unauthorized", headers)
        if self.mode == "error500":
            return self._error(500, "internal error", headers)
        if self.mode == "not_prometheus":
            return web.Response(text="<html><body>Sign in</body></html>", content_type="text/html")
        return self.route(request, params, headers)

    def route(
        self, request: web.Request, params: dict[str, list[str]], headers: dict[str, str]
    ) -> web.StreamResponse:
        raise NotImplementedError

    def _error(self, status: int, text: str, headers: dict[str, str]) -> web.Response:
        if self.echo_auth_in_errors:
            text = f"{text}: Authorization={headers.get('Authorization', '')}"
        return web.Response(status=status, text=text)

    def _query(self, params: dict[str, list[str]], empty: dict) -> web.Response:
        query = (params.get("query") or [""])[0]
        if query in self.errors:
            body = {"status": "error", "errorType": "bad_data", "error": self.errors[query]}
            return web.json_response(body, status=400)
        data = self.results.get(query, empty)
        return web.json_response({"status": "success", "data": data})

    def _labels(self) -> web.Response:
        return web.json_response({"status": "success", "data": self.labels})

    def _label_values(self, name: str) -> web.Response:
        return web.json_response({"status": "success", "data": self.label_values.get(name, [])})

    @staticmethod
    def _series() -> web.Response:
        return web.json_response({"status": "success", "data": []})


class FakePrometheus(_FakeTool):
    version = "3.1.0"
    empty_instant: ClassVar[dict] = {"resultType": "vector", "result": []}
    empty_range: ClassVar[dict] = {"resultType": "matrix", "result": []}

    def route(
        self, request: web.Request, params: dict[str, list[str]], headers: dict[str, str]
    ) -> web.StreamResponse:
        path = request.path
        if path == "/api/v1/status/buildinfo":
            if self.mode == "no_buildinfo":
                return web.Response(status=404, text="404 page not found")
            return web.json_response({"status": "success", "data": {"version": self.version}})
        if path == "/api/v1/query":
            return self._query(params, self.empty_instant)
        if path == "/api/v1/query_range":
            return self._query(params, self.empty_range)
        if path == "/api/v1/labels":
            return self._labels()
        if match := _LABEL_VALUES.match(path):
            return self._label_values(match["name"])
        if path == "/api/v1/metadata":
            return web.json_response({"status": "success", "data": self.metadata})
        if path == "/api/v1/series":
            return self._series()
        return web.Response(status=404, text="404 page not found")


class FakeLoki(_FakeTool):
    version = "3.3.0"
    empty_instant: ClassVar[dict] = {"resultType": "streams", "result": []}
    empty_range: ClassVar[dict] = {"resultType": "streams", "result": []}

    def __init__(self) -> None:
        super().__init__()
        self.ruler = True

    def route(
        self, request: web.Request, params: dict[str, list[str]], headers: dict[str, str]
    ) -> web.StreamResponse:
        path = request.path
        if path == "/loki/api/v1/status/buildinfo":
            if self.mode == "no_buildinfo":
                return web.Response(status=404, text="404 page not found")
            return web.json_response({"version": self.version})
        if path == "/ready":
            return web.Response(text="ready")
        if path == "/loki/api/v1/query":
            return self._query(params, self.empty_instant)
        if path == "/loki/api/v1/query_range":
            return self._query(params, self.empty_range)
        if path == "/loki/api/v1/labels":
            return self._labels()
        if match := _LOKI_LABEL_VALUES.match(path):
            return self._label_values(match["name"])
        if path == "/loki/api/v1/series":
            return self._series()
        if path == "/loki/api/v1/rules":
            if self.ruler:
                return web.json_response({})
            return web.Response(status=404, text="ruler not enabled")
        return web.Response(status=404, text="404 page not found")


class FakeGrafana:
    def __init__(self) -> None:
        self.url = ""
        self.requests: list[FakeRequest] = []

    async def handle(self, request: web.Request) -> web.StreamResponse:
        params = {key: request.query.getall(key) for key in request.query}
        headers = dict(request.headers)
        self.requests.append(FakeRequest(request.method, request.path, params, headers))
        if request.path == "/api/health":
            return web.json_response({"database": "ok", "version": "11.3.0"})
        return web.Response(status=404, text="404 page not found")


_LABEL_VALUES = re.compile(r"^/api/v1/label/(?P<name>[^/]+)/values$")
_LOKI_LABEL_VALUES = re.compile(r"^/loki/api/v1/label/(?P<name>[^/]+)/values$")


@dataclass
class TlsMaterial:
    ca_pem: str
    server_cert_pem: str
    server_key_pem: str
    client_cert_pem: str
    client_key_pem: str


def _pem_key(key: ec.EllipticCurvePrivateKey) -> str:
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def _pem_cert(cert: x509.Certificate) -> str:
    return cert.public_bytes(serialization.Encoding.PEM).decode()


def make_tls_material() -> TlsMaterial:
    """A throwaway CA, a server certificate for 127.0.0.1 (IP SAN) and a client certificate."""
    now = datetime.datetime.now(datetime.UTC)

    def name(common: str) -> x509.Name:
        return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common)])

    def issue(subject: str, key, issuer: x509.Name, signer, *, ca=False, extra=()):
        builder = (
            x509.CertificateBuilder()
            .subject_name(name(subject))
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=30))
            .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        )
        for extension in extra:
            builder = builder.add_extension(extension, critical=False)
        return builder.sign(signer, hashes.SHA256())

    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca = issue("omnikrux fake CA", ca_key, name("omnikrux fake CA"), ca_key, ca=True)
    server_key = ec.generate_private_key(ec.SECP256R1())
    server = issue(
        "127.0.0.1",
        server_key,
        ca.subject,
        ca_key,
        extra=[
            x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]),
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),
        ],
    )
    client_key = ec.generate_private_key(ec.SECP256R1())
    client = issue(
        "omnikrux fake client",
        client_key,
        ca.subject,
        ca_key,
        extra=[x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH])],
    )
    return TlsMaterial(
        ca_pem=_pem_cert(ca),
        server_cert_pem=_pem_cert(server),
        server_key_pem=_pem_key(server_key),
        client_cert_pem=_pem_cert(client),
        client_key_pem=_pem_key(client_key),
    )


@contextmanager
def _server_ssl(tls: TlsMaterial, *, require_client_cert: bool):
    with tempfile.TemporaryDirectory() as folder:
        cert, key = Path(folder, "server.pem"), Path(folder, "server.key")
        cert.write_text(tls.server_cert_pem)
        key.write_text(tls.server_key_pem)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(str(cert), str(key))
        if require_client_cert:
            context.load_verify_locations(cadata=tls.ca_pem)
            context.verify_mode = ssl.CERT_REQUIRED
        yield context


@asynccontextmanager
async def _serve(server, tls: TlsMaterial | None, *, mtls: bool = False):
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", server.handle)
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    try:
        with ExitStack() as stack:
            context = (
                stack.enter_context(_server_ssl(tls, require_client_cert=mtls)) if tls else None
            )
            site = web.TCPSite(runner, "127.0.0.1", 0, ssl_context=context)
            await site.start()
            port = site._server.sockets[0].getsockname()[1]
            server.url = f"{'https' if tls else 'http'}://127.0.0.1:{port}"
            yield server
    finally:
        release = getattr(server, "release", None)
        if release is not None:
            release.set()
        await runner.cleanup()


@asynccontextmanager
async def serve_fake_prometheus(tls: TlsMaterial | None = None, *, mtls: bool = False):
    """A `FakePrometheus` on 127.0.0.1; HTTPS with `tls`, and a client certificate with `mtls`."""
    server = FakePrometheus()
    if mtls:
        server.require = ClientCert()
    async with _serve(server, tls, mtls=mtls):
        yield server


@asynccontextmanager
async def serve_fake_loki(tls: TlsMaterial | None = None, *, mtls: bool = False):
    server = FakeLoki()
    if mtls:
        server.require = ClientCert()
    async with _serve(server, tls, mtls=mtls):
        yield server


@asynccontextmanager
async def serve_fake_grafana():
    server = FakeGrafana()
    async with _serve(server, None):
        yield server
