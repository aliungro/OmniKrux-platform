"""How OmniKrux reaches a monitoring tool: directly by URL, or through a cluster's service proxy.

A transport sends one request and hands back the tool's answer, whatever its status; the connector
decides what an answer means. What stops a request from getting an answer at all (refused, timed
out, a bad certificate, rejected credentials, a redirect, an answer over the size cap, a cluster
that can't proxy) raises `SourceUnreachable` with words from `messages`.

Secrets never leave this module in an error: messages are built from the copy only, never from an
aiohttp error's text (it can carry the URL and its headers) or from a response body (a tool may
echo the `Authorization` header back). Every `SourceUnreachable` is raised `from None`, so a
printed traceback does not chain to the transport error either.
"""

import asyncio
import base64
import json
import os
import re
import shutil
import socket
import ssl
import tempfile
from collections.abc import AsyncIterator, Sequence
from contextlib import AsyncExitStack
from dataclasses import dataclass
from datetime import datetime
from typing import Literal, Protocol
from urllib.parse import unquote, urlencode, urlsplit

import aiohttp
from aiohttp.http_exceptions import HttpProcessingError
from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.clusters.registry import SOURCE_CLOUD, ClusterRegistry
from omnikrux.kube.connections import ClusterConnections, cloud_kube_error, kube_error_message
from omnikrux.kube.tokens import ClusterUnavailable
from omnikrux.monitoring.sources import messages
from omnikrux.monitoring.sources.messages import cluster_words
from omnikrux.monitoring.sources.types import SourceConfig

MAX_ANSWER_BYTES = 32 * 1024 * 1024

Method = Literal["GET", "POST", "DELETE"]
UnreachableCode = Literal[
    "unreachable",
    "timeout",
    "tls",
    "unauthorized",
    "redirect",
    "too_large",
    "no_endpoints",
    "forbidden",
    "unknown_cluster",
]

URL_RULE = "Use an http or https address with a host, like http://prometheus.example:9090."
URL_PARTS = (
    "The address can't contain a user name, password, query or fragment. "
    "Put credentials under Authentication."
)
HEADER_NAME_RULE = "A header name uses only letters, digits and !#$%&'*+-.^_`|~."
HEADER_VALUE_RULE = "A header value uses printable characters only, without line breaks."
RESERVED_HEADERS = frozenset({"host", "content-length", "connection", "transfer-encoding"})
_TOKEN = re.compile(r"^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$")
# What a Kubernetes namespace, service and port can be (DNS-1123 labels, or a port number).
_DNS_LABEL = re.compile(r"^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$")
_PORT = re.compile(r"^([0-9]{1,5}|[a-z0-9]([-a-z0-9]{0,13}[a-z0-9])?)$")
PATH_RULE = "A path prefix is a plain path like /prometheus, without . or .. parts."
FORM = "application/x-www-form-urlencoded"


@dataclass(frozen=True)
class TransportResponse:
    status: int
    body: bytes
    content_type: str


