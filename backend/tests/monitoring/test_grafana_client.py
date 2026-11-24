"""The Grafana client: health, dashboards, data sources and alert rules read through M1's
transports, by address with a sign-in or through a cluster's service proxy without one. Failures
are plain words chosen by type and status, never a response body or a secret."""

import logging
import socket
from dataclasses import replace
from datetime import UTC, datetime

import pytest

from omnikrux.monitoring.sources import messages
from omnikrux.monitoring.sources.transport import ClusterServiceTransport, SourceUnreachable
from omnikrux.monitoring.sources.types import ClusterTarget
from omnikrux.monitoring.transfer.grafana.datasources import GrafanaDatasource
from omnikrux.monitoring.transfer.grafana_client import (
    DASHBOARD_REFUSED,
    NO_DASHBOARD,
    NOT_GRAFANA,
    RULES_FAILED,
    RULES_FORBIDDEN,
    SECRETS_UNREADABLE,
    SIGN_IN_CLUSTER,
    SIGN_IN_URL,
    GrafanaError,
    transport_config,
)
from omnikrux.monitoring.transfer.grafana_store import GrafanaConfig, GrafanaSecrets
from tests.monitoring.conftest import GRAFANA_TOKEN
from tests.monitoring.fakes import Basic, grafana_answer

NAME = "Grafana · test"
MOMENT = datetime(2026, 11, 24, tzinfo=UTC)


def config(url: str | None = None, **over) -> GrafanaConfig:
    values = {
        "id": "g-1",
        "name": NAME,
        "reach": "url",
        "url": url,
        "cluster": None,
        "path_prefix": "",
        "auth_type": "none",
        "username": None,
        "secrets": GrafanaSecrets(),
        "created_at": MOMENT,
        "updated_at": MOMENT,
    }
    return GrafanaConfig(**(values | over))


def bearer(url: str, token: str = GRAFANA_TOKEN) -> GrafanaConfig:
    return config(url, auth_type="bearer", secrets=GrafanaSecrets(token=token))


@pytest.fixture
def client(monitoring_app):
    _, app = monitoring_app
    return app.state.monitoring.grafana_client


def closed_port_url() -> str:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return f"http://127.0.0.1:{s.getsockname()[1]}"


def test_transport_config_keeps_its_own_cache_key_and_only_the_sign_in_used():
    basic = config(
        "http://g.example",
        auth_type="basic",
        username="ana",
        secrets=GrafanaSecrets(password="pw", token="stale"),
    )
    got = transport_config(basic)
    assert (got.id, got.reach, got.url, got.auth_type) == ("grafana:g-1", "url", basic.url, "basic")
    assert (got.username, got.secrets.password, got.secrets.token) == ("ana", "pw", None)
    unsaved = transport_config(replace(bearer("http://g.example"), id=""))
    assert (unsaved.id, unsaved.secrets.token, unsaved.username) == ("", GRAFANA_TOKEN, None)
    assert unsaved.header_names == () and unsaved.secrets.headers == {}
    assert GRAFANA_TOKEN not in repr(unsaved)


async def test_health_reads_the_version(client, fake_grafana):
    health = await client.health(config(fake_grafana.url))
    assert (health.ok, health.version, health.message) == (True, "11.3.0", None)
    assert [r.path for r in fake_grafana.requests] == ["/api/health"]


async def test_not_grafana_is_said_plainly_by_every_read(client, fake_grafana):
    fake_grafana.mode = "not_grafana"
    cfg = config(fake_grafana.url)
    health = await client.health(cfg)
    assert (health.ok, health.message) == (False, NOT_GRAFANA.format(name=NAME))
    for read in (client.search(cfg), client.dashboard(cfg, "x"), client.datasources(cfg)):
        with pytest.raises(GrafanaError) as caught:
            await read
        assert (caught.value.status, caught.value.message) == (502, NOT_GRAFANA.format(name=NAME))


async def test_search_sorts_by_folder_then_title_and_keeps_tags(client, fake_grafana_auth):
    found = await client.search(bearer(fake_grafana_auth.url))
    assert [(i.folder, i.title) for i in found.items] == [
        (None, "Overview"),
        ("Platform", "api"),
        ("Platform", "Nodes"),
    ]
    assert found.items[2].tags == ["k8s"] and found.truncated is False
    [request] = fake_grafana_auth.requests
    assert request.params == {"type": ["dash-db"], "limit": ["5000"], "page": ["1"]}
    assert request.headers["Authorization"] == f"Bearer {GRAFANA_TOKEN}"


async def test_search_marks_truncation(client, fake_grafana):
    fake_grafana.dashboards = {
        f"d{n}": grafana_answer(f"d{n}", f"Dashboard {n}") for n in range(5001)
    }
    found = await client.search(config(fake_grafana.url))
    assert len(found.items) == 5000 and found.truncated is True
    del fake_grafana.dashboards["d0"], fake_grafana.dashboards["d1"]
    assert (await client.search(config(fake_grafana.url))).truncated is False


