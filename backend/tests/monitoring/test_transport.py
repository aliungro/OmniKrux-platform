"""Reaching a monitoring tool: directly by URL, or through a cluster's service proxy."""

import base64
import json
import logging
import os
import socket
import tempfile
import traceback
from contextlib import asynccontextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest
from aiohttp import web

from omnikrux.kube.connections import ClusterConnections
from omnikrux.monitoring.sources import messages, transport
from omnikrux.monitoring.sources.transport import (
    SourceUnreachable,
    TransportFactory,
    validate_header,
    validate_url,
)
from omnikrux.monitoring.sources.types import ClusterTarget, SourceConfig, SourceSecrets
from tests.monitoring.fakes import Basic, Bearer, Header

NAME = "Prometheus · test"
BUILDINFO = "/api/v1/status/buildinfo"


def config(**over) -> SourceConfig:
    now = datetime.now(UTC)
    values = {
        "id": "src-1",
        "name": NAME,
        "type": "prometheus",
        "reach": "url",
        "url": "http://127.0.0.1:9",
        "cluster": None,
        "path_prefix": "",
        "auth_type": "none",
        "username": None,
        "header_name": None,
        "client_cert_pem": None,
        "ca_pem": None,
        "header_names": (),
        "secrets": SourceSecrets(),
        "created_by_project_id": None,
        "created_at": now,
        "updated_at": now,
        "check": None,
    }
    return SourceConfig(**(values | over))


def closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
async def factory(registry):
    made = TransportFactory(ClusterConnections(registry), registry)
    yield made
    await made.close()


@asynccontextmanager
async def serve(handler):
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", handler)
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        yield f"http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}"
    finally:
        await runner.cleanup()


AUTH_CASES = {
    "none": ({}, None, None),
    "basic": (
        {"auth_type": "basic", "username": "ana", "secrets": SourceSecrets(password="pw-1")},
        Basic("ana", "pw-1"),
        ("Authorization", "Basic " + base64.b64encode(b"ana:pw-1").decode()),
    ),
    "bearer": (
        {"auth_type": "bearer", "secrets": SourceSecrets(token="tok-1")},
        Bearer("tok-1"),
        ("Authorization", "Bearer tok-1"),
    ),
    "api_key": (
        {
            "auth_type": "api_key",
            "header_name": "X-Api-Key",
            "secrets": SourceSecrets(api_key="key-1"),
        },
        Header("X-Api-Key", "key-1"),
        ("X-Api-Key", "key-1"),
    ),
}


@pytest.mark.parametrize("auth", ["none", "basic", "bearer", "api_key"])
async def test_direct_transport_sends_each_auth_type(auth, factory, fake_prometheus):
    over, require, expected = AUTH_CASES[auth]
    fake_prometheus.require = require
    source = factory.for_source(config(url=fake_prometheus.url, **over))
    got = await source.request("GET", BUILDINFO, timeout=5)
    assert got.status == 200
    assert got.content_type.startswith("application/json")
    assert json.loads(got.body) == {"status": "success", "data": {"version": "3.1.0"}}
    headers = fake_prometheus.requests[-1].headers
    if expected is None:
        assert "Authorization" not in headers
    else:
        assert headers[expected[0]] == expected[1]


async def test_direct_transport_sends_a_client_certificate(factory, fake_prometheus_mtls, fake_tls):
    source = factory.for_source(
        config(
            url=fake_prometheus_mtls.url,
            auth_type="mtls",
            ca_pem=fake_tls.ca_pem,
            client_cert_pem=fake_tls.client_cert_pem,
            secrets=SourceSecrets(client_key_pem=fake_tls.client_key_pem),
        )
    )
    got = await source.request("GET", BUILDINFO, timeout=5)
    assert got.status == 200
    assert "Authorization" not in fake_prometheus_mtls.requests[-1].headers


async def test_direct_transport_without_credentials_is_rejected(factory, fake_prometheus):
    fake_prometheus.require = Bearer("tok-1")
    source = factory.for_source(config(url=fake_prometheus.url))
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", BUILDINFO, timeout=5)
    assert caught.value.code == "unauthorized"
    assert caught.value.message == messages.REJECTED.format(name=NAME, status=401)