class SourceTransport(Protocol):
    async def request(
        self,
        method: Method,
        path: str,
        *,
        params: Sequence[tuple[str, str]] = (),
        form: Sequence[tuple[str, str]] | None = None,
        timeout: float,
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> TransportResponse:
        """`form` sends a form body; `body` sends those bytes as `content_type` instead (a rule
        group's YAML, a silence's JSON). Never both."""
        ...


class SourceUnreachable(Exception):
    """The request got no usable answer. `message` is safe to show, log and store. `status` is
    the tool's own 401 or 403 when the tool itself refused the credentials (None otherwise)."""

    def __init__(self, code: UnreachableCode, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.code: UnreachableCode = code
        self.message = message
        self.status = status

    def __repr__(self) -> str:
        return f"SourceUnreachable({self.code!r}, {self.message!r})"


def validate_url(url: str) -> str:
    """The URL of a source reached directly; ValueError with the copy when it can't be one."""
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
        raise ValueError(URL_RULE)
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 - raises ValueError for a port that isn't a number
    except ValueError:
        raise ValueError(URL_RULE) from None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ValueError(URL_RULE)
    if "@" in parts.netloc or "?" in url or "#" in url:
        raise ValueError(URL_PARTS)
    return url


def validate_header(name: str, value: str) -> None:
    """ValueError when a custom header can't be sent as given. Never repeats the value."""
    if not _TOKEN.match(name):
        raise ValueError(HEADER_NAME_RULE)
    if name.lower() in RESERVED_HEADERS:
        raise ValueError(f"OmniKrux sets the {name} header itself. Remove it.")
    if any((ord(c) < 32 and c != "\t") or 127 <= ord(c) < 160 or ord(c) > 255 for c in value):
        raise ValueError(HEADER_VALUE_RULE)


def safe_path(path: str) -> bool:
    """True for a path without dot segments (plain or percent-encoded), query, fragment,
    backslash, spaces or control characters. URL libraries resolve `..`, so a path that had one
    could leave the service proxy and reach any Kubernetes API path with the cluster's login."""
    if any(c in path for c in "?#\\") or any(ord(c) < 33 or ord(c) == 127 for c in path):
        return False
    return not any(
        segment in (".", "..") for text in (path, unquote(path)) for segment in text.split("/")
    )


def validate_path_prefix(path_prefix: str) -> str:
    """The prefix as `/prom` (or empty); ValueError with the copy when it isn't a plain path."""
    if not safe_path(path_prefix):
        raise ValueError(PATH_RULE)
    return _prefix(path_prefix)


def _prefix(path_prefix: str) -> str:
    """`/prom` for `prom`, `/prom/` or `/prom`; empty for none."""
    stripped = path_prefix.strip("/")
    return f"/{stripped}" if stripped else ""


def _seconds(timeout: float) -> str:
    return f"{timeout:g}"


async def _read_capped(chunks: AsyncIterator[bytes], name: str) -> bytes:
    body = bytearray()
    async for chunk in chunks:
        body += chunk
        if len(body) > MAX_ANSWER_BYTES:
            raise SourceUnreachable("too_large", messages.TOO_LARGE.format(name=name))
    return bytes(body)


def _tls_reason(error: BaseException | None) -> str:
    """The `ssl` error's own short words; nothing else from the exception."""
    if isinstance(error, ssl.SSLCertVerificationError) and error.verify_message:
        return str(error.verify_message)
    reason = getattr(error, "reason", None) if isinstance(error, ssl.SSLError) else None
    if isinstance(reason, str) and reason:
        return reason.replace("_", " ").lower()
    return "the handshake failed"


def _ssl_cause(exc: BaseException) -> ssl.SSLError | None:
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, ssl.SSLError):
            return current
        if isinstance(getattr(current, "os_error", None), ssl.SSLError):
            return current.os_error  # type: ignore[attr-defined]
        current = current.__cause__ or current.__context__
    return None


def _direct_failure(exc: BaseException, name: str, timeout: float) -> SourceUnreachable:
    """Map a transport error by type to the copy; never uses the error's own text."""
    if isinstance(exc, TimeoutError):  # includes aiohttp's ServerTimeoutError
        return SourceUnreachable(
            "timeout", messages.TIMEOUT.format(name=name, seconds=_seconds(timeout))
        )
    if isinstance(exc, aiohttp.ClientConnectorCertificateError):
        reason = _tls_reason(exc.certificate_error)
        return SourceUnreachable("tls", messages.TLS.format(name=name, reason=reason))
    if isinstance(exc, aiohttp.ClientSSLError) or _ssl_cause(exc) is not None:
        reason = _tls_reason(_ssl_cause(exc))
        return SourceUnreachable("tls", messages.TLS.format(name=name, reason=reason))
    if isinstance(exc, aiohttp.ClientConnectorDNSError) or (
        isinstance(exc, aiohttp.ClientConnectorError) and isinstance(exc.os_error, socket.gaierror)
    ):
        return SourceUnreachable("unreachable", messages.NO_HOST.format(name=name))
    if isinstance(exc, aiohttp.ClientConnectorError):
        return SourceUnreachable("unreachable", messages.REFUSED.format(name=name))
    return SourceUnreachable("unreachable", messages.DROPPED.format(name=name))


def _write_private(path: str, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


def build_ssl_context(config: SourceConfig) -> ssl.SSLContext:
    """The default trust store, plus the source's CA and client certificate when it has them.
    SourceUnreachable("tls") when either can't be read."""
    context = ssl.create_default_context()
    if config.ca_pem:
        try:
            context.load_verify_locations(cadata=config.ca_pem)
        except (ssl.SSLError, ValueError):
            reason = "the CA certificate can't be read"
            raise SourceUnreachable(
                "tls", messages.TLS.format(name=config.name, reason=reason)
            ) from None
    if config.auth_type == "mtls":
        cert, key = config.client_cert_pem, config.secrets.client_key_pem
        reason = "the client certificate or its key can't be read"
        if not cert or not key:
            raise SourceUnreachable("tls", messages.TLS.format(name=config.name, reason=reason))
        # `load_cert_chain` only reads files: a private folder that is gone right after.
        folder = tempfile.mkdtemp(prefix="omnikrux-mtls-")
        try:
            cert_path, key_path = os.path.join(folder, "client.pem"), os.path.join(folder, "key")
            _write_private(cert_path, cert)
            _write_private(key_path, key)
            try:
                context.load_cert_chain(cert_path, key_path)
            except (ssl.SSLError, ValueError, OSError):
                raise SourceUnreachable(
                    "tls", messages.TLS.format(name=config.name, reason=reason)
                ) from None
        finally:
            shutil.rmtree(folder, ignore_errors=True)
    return context


_SECRET_PATTERNS = (
    re.compile(r"(?i)authorization\s*[:=]\s*(?:(?:basic|bearer)\s+)?[^\s,;\"']+"),
    re.compile(r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=\-]{6,}"),
)


def scrub_text(text: str) -> str:
    """The text without anything that looks like an Authorization header or a bearer token."""
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("…", text)
    return text


def _scrub_body(body: bytes, config: SourceConfig, headers: dict[str, str]) -> bytes:
    """A tool's error body without the source's own secrets (a tool may echo the request back)."""
    secrets = config.secrets
    values = {v for v in (secrets.password, secrets.token, secrets.api_key) if v}
    values.update(v for v in headers.values() if v)
    values.update(v for v in secrets.headers.values() if v)
    for header in headers.values():  # "Bearer tok" and "Basic xyz": the credential part too
        scheme, _, credential = header.partition(" ")
        if credential and scheme.lower() in ("bearer", "basic"):
            values.add(credential)
    text = body.decode("utf-8", "replace")
    for value in sorted(values, key=len, reverse=True):
        text = text.replace(value, "…")
    return scrub_text(text).encode()


def _auth_headers(config: SourceConfig) -> dict[str, str]:
    """The authentication header, then the custom headers; SourceUnreachable when one can't be
    sent (the message never repeats a header value)."""
    headers: dict[str, str] = {}
    secrets = config.secrets
    if config.auth_type == "basic":
        pair = f"{config.username or ''}:{secrets.password or ''}".encode()
        headers["Authorization"] = "Basic " + base64.b64encode(pair).decode()
    elif config.auth_type == "bearer":
        headers["Authorization"] = f"Bearer {secrets.token or ''}"
    elif config.auth_type == "api_key" and config.header_name:
        headers[config.header_name] = secrets.api_key or ""
    headers.update(secrets.headers)
    for header, value in headers.items():
        try:
            validate_header(header, value)
        except ValueError:
            raise SourceUnreachable(
                "unreachable", messages.BAD_HEADER.format(name=config.name)
            ) from None
    return headers


class DirectTransport:
    """A source reached at its own URL."""

    def __init__(self, factory: "TransportFactory", config: SourceConfig) -> None:
        if not config.url:
            raise ValueError("A source reached directly needs a URL.")
        self._factory = factory
        self._config = config
        self._usable = safe_path(config.path_prefix)
        self._base = config.url.rstrip("/") + _prefix(config.path_prefix)

    async def request(
        self,
        method: Method,
        path: str,
        *,
        params: Sequence[tuple[str, str]] = (),
        form: Sequence[tuple[str, str]] | None = None,
        timeout: float,
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> TransportResponse:
        config = self._config
        name = config.name
        _check_path(path)
        if not self._usable:
            raise SourceUnreachable("unreachable", messages.BAD_ADDRESS.format(name=name))
        headers = _auth_headers(config)
        data = None
        if form is not None:
            data = urlencode(list(form)).encode()
            headers["Content-Type"] = FORM
        elif body is not None:
            data = body
            headers["Content-Type"] = content_type or "application/octet-stream"
        url = self._base + path
        is_https = urlsplit(url).scheme.lower() == "https"
        context = self._factory.ssl_context(config) if is_https else None
        session = self._factory.session()
        try:
            async with (
                asyncio.timeout(timeout),
                session.request(
                    method,
                    url,
                    params=list(params),
                    data=data,
                    headers=headers,
                    ssl=context if context is not None else True,
                    allow_redirects=False,
                    timeout=aiohttp.ClientTimeout(total=timeout),
                ) as response,
            ):
                status = response.status
                if 300 <= status < 400:
                    raise SourceUnreachable("redirect", messages.REDIRECT.format(name=name))
                if status in (401, 403):
                    raise SourceUnreachable(
                        "unauthorized",
                        messages.REJECTED.format(name=name, status=status),
                        status=status,
                    )
                body = await _read_capped(response.content.iter_any(), name)
                if status >= 400:
                    body = _scrub_body(body, config, headers)
                return TransportResponse(status, body, response.headers.get("Content-Type", ""))
        except SourceUnreachable:
            raise
        except (aiohttp.ClientError, HttpProcessingError, OSError, TimeoutError) as exc:
            raise _direct_failure(exc, name, timeout) from None


def _check_path(path: str) -> None:
    """The connector's own path: a programming error, not the user's, when it isn't plain."""
    if not path.startswith("/") or not safe_path(path):
        raise ValueError(f"Not a plain request path: {path!r}")


def _status(body: bytes) -> dict | None:
    """The Kubernetes Status in a body, or None (a tool's own answer)."""
    try:
        data = json.loads(body)
    except ValueError:
        return None
    if isinstance(data, dict) and data.get("kind") == "Status":
        return data
    return None


def _content_type(response: object) -> str:
    headers = getattr(response, "headers", None)
    if headers is None:  # the cloud client's wrapper keeps the aiohttp response inside
        headers = getattr(getattr(response, "_response", None), "headers", None)
    return headers.get("Content-Type", "") if headers is not None else ""


def _never_follow_redirects(api: ApiClient) -> None:
    """Make this client (fresh for one request, closed right after) send without following
    redirects. Its REST layer would otherwise follow a tool's 3xx, and a `Location` on the API
    server's own host keeps the cluster's login: a tool could make OmniKrux read any Kubernetes
    path. Other Kubernetes calls build their own clients and are unaffected."""
    session = api.rest_client.pool_manager
    send = session.request

    def request(method, url, **kwargs):
        kwargs["allow_redirects"] = False
        return send(method, url, **kwargs)

    session.request = request


class ClusterServiceTransport:
    """A source inside a known cluster, reached through the Kubernetes API's service proxy with
    the cluster's own connection. Cloud clusters word every failure with `cloud_kube_error`."""

    def __init__(
        self, connections: ClusterConnections, registry: ClusterRegistry, config: SourceConfig
    ) -> None:
        target = config.cluster
        if target is None:
            raise ValueError("A source reached through a cluster needs a cluster target.")
        self._connections = connections
        self._registry = registry
        self._config = config
        self._target = target
        self._usable = (
            all(_DNS_LABEL.match(part) for part in (target.namespace, target.service))
            and _PORT.match(target.port) is not None
            and safe_path(config.path_prefix)
        )
        # The proxy request carries the cluster's login, never the source's own credentials.
        self._unauthenticated = (
            config.auth_type == "none" and not config.header_names and not config.secrets.headers
        )
        service = f"{target.service}:{target.port}"
        if target.scheme == "https":
            service = f"https:{service}"
        self._base = (
            f"/api/v1/namespaces/{target.namespace}/services/{service}/proxy"
            f"{_prefix(config.path_prefix)}"
        )

    async def request(
        self,
        method: Method,
        path: str,
        *,
        params: Sequence[tuple[str, str]] = (),
        form: Sequence[tuple[str, str]] | None = None,
        timeout: float,
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> TransportResponse:
        name = self._config.name
        _check_path(path)
        if not self._usable:
            raise SourceUnreachable("unreachable", messages.BAD_ADDRESS.format(name=name))
        if not self._unauthenticated:
            raise SourceUnreachable("unreachable", messages.CLUSTER_AUTH.format(name=name))
        cluster_id = self._target.cluster_id
        try:
            info = await self._registry.get(cluster_id)
        except KeyError:
            raise SourceUnreachable(
                "unknown_cluster", messages.UNKNOWN_CLUSTER.format(name=name)
            ) from None
        cloud = info.source == SOURCE_CLOUD
        try:
            async with asyncio.timeout(timeout):
                return await self._send(
                    method, path, params, form, timeout, info.name, cloud, body, content_type
                )
        except SourceUnreachable:
            raise
        except TimeoutError as exc:
            message = (
                cloud_kube_error(f"reach {name}", exc=exc).message
                if cloud
                else messages.TIMEOUT.format(name=name, seconds=_seconds(timeout))
            )
            raise SourceUnreachable("timeout", message) from None
        except (
            ApiException,
            ClusterUnavailable,
            aiohttp.ClientError,
            HttpProcessingError,
            OSError,
        ) as exc:
            message = (
                cloud_kube_error(f"reach {name}", exc=exc).message
                if cloud
                else cluster_words(
                    exc,
                    info.name,
                    f"reach {name}",
                    unreachable=messages.SOURCE_CLUSTER_DOWN.format(cluster=info.name, name=name),
                )
            )
            raise SourceUnreachable("unreachable", message) from None

    async def _send(
        self,
        method: Method,
        path: str,
        params: Sequence[tuple[str, str]],
        form: Sequence[tuple[str, str]] | None,
        timeout: float,
        cluster: str,
        cloud: bool,
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> TransportResponse:
        name = self._config.name
        headers = {
            "Accept": "*/*",
            "Content-Type": FORM if form is not None else "application/json",
        }
        payload: object = None
        if form is None and body is not None:
            headers["Content-Type"] = content_type or "application/octet-stream"
            # The Kubernetes client serialises a JSON body itself; any other type goes as bytes.
            payload = json.loads(body) if "json" in headers["Content-Type"].lower() else body
        async with AsyncExitStack() as stack:
            try:
                api = await stack.enter_async_context(
                    self._connections.api(self._target.cluster_id)
                )
            except KeyError:  # the cluster went away between the lookup and the call
                raise SourceUnreachable(
                    "unknown_cluster", messages.UNKNOWN_CLUSTER.format(name=name)
                ) from None
            _never_follow_redirects(api)
            response = await api.call_api(
                self._base + path,
                method,
                query_params=list(params),
                header_params=headers,
                post_params=list(form) if form is not None else None,
                body=payload,
                auth_settings=["BearerToken"],
                _preload_content=False,
                _return_http_data_only=True,
                _request_timeout=timeout,
            )
            try:
                if getattr(response, "history", ()):  # a redirect was followed after all
                    raise SourceUnreachable("redirect", messages.REDIRECT.format(name=name))
                content = getattr(response, "content", None)
                if content is not None:
                    body = await _read_capped(content.iter_any(), name)
                else:  # the cloud client's error answer: already read, reduced and capped
                    body = await response.read()
                content_type = _content_type(response)
            finally:
                response.release()
        status = response.status
        if 200 <= status < 300:
            return TransportResponse(status, body, content_type)
        self._refuse(status, body, cluster, cloud)
        return TransportResponse(status, body, content_type)

    def _refuse(self, status: int, body: bytes, cluster: str, cloud: bool) -> None:
        """Raise for an answer that means the tool wasn't reached or refused the request."""
        name = self._config.name

        def raise_(code: UnreachableCode, message: str, tool_status: int | None = None) -> None:
            if cloud:
                # A cloud cluster's answers are worded by its own login rules, and its API
                # server's refusal can't be told from the tool's: never say the tool refused.
                message = cloud_kube_error(f"reach {name}", status=status).message
                tool_status = None
            raise SourceUnreachable(code, message, status=tool_status)

        if 300 <= status < 400:
            raise_("redirect", messages.REDIRECT.format(name=name))
        kube = _status(body)
        said = str((kube or {}).get("message") or "")
        if status == 503 and "no endpoints available" in said:
            raise_("no_endpoints", messages.NO_ENDPOINTS.format(name=name, cluster=cluster))
        if status == 403 and kube is not None and "services/proxy" in said:
            raise_("forbidden", messages.FORBIDDEN.format(name=name, cluster=cluster))
        if status in (401, 403) and kube is not None:
            # The API server itself refused the cluster's login.
            error = ApiException(status=status, reason="Refused")
            error.body = json.dumps(kube)
            raise_(
                "unauthorized" if status == 401 else "forbidden",
                kube_error_message(error, f"reach {name}"),
            )
        if status in (401, 403):  # the tool itself refused the request
            raise_("unauthorized", messages.REJECTED.format(name=name, status=status), status)


@dataclass
class _CachedContext:
    updated_at: datetime
    context: ssl.SSLContext


class TransportFactory:
    """Builds the transport for any `SourceConfig`, stored or not. One shared HTTP session
    without cookies or proxy settings from the environment; SSL contexts cached by the stored
    source's (id, updated_at). An unsaved config (id "") gets a fresh context on every call."""

    def __init__(self, connections: ClusterConnections, registry: ClusterRegistry) -> None:
        self._connections = connections
        self._registry = registry
        self._session: aiohttp.ClientSession | None = None
        self._contexts: dict[str, _CachedContext] = {}

    def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                cookie_jar=aiohttp.DummyCookieJar(), trust_env=False
            )
        return self._session

    def ssl_context(self, config: SourceConfig) -> ssl.SSLContext:
        if not config.id:
            return build_ssl_context(config)
        cached = self._contexts.get(config.id)
        if cached is not None and cached.updated_at == config.updated_at:
            return cached.context
        context = build_ssl_context(config)
        self._contexts[config.id] = _CachedContext(config.updated_at, context)
        return context

    def forget(self, source_id: str) -> None:
        """Drop a deleted source's SSL context."""
        self._contexts.pop(source_id, None)

    def for_source(self, config: SourceConfig) -> SourceTransport:
        if config.reach == "cluster":
            return ClusterServiceTransport(self._connections, self._registry, config)
        return DirectTransport(self, config)

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None
        self._contexts.clear()