async def test_dashboard_reads_its_version_and_folder(client, fake_grafana):
    fake_grafana.dashboards = {
        "api": grafana_answer("api", "API", folder="Platform", version=7),
        "root": {"dashboard": {"title": "Root"}, "meta": {"folderTitle": "General", "version": 3}},
    }
    doc = await client.dashboard(config(fake_grafana.url), "api")
    assert (doc.raw["title"], doc.version, doc.folder) == ("API", 7, "Platform")
    root = await client.dashboard(config(fake_grafana.url), "root")
    assert (root.version, root.folder) == (3, None)


async def test_a_missing_or_refused_dashboard_is_that_dashboards_problem(client, fake_grafana):
    cfg = config(fake_grafana.url)
    with pytest.raises(GrafanaError) as gone:
        await client.dashboard(cfg, "nope")
    assert (gone.value.status, gone.value.message) == (
        404,
        NO_DASHBOARD.format(name=NAME, uid="nope"),
    )
    fake_grafana.dashboard_status["v2"] = 406  # Grafana 13 with a dashboard in the v2 schema
    with pytest.raises(GrafanaError) as refused:
        await client.dashboard(cfg, "v2")
    assert (refused.value.status, refused.value.message) == (
        502,
        DASHBOARD_REFUSED.format(name=NAME, uid="v2", status=406),
    )
    asked = len(fake_grafana.requests)
    for uid in ("../api/admin", "a/b", "..", ""):
        with pytest.raises(GrafanaError) as odd:
            await client.dashboard(cfg, uid)
        assert odd.value.status == 404
    assert len(fake_grafana.requests) == asked  # an odd uid is never sent


async def test_client_reads_datasources_and_rules_when_allowed(client, fake_grafana):
    cfg = config(fake_grafana.url)
    fake_grafana.datasources = [
        {
            "uid": "prom",
            "name": "Prometheus",
            "type": "prometheus",
            "url": "http://p:9090",
            "isDefault": True,
        },
        {"uid": "logs", "name": "Logs", "type": "loki", "url": ""},
        {"name": "no uid"},
    ]
    assert await client.datasources(cfg) == (
        GrafanaDatasource("prom", "Prometheus", "prometheus", "http://p:9090", True),
        GrafanaDatasource("logs", "Logs", "loki", None, False),
    )
    fake_grafana.datasources = None  # 403: a viewer's token
    assert await client.datasources(cfg) is None

    assert await client.alert_rules(cfg, "api") == ((), None)  # no ruler: 404
    r1 = {"grafana_alert": {"title": "High"}, "annotations": {"__dashboardUid__": "api"}}
    r2 = {"grafana_alert": {"title": "Low"}}
    fake_grafana.ruler = {"Folder": [{"name": "g", "rules": [r1, r2]}, "odd"], "Other": "odd"}
    assert await client.alert_rules(cfg, "api") == ((r1, r2), None)
    assert fake_grafana.requests[-1].params == {"dashboard_uid": ["api"]}
    fake_grafana.ruler_status = 403
    assert await client.alert_rules(cfg, "api") == (
        None,
        RULES_FORBIDDEN.format(name=NAME, status=403),
    )
    fake_grafana.ruler_status = 500
    assert await client.alert_rules(cfg, "api") == (None, RULES_FAILED.format(name=NAME))


async def test_context_reads_the_dashboard_and_what_is_around_it(client, fake_grafana):
    fake_grafana.dashboards = {"api": grafana_answer("api", "API", version=4)}
    fake_grafana.datasources = None
    rule = {"grafana_alert": {"title": "High"}}
    fake_grafana.ruler = {"F": [{"name": "g", "rules": [rule]}]}
    doc, ctx = await client.context(config(fake_grafana.url), "api")
    assert (doc.raw["title"], doc.version) == ("API", 4)
    assert (ctx.datasources, ctx.alert_rules, ctx.alert_rules_note) == ((), (rule,), None)


async def test_a_rejected_sign_in_names_its_status(client, fake_grafana_auth):
    wrong = bearer(fake_grafana_auth.url, "glsa_wrong")
    for read in (client.search(wrong), client.dashboard(wrong, "api")):
        with pytest.raises(GrafanaError) as caught:
            await read
        assert caught.value.message == SIGN_IN_URL.format(name=NAME, status=401)
    assert await client.datasources(wrong) is None
    assert await client.alert_rules(wrong, "api") == (
        None,
        RULES_FORBIDDEN.format(name=NAME, status=401),
    )