async def test_custom_headers_are_sent(factory, fake_prometheus):
    fake_prometheus.require = Header("X-Scope-OrgID", "team-a")
    source = factory.for_source(
        config(
            url=fake_prometheus.url,
            header_names=("X-Scope-OrgID",),
            secrets=SourceSecrets(headers={"X-Scope-OrgID": "team-a"}),
        )
    )
    got = await source.request("POST", "/api/v1/query", form=[("query", "up")], timeout=5)
    assert got.status == 200
    seen = fake_prometheus.requests[-1]
    assert seen.method == "POST"
    assert seen.headers["X-Scope-OrgID"] == "team-a"
    assert seen.params == {"query": ["up"]}


async def test_path_prefix_and_params(factory, fake_prometheus):
    fake_prometheus.results["up"] = {"resultType": "vector", "result": []}
    source = factory.for_source(config(url=fake_prometheus.url + "/", path_prefix="/"))
    got = await source.request("GET", "/api/v1/query", params=[("query", "up")], timeout=5)
    assert got.status == 200
    assert fake_prometheus.requests[-1].path == "/api/v1/query"
    assert fake_prometheus.requests[-1].params == {"query": ["up"]}


async def test_non_2xx_answers_are_returned(factory, fake_prometheus):
    fake_prometheus.errors["bad("] = "parse error"
    source = factory.for_source(config(url=fake_prometheus.url))
    got = await source.request("GET", "/api/v1/query", params=[("query", "bad(")], timeout=5)
    assert got.status == 400
    assert b"parse error" in got.body


async def test_redirect_is_not_followed(factory, fake_prometheus):
    async def redirect(request: web.Request) -> web.Response:
        raise web.HTTPFound(fake_prometheus.url + request.path)

    async with serve(redirect) as url:
        source = factory.for_source(config(url=url))
        with pytest.raises(SourceUnreachable) as caught:
            await source.request("GET", BUILDINFO, timeout=5)
    assert caught.value.code == "redirect"
    assert caught.value.message == messages.REDIRECT.format(name=NAME)
    assert fake_prometheus.requests == []


