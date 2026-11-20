"""The shared fake Prometheus, Loki and Grafana, and the fake Kubernetes API's service proxy."""

import ssl

import httpx
import pytest

from tests.fakekube import kubeconfig_for, service
from tests.monitoring.fakes import Basic, Bearer, ClientCert, Header, serve_fake_prometheus


async def test_fake_prometheus_answers_and_records(fake_prometheus):
    fake_prometheus.results["up"] = {
        "resultType": "vector",
        "result": [{"metric": {"job": "api"}, "value": [1, "1"]}],
    }
    fake_prometheus.errors["bad("] = "parse error: unexpected end of input"
    fake_prometheus.labels = ["job", "namespace"]
    fake_prometheus.label_values = {"job": ["api", "db"]}
    fake_prometheus.metadata = {"up": [{"type": "gauge", "help": "alive", "unit": ""}]}
    async with httpx.AsyncClient(base_url=fake_prometheus.url) as http:
        info = (await http.get("/api/v1/status/buildinfo")).json()
        assert info == {"status": "success", "data": {"version": "3.1.0"}}
        hit = (await http.get("/api/v1/query", params={"query": "up"})).json()
        assert hit["data"]["result"][0]["metric"] == {"job": "api"}
        posted = (await http.post("/api/v1/query", data={"query": "up"})).json()
        assert posted["data"] == hit["data"]
        unknown = (await http.get("/api/v1/query", params={"query": "nothing"})).json()
        assert unknown["data"] == {"resultType": "vector", "result": []}
        ranged = (await http.get("/api/v1/query_range", params={"query": "nothing"})).json()
        assert ranged["data"] == {"resultType": "matrix", "result": []}
        bad = await http.get("/api/v1/query", params={"query": "bad("})
        assert bad.status_code == 400
        assert bad.json() == {
            "status": "error",
            "errorType": "bad_data",
            "error": "parse error: unexpected end of input",
        }
        assert (await http.get("/api/v1/labels")).json()["data"] == ["job", "namespace"]
        assert (await http.get("/api/v1/label/job/values")).json()["data"] == ["api", "db"]
        assert (await http.get("/api/v1/label/zone/values")).json()["data"] == []
        assert (await http.get("/api/v1/metadata")).json()["data"] == fake_prometheus.metadata
        assert (await http.get("/api/v1/series", params={"match[]": "up"})).json()["data"] == []
    assert [r.path for r in fake_prometheus.requests][:2] == [
        "/api/v1/status/buildinfo",
        "/api/v1/query",
    ]
    assert fake_prometheus.requests[1].method == "GET"
    assert fake_prometheus.requests[1].params == {"query": ["up"]}
    assert fake_prometheus.requests[2].method == "POST"
    assert fake_prometheus.requests[2].params == {"query": ["up"]}


async def test_fake_modes(fake_prometheus):
    async with httpx.AsyncClient(base_url=fake_prometheus.url) as http:
        fake_prometheus.mode = "error500"
        assert (await http.get("/api/v1/status/buildinfo")).status_code == 500
        fake_prometheus.mode = "not_prometheus"
        page = await http.get("/api/v1/status/buildinfo")
        assert page.status_code == 200 and "<html" in page.text
        fake_prometheus.mode = "no_buildinfo"
        assert (await http.get("/api/v1/status/buildinfo")).status_code == 404
        assert (await http.get("/api/v1/labels")).status_code == 200


async def test_fake_loki_answers(fake_loki):
    fake_loki.results['{app="web"}'] = {"resultType": "streams", "result": [{"values": []}]}
    async with httpx.AsyncClient(base_url=fake_loki.url) as http:
        assert (await http.get("/loki/api/v1/status/buildinfo")).json()["version"] == "3.3.0"
        assert (await http.get("/ready")).text == "ready"
        got = (await http.get("/loki/api/v1/query_range", params={"query": '{app="web"}'})).json()
        assert got["data"]["result"] == [{"values": []}]
        assert (await http.get("/loki/api/v1/rules")).json() == {}
        fake_loki.ruler = False
        off = await http.get("/loki/api/v1/rules")
        assert off.status_code == 404 and off.text == "ruler not enabled"


async def test_fake_grafana_health(fake_grafana):
    async with httpx.AsyncClient(base_url=fake_grafana.url) as http:
        assert (await http.get("/api/health")).json() == {"database": "ok", "version": "11.3.0"}


@pytest.mark.parametrize(
    ("require", "good"),
    [
        (Basic("ana", "pw"), {"Authorization": "Basic YW5hOnB3"}),
        (Bearer("tok"), {"Authorization": "Bearer tok"}),
        (Header("X-Scope-OrgID", "tenant"), {"X-Scope-OrgID": "tenant"}),
    ],
)
async def test_fake_requires_configured_auth(fake_prometheus, require, good):
    fake_prometheus.require = require
    async with httpx.AsyncClient(base_url=fake_prometheus.url) as http:
        assert (await http.get("/api/v1/labels")).status_code == 401
        wrong = await http.get("/api/v1/labels", headers={"Authorization": "Nope"})
        assert wrong.status_code == 401
        assert (await http.get("/api/v1/labels", headers=good)).status_code == 200