async def test_basic_sign_in_is_sent(client, fake_grafana):
    fake_grafana.require = Basic("ana", "pw-basic")
    fake_grafana.dashboards = {"api": grafana_answer("api", "API")}
    cfg = config(
        fake_grafana.url,
        auth_type="basic",
        username="ana",
        secrets=GrafanaSecrets(password="pw-basic"),
    )
    assert [i.uid for i in (await client.search(cfg)).items] == ["api"]


async def test_unreadable_secrets_are_said_before_any_request(client, fake_grafana_auth):
    cfg = replace(bearer(fake_grafana_auth.url), secrets_unreadable=True)
    with pytest.raises(GrafanaError) as caught:
        await client.search(cfg)
    assert caught.value.message == SECRETS_UNREADABLE.format(name=NAME)
    health = await client.health(cfg)
    assert (health.ok, health.message) == (False, SECRETS_UNREADABLE.format(name=NAME))
    assert fake_grafana_auth.requests == []


async def test_an_unreachable_grafana_uses_the_transport_words(client, caplog):
    caplog.set_level(logging.DEBUG)
    cfg = bearer(closed_port_url(), "glsa_SECRET-13")
    health = await client.health(cfg)
    assert (health.ok, health.message) == (False, messages.REFUSED.format(name=NAME))
    with pytest.raises(GrafanaError) as caught:
        await client.search(cfg)
    assert (caught.value.status, caught.value.message) == (502, messages.REFUSED.format(name=NAME))
    assert caught.value.__cause__ is None and caught.value.__suppress_context__
    assert "glsa_SECRET-13" not in repr(caught.value) + caplog.text


async def test_a_cluster_grafana_is_read_without_a_sign_in(
    fake_api, fake_grafana, kube_cluster, client
):
    fake_api.service_backends[("monitoring", "grafana:80")] = fake_grafana.url
    fake_grafana.dashboards = {"api": grafana_answer("api", "API")}
    cfg = config(
        None,
        reach="cluster",
        cluster=ClusterTarget(kube_cluster, "monitoring", "grafana", "80", "http"),
    )
    assert (await client.health(cfg)).version == "11.3.0"
    assert [i.uid for i in (await client.search(cfg)).items] == ["api"]
    assert all("Authorization" not in r.headers for r in fake_grafana.requests)
    fake_grafana.require = Basic("admin", "admin")
    with pytest.raises(GrafanaError) as caught:
        await client.search(cfg)
    assert caught.value.message == SIGN_IN_CLUSTER.format(name=NAME)


async def test_the_transports_say_which_status_refused_the_credentials(direct, fake_grafana_auth):
    with pytest.raises(SourceUnreachable) as caught:
        await direct(fake_grafana_auth.url).request("GET", "/api/search", timeout=5)
    assert (caught.value.code, caught.value.status) == ("unauthorized", 401)
    assert repr(caught.value) == (
        f"SourceUnreachable('unauthorized', {caught.value.message!r})"
    )  # unchanged
    assert SourceUnreachable("timeout", "x").status is None


async def test_error_bodies_that_echo_the_token_never_reach_a_message(
    client, fake_grafana_auth, caplog
):
    caplog.set_level(logging.DEBUG)
    fake_grafana_auth.echo_auth_in_errors = True
    fake_grafana_auth.dashboard_status["api"] = 500
    fake_grafana_auth.ruler_status = 500
    cfg = bearer(fake_grafana_auth.url)
    with pytest.raises(GrafanaError) as caught:
        await client.context(cfg, "api")
    notes = await client.alert_rules(cfg, "api")
    with pytest.raises(GrafanaError) as gone:
        await client.dashboard(cfg, "missing")
    said = [repr(caught.value), str(caught.value), repr(notes), repr(gone.value), caplog.text]
    assert all(GRAFANA_TOKEN not in text for text in said)
    assert caught.value.message == DASHBOARD_REFUSED.format(name=NAME, uid="api", status=500)


def test_only_the_tools_own_refusal_carries_a_status_and_never_on_a_cloud_cluster():
    cfg = transport_config(
        config(
            None,
            reach="cluster",
            cluster=ClusterTarget("c1", "monitoring", "grafana", "80", "http"),
        )
    )
    transport = ClusterServiceTransport(None, None, cfg)  # _refuse reads neither
    tool = b'{"message": "invalid API key"}'
    kube = b'{"kind": "Status", "message": "Unauthorized", "code": 401}'
    cases = [(tool, False, 401), (tool, True, None), (kube, False, None), (kube, True, None)]
    for body, cloud, status in cases:
        with pytest.raises(SourceUnreachable) as caught:
            transport._refuse(401, body, "prod", cloud)
        assert (caught.value.code, caught.value.status) == ("unauthorized", status), (body, cloud)
    with pytest.raises(SourceUnreachable) as on_cloud:
        transport._refuse(403, tool, "prod", True)
    assert on_cloud.value.message != messages.REJECTED.format(name=NAME, status=403)