async def test_refused_and_unknown_host_and_timeout(factory, fake_prometheus, monkeypatch):
    lookup = socket.getaddrinfo

    def no_such_host(host, *args, **kwargs):
        if host == "nowhere.invalid":
            raise socket.gaierror(socket.EAI_NONAME, "no such host")
        return lookup(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", no_such_host)
    refused = factory.for_source(config(url=f"http://127.0.0.1:{closed_port()}"))
    with pytest.raises(SourceUnreachable) as caught:
        await refused.request("GET", BUILDINFO, timeout=5)
    assert caught.value.code == "unreachable"
    assert caught.value.message == messages.REFUSED.format(name=NAME)

    nowhere = factory.for_source(config(url="http://nowhere.invalid:9090"))
    with pytest.raises(SourceUnreachable) as caught:
        await nowhere.request("GET", BUILDINFO, timeout=5)
    assert caught.value.code == "unreachable"
    assert caught.value.message == messages.NO_HOST.format(name=NAME)

    fake_prometheus.mode = "hang"
    slow = factory.for_source(config(url=fake_prometheus.url))
    with pytest.raises(SourceUnreachable) as caught:
        await slow.request("GET", BUILDINFO, timeout=0.3)
    assert caught.value.code == "timeout"
    assert caught.value.message == messages.TIMEOUT.format(name=NAME, seconds="0.3")


async def test_untrusted_certificate_is_a_tls_error(factory, fake_tls):
    from tests.monitoring.fakes import serve_fake_prometheus

    async with serve_fake_prometheus(fake_tls) as fake:
        source = factory.for_source(config(url=fake.url))
        with pytest.raises(SourceUnreachable) as caught:
            await source.request("GET", BUILDINFO, timeout=5)
        assert caught.value.code == "tls"
        assert caught.value.message.startswith(f"Can't open a secure connection to {NAME}: ")
        assert "certificate" in caught.value.message
        trusted = factory.for_source(config(id="", url=fake.url, ca_pem=fake_tls.ca_pem))
        assert (await trusted.request("GET", BUILDINFO, timeout=5)).status == 200


async def test_mtls_without_client_certificate_fails(factory, fake_prometheus_mtls, fake_tls):
    source = factory.for_source(config(url=fake_prometheus_mtls.url, ca_pem=fake_tls.ca_pem))
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", BUILDINFO, timeout=5)
    # TLS 1.3 reports the server's refusal after the handshake: depending on the platform it
    # arrives as an SSL alert (tls) or as a dropped connection (unreachable).
    exc = caught.value
    if exc.code == "tls":
        assert exc.message.startswith(f"Can't open a secure connection to {NAME}: ")
        assert exc.message.endswith(". Check the certificate settings.")
    else:
        assert (exc.code, exc.message) == ("unreachable", messages.DROPPED.format(name=NAME))


async def test_client_key_folder_is_gone_after_loading(factory, fake_tls, monkeypatch):
    made = []
    mkdtemp = tempfile.mkdtemp

    def recording(*args, **kwargs):
        made.append(mkdtemp(*args, **kwargs))
        return made[-1]

    monkeypatch.setattr(tempfile, "mkdtemp", recording)
    factory.ssl_context(
        config(
            url="https://127.0.0.1:9",
            auth_type="mtls",
            client_cert_pem=fake_tls.client_cert_pem,
            secrets=SourceSecrets(client_key_pem=fake_tls.client_key_pem),
        )
    )
    assert len(made) == 1
    assert not os.path.exists(made[0])


async def test_unreadable_client_key_is_a_tls_error(factory, fake_tls):
    source = factory.for_source(
        config(
            url="https://127.0.0.1:9",
            auth_type="mtls",
            client_cert_pem=fake_tls.client_cert_pem,
            secrets=SourceSecrets(client_key_pem="-----BEGIN PRIVATE KEY-----\nkey-SECRET-9\n"),
        )
    )
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", BUILDINFO, timeout=5)
    assert caught.value.code == "tls"
    assert "key-SECRET-9" not in caught.value.message


async def test_ssl_contexts_are_cached_only_for_stored_sources(factory, fake_tls):
    stored = config(url="https://127.0.0.1:9", ca_pem=fake_tls.ca_pem)
    first = factory.ssl_context(stored)
    assert factory.ssl_context(stored) is first
    edited = replace(stored, updated_at=stored.updated_at + timedelta(seconds=1))
    assert factory.ssl_context(edited) is not first
    transient = replace(stored, id="")
    assert factory.ssl_context(transient) is not factory.ssl_context(transient)


async def test_answer_over_the_cap_is_refused(factory, fake_prometheus, monkeypatch):
    monkeypatch.setattr(transport, "MAX_ANSWER_BYTES", 1024)
    fake_prometheus.labels = [f"label_{i:04}" for i in range(500)]
    source = factory.for_source(config(url=fake_prometheus.url))
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", "/api/v1/labels", timeout=5)
    assert caught.value.code == "too_large"
    assert caught.value.message == messages.TOO_LARGE.format(name=NAME)
    assert (await source.request("GET", BUILDINFO, timeout=5)).status == 200


async def test_errors_never_carry_secrets(factory, fake_prometheus, caplog):
    caplog.set_level(logging.DEBUG)
    secrets = SourceSecrets(token="tok-SECRET-2", headers={"X-Scope-OrgID": "hv-SECRET-3"})
    over = {"auth_type": "bearer", "header_names": ("X-Scope-OrgID",), "secrets": secrets}
    fake_prometheus.require = Bearer("another")
    fake_prometheus.echo_auth_in_errors = True
    failures = []
    for url, timeout in [
        (f"http://127.0.0.1:{closed_port()}", 5),
        (fake_prometheus.url, 5),
    ]:
        with pytest.raises(SourceUnreachable) as caught:
            await factory.for_source(config(url=url, **over)).request(
                "GET", BUILDINFO, timeout=timeout
            )
        failures.append(caught.value)
    fake_prometheus.mode = "hang"
    with pytest.raises(SourceUnreachable) as caught:
        await factory.for_source(config(url=fake_prometheus.url, **over)).request(
            "GET", BUILDINFO, timeout=0.3
        )
    failures.append(caught.value)
    assert [f.code for f in failures] == ["unreachable", "unauthorized", "timeout"]
    assert "tok-SECRET-2" in fake_prometheus.requests[0].headers["Authorization"]
    for exc in failures:
        printed = "".join(traceback.format_exception(exc))
        for text in (exc.message, str(exc), repr(exc), printed, caplog.text):
            assert "tok-SECRET-2" not in text
            assert "hv-SECRET-3" not in text


async def test_cluster_transport_goes_through_the_service_proxy(
    fake_api, fake_prometheus, kube_cluster, monitoring_app
):
    _, app = monitoring_app
    fake_api.service_backends[("monitoring", "prometheus-server:80")] = fake_prometheus.url
    target = ClusterTarget(kube_cluster, "monitoring", "prometheus-server", "80", "http")
    source = app.state.monitoring.transports.for_source(
        config(reach="cluster", url=None, cluster=target)
    )
    got = await source.request("GET", BUILDINFO, timeout=5)
    assert got.status == 200
    assert got.content_type.startswith("application/json")
    assert b"3.1.0" in got.body
    proxy = "/api/v1/namespaces/monitoring/services/prometheus-server:80/proxy"
    assert ("GET", proxy + BUILDINFO) in [(m, p) for m, p, _ in fake_api.requests]
    assert fake_prometheus.requests[-1].path == BUILDINFO

    posted = await source.request("POST", "/api/v1/query", form=[("query", "up")], timeout=5)
    assert posted.status == 200
    assert fake_prometheus.requests[-1].method == "POST"
    assert fake_prometheus.requests[-1].params == {"query": ["up"]}

    await source.request("GET", "/api/v1/labels", params=[("match[]", "up")], timeout=5)
    assert fake_prometheus.requests[-1].params == {"match[]": ["up"]}


async def test_cluster_transport_https_target_and_prefix(
    fake_api, fake_prometheus, kube_cluster, monitoring_app
):
    _, app = monitoring_app
    fake_api.service_backends[("monitoring", "https:prom:443")] = fake_prometheus.url
    target = ClusterTarget(kube_cluster, "monitoring", "prom", "443", "https")
    source = app.state.monitoring.transports.for_source(
        config(reach="cluster", url=None, cluster=target, path_prefix="/x/")
    )
    got = await source.request("GET", BUILDINFO, timeout=5)
    assert got.status == 404  # the fake serves nothing under /x
    paths = [p for _, p, _ in fake_api.requests]
    assert "/api/v1/namespaces/monitoring/services/https:prom:443/proxy/x" + BUILDINFO in paths


async def test_cluster_transport_words(fake_api, fake_prometheus, kube_cluster, monitoring_app):
    _, app = monitoring_app
    cluster = (await app.state.registry.get(kube_cluster)).name
    factory = app.state.monitoring.transports
    target = ClusterTarget(kube_cluster, "monitoring", "prometheus-server", "80", "http")
    source = factory.for_source(config(reach="cluster", url=None, cluster=target))

    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", BUILDINFO, timeout=5)
    assert caught.value.code == "no_endpoints"
    assert caught.value.message == messages.NO_ENDPOINTS.format(name=NAME, cluster=cluster)

    fake_api.proxy_forbidden = True
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", BUILDINFO, timeout=5)
    assert caught.value.code == "forbidden"
    assert caught.value.message == messages.FORBIDDEN.format(name=NAME, cluster=cluster)

    gone = replace(target, cluster_id="no-such-cluster")
    with pytest.raises(SourceUnreachable) as caught:
        await factory.for_source(config(reach="cluster", url=None, cluster=gone)).request(
            "GET", BUILDINFO, timeout=5
        )
    assert caught.value.code == "unknown_cluster"
    assert caught.value.message == messages.UNKNOWN_CLUSTER.format(name=NAME)


async def test_cluster_answer_over_the_cap_is_refused(
    fake_api, fake_prometheus, kube_cluster, monitoring_app, monkeypatch
):
    _, app = monitoring_app
    monkeypatch.setattr(transport, "MAX_ANSWER_BYTES", 1024)
    fake_prometheus.labels = [f"label_{i:04}" for i in range(500)]
    fake_api.service_backends[("monitoring", "prom:80")] = fake_prometheus.url
    target = ClusterTarget(kube_cluster, "monitoring", "prom", "80", "http")
    source = app.state.monitoring.transports.for_source(
        config(reach="cluster", url=None, cluster=target)
    )
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", "/api/v1/labels", timeout=5)
    assert caught.value.code == "too_large"


async def test_cloud_cluster_errors_keep_the_endpoint_private(cloud_cluster, monkeypatch):
    app, cluster, _ = cloud_cluster
    port = closed_port()
    registry = app.state.registry
    real = registry.get_kubeconfig

    async def unreachable(cluster_id: str) -> dict:
        kubeconfig = await real(cluster_id)
        for entry in kubeconfig["clusters"]:
            entry["cluster"]["server"] = f"https://127.0.0.1:{port}"
        return kubeconfig

    monkeypatch.setattr(registry, "get_kubeconfig", unreachable)
    target = ClusterTarget(cluster.id, "monitoring", "prom", "80", "http")
    source = app.state.monitoring.transports.for_source(
        config(reach="cluster", url=None, cluster=target)
    )
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", BUILDINFO, timeout=5)
    exc = caught.value
    assert exc.code == "unreachable"
    printed = "".join(traceback.format_exception(exc))
    for text in (exc.message, str(exc), repr(exc), printed):
        assert "127.0.0.1" not in text
        assert str(port) not in text


async def test_cloud_cluster_proxy_refusals_use_cloud_wording(cloud_cluster, fake_api):
    app, cluster, _ = cloud_cluster
    target = ClusterTarget(cluster.id, "monitoring", "prom", "80", "http")
    source = app.state.monitoring.transports.for_source(
        config(reach="cluster", url=None, cluster=target)
    )
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", BUILDINFO, timeout=5)
    assert caught.value.code == "no_endpoints"
    assert caught.value.message == (
        f"The cluster returned HTTP 503 while trying to reach {NAME}. Try again later."
    )
    assert fake_api.url.rsplit(":", 1)[1] not in caught.value.message


def test_url_validation():
    assert validate_url("http://p:9090/prom") == "http://p:9090/prom"
    assert validate_url("https://prometheus.example") == "https://prometheus.example"
    for bad in ["ftp://p", "http://u:p@h", "http://h/?a=1", "http://h/#x", "p:9090"]:
        with pytest.raises(ValueError):
            validate_url(bad)
    with pytest.raises(ValueError, match="Use an http or https address"):
        validate_url("p:9090")
    with pytest.raises(ValueError, match="Put credentials under Authentication"):
        validate_url("http://u:p@h")


def test_header_validation():
    validate_header("X-Scope-OrgID", "team-a")
    for name in ["Host", "content-length", "Connection", "Transfer-Encoding", "Bad Name", ""]:
        with pytest.raises(ValueError):
            validate_header(name, "x")
    for value in ["a\r\nX-Evil: 1", "a\nb"]:
        with pytest.raises(ValueError) as caught:
            validate_header("X-Ok", value)
        assert value not in str(caught.value)


@pytest.mark.parametrize(
    "over",
    [
        {"path_prefix": "/../../../../api/v1/namespaces/kube-system/secrets"},
        {"path_prefix": "/%2e%2e/%2E%2E/secrets"},
        {"namespace": "kube-system/secrets/.."},
        {"service": "prom/../../secrets"},
        {"port": "80/../../x"},
    ],
)
async def test_cluster_transport_never_leaves_the_service_proxy(
    over, fake_api, kube_cluster, monitoring_app
):
    _, app = monitoring_app
    prefix = over.pop("path_prefix", "")
    target = replace(ClusterTarget(kube_cluster, "monitoring", "prom", "80", "http"), **over)
    source = app.state.monitoring.transports.for_source(
        config(reach="cluster", url=None, cluster=target, path_prefix=prefix)
    )
    before = len(fake_api.requests)
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", BUILDINFO, timeout=5)
    assert caught.value.code == "unreachable"
    assert caught.value.message == messages.BAD_ADDRESS.format(name=NAME)
    assert len(fake_api.requests) == before


async def test_a_connector_path_that_is_not_plain_is_a_programming_error(
    fake_api, kube_cluster, monitoring_app
):
    _, app = monitoring_app
    target = ClusterTarget(kube_cluster, "monitoring", "prom", "80", "http")
    source = app.state.monitoring.transports.for_source(
        config(reach="cluster", url=None, cluster=target)
    )
    before = len(fake_api.requests)
    for path in ["/../../secrets", "api/v1/query", "/api/v1/query?x=1"]:
        with pytest.raises(ValueError):
            await source.request("GET", path, timeout=5)
    assert len(fake_api.requests) == before


@pytest.mark.parametrize(
    ("method", "status"), [("GET", 302), ("POST", 307), ("GET", 301), ("POST", 308)]
)
async def test_cluster_transport_never_follows_a_redirect(
    method, status, fake_api, kube_cluster, monitoring_app
):
    """A tool behind the proxy must not steer the cluster's login to another API path."""
    _, app = monitoring_app
    secrets = "/api/v1/namespaces/kube-system/secrets"

    async def redirect(request: web.Request) -> web.Response:
        return web.Response(status=status, headers={"Location": fake_api.url + secrets})

    async with serve(redirect) as url:
        fake_api.service_backends[("monitoring", "prom:80")] = url
        target = ClusterTarget(kube_cluster, "monitoring", "prom", "80", "http")
        source = app.state.monitoring.transports.for_source(
            config(reach="cluster", url=None, cluster=target)
        )
        form = [("query", "up")] if method == "POST" else None
        with pytest.raises(SourceUnreachable) as caught:
            await source.request(method, "/api/v1/query", form=form, timeout=5)
    assert caught.value.code == "redirect"
    assert caught.value.message == messages.REDIRECT.format(name=NAME)
    assert [p for _, p, _ in fake_api.requests if p.startswith(secrets)] == []


@pytest.mark.parametrize(
    "over",
    [
        {"auth_type": "bearer", "secrets": SourceSecrets(token="tok-1")},
        {"auth_type": "basic", "username": "ana", "secrets": SourceSecrets(password="pw")},
        {
            "header_names": ("X-Scope-OrgID",),
            "secrets": SourceSecrets(headers={"X-Scope-OrgID": "a"}),
        },
    ],
)
async def test_cluster_sources_take_no_authentication_or_headers(
    over, fake_api, fake_prometheus, kube_cluster, monitoring_app
):
    _, app = monitoring_app
    fake_api.service_backends[("monitoring", "prom:80")] = fake_prometheus.url
    target = ClusterTarget(kube_cluster, "monitoring", "prom", "80", "http")
    source = app.state.monitoring.transports.for_source(
        config(reach="cluster", url=None, cluster=target, **over)
    )
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", BUILDINFO, timeout=5)
    assert caught.value.code == "unreachable"
    assert caught.value.message == messages.CLUSTER_AUTH.format(name=NAME)
    assert fake_prometheus.requests == []


def test_path_prefix_validation():
    assert transport.validate_path_prefix("prom/") == "/prom"
    assert transport.validate_path_prefix("") == ""
    for bad in ["/a/../b", "/%2e%2e", "/a?b", "/a b", "/a#b"]:
        with pytest.raises(ValueError):
            transport.validate_path_prefix(bad)


def test_header_values_must_be_printable():
    validate_header("X-Ok", "caf\u00e9 tab\tok")
    for value in ["bell\u0007", "snow\u2603"]:
        with pytest.raises(ValueError):
            validate_header("X-Ok", value)


async def test_a_followed_redirect_is_still_refused(
    fake_api, fake_prometheus, kube_cluster, monitoring_app, monkeypatch
):
    """Defence in depth: should a redirect be followed anyway, its answer is never handed on."""
    _, app = monitoring_app
    monkeypatch.setattr(transport, "_never_follow_redirects", lambda api: None)

    async def redirect(request: web.Request) -> web.Response:
        return web.Response(status=302, headers={"Location": fake_prometheus.url + BUILDINFO})

    async with serve(redirect) as url:
        fake_api.service_backends[("monitoring", "prom:80")] = url
        target = ClusterTarget(kube_cluster, "monitoring", "prom", "80", "http")
        source = app.state.monitoring.transports.for_source(
            config(reach="cluster", url=None, cluster=target)
        )
        with pytest.raises(SourceUnreachable) as caught:
            await source.request("GET", "/api/v1/query", timeout=5)
    assert caught.value.code == "redirect"
    assert [r.path for r in fake_prometheus.requests] == [BUILDINFO]  # followed, then refused


async def test_a_down_cluster_is_said_without_the_socket_error(
    fake_api, kube_cluster, monitoring_app, monkeypatch
):
    _, app = monitoring_app
    port = closed_port()
    registry = app.state.registry
    real = registry.get_kubeconfig

    async def unreachable(cluster_id: str) -> dict:
        kubeconfig = await real(cluster_id)
        for entry in kubeconfig["clusters"]:
            entry["cluster"]["server"] = f"http://127.0.0.1:{port}"
        return kubeconfig

    monkeypatch.setattr(registry, "get_kubeconfig", unreachable)
    target = ClusterTarget(kube_cluster, "monitoring", "prom", "80", "http")
    source = app.state.monitoring.transports.for_source(
        config(reach="cluster", url=None, cluster=target)
    )
    with pytest.raises(SourceUnreachable) as caught:
        await source.request("GET", BUILDINFO, timeout=5)
    info = await registry.get(kube_cluster)
    assert caught.value.message == messages.SOURCE_CLUSTER_DOWN.format(cluster=info.name, name=NAME)
    assert "Errno" not in caught.value.message and str(port) not in caught.value.message