async def test_fake_can_echo_auth_in_errors(fake_prometheus):
    fake_prometheus.require = Bearer("tok")
    fake_prometheus.echo_auth_in_errors = True
    async with httpx.AsyncClient(base_url=fake_prometheus.url) as http:
        bad = await http.get("/api/v1/labels", headers={"Authorization": "Bearer wrong"})
    assert bad.status_code == 401 and "Bearer wrong" in bad.text


def _client_context(tls, folder, *, with_cert: bool) -> ssl.SSLContext:
    context = ssl.create_default_context(cadata=tls.ca_pem)
    if with_cert:
        cert, key = folder / "client.pem", folder / "client.key"
        cert.write_text(tls.client_cert_pem)
        key.write_text(tls.client_key_pem)
        context.load_cert_chain(str(cert), str(key))
    return context


async def test_fake_mtls_rejects_a_client_without_cert(fake_prometheus_mtls, fake_tls, tmp_path):
    assert isinstance(fake_prometheus_mtls.require, ClientCert)
    bare = _client_context(fake_tls, tmp_path, with_cert=False)
    async with httpx.AsyncClient(base_url=fake_prometheus_mtls.url, verify=bare) as http:
        with pytest.raises(httpx.HTTPError):
            await http.get("/api/v1/labels")
    full = _client_context(fake_tls, tmp_path, with_cert=True)
    async with httpx.AsyncClient(base_url=fake_prometheus_mtls.url, verify=full) as http:
        assert (await http.get("/api/v1/labels")).status_code == 200


async def test_fake_tls_without_client_cert_requirement(fake_tls, tmp_path):
    trust = _client_context(fake_tls, tmp_path, with_cert=False)
    async with serve_fake_prometheus(fake_tls) as fake:
        assert fake.url.startswith("https://127.0.0.1:")
        async with httpx.AsyncClient(base_url=fake.url, verify=trust) as http:
            assert (await http.get("/api/v1/labels")).status_code == 200


async def test_service_proxy_relays_to_backend(fake_api, fake_prometheus):
    fake_api.service_backends[("monitoring", "prometheus-server:80")] = fake_prometheus.url
    path = "/api/v1/namespaces/monitoring/services/prometheus-server:80/proxy"
    async with httpx.AsyncClient(base_url=fake_api.url) as http:
        got = await http.get(f"{path}/api/v1/status/buildinfo")
        assert got.status_code == 200
        assert got.json()["data"]["version"] == "3.1.0"
        assert got.headers["content-type"].startswith("application/json")
        posted = await http.post(f"{path}/api/v1/query", data={"query": "up"})
        assert posted.status_code == 200
        await http.get(f"{path}/api/v1/query", params={"query": "up"})
    assert [(r.method, r.path) for r in fake_prometheus.requests] == [
        ("GET", "/api/v1/status/buildinfo"),
        ("POST", "/api/v1/query"),
        ("GET", "/api/v1/query"),
    ]
    assert fake_prometheus.requests[1].params == {"query": ["up"]}
    assert fake_prometheus.requests[2].params == {"query": ["up"]}


async def test_service_proxy_without_backend_is_503(fake_api):
    path = "/api/v1/namespaces/monitoring/services/nothing:80/proxy/ready"
    async with httpx.AsyncClient(base_url=fake_api.url) as http:
        got = await http.get(path)
    assert got.status_code == 503
    assert got.json()["message"] == 'no endpoints available for service "nothing:80"'


async def test_service_proxy_forbidden(fake_api):
    fake_api.proxy_forbidden = True
    path = "/api/v1/namespaces/monitoring/services/prom:80/proxy/ready"
    async with httpx.AsyncClient(base_url=fake_api.url) as http:
        got = await http.get(path)
    assert got.status_code == 403
    assert got.json()["message"] == (
        'services "prom:80" is forbidden: User "fake" cannot get resource "services/proxy" '
        'in API group "" in the namespace "monitoring"'
    )


def test_service_helper_does_not_share_labels():
    first = service("monitoring", "a", ports=[{"port": 80}])
    first["metadata"]["labels"]["x"] = "1"
    plain = service("monitoring", "c", ports=[{"port": 80}])
    assert plain["metadata"]["labels"] == {}
    labelled = service("monitoring", "b", ports=[{"port": 80}], labels={"app": "b"})
    assert labelled["metadata"]["labels"] == {"app": "b"}
    assert labelled["spec"]["clusterIP"] == "10.96.0.10"


async def test_kube_cluster_registers_the_fake_api(kube_cluster, monitoring_app, fake_api):
    _, app = monitoring_app
    assert kube_cluster in [c.id for c in await app.state.registry.list()]
    assert kubeconfig_for(fake_api)["clusters"][0]["cluster"]["server"] == fake_api.url
