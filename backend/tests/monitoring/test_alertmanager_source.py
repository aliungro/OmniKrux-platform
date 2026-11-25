"""Alertmanager as a source: tested, found, and never queried."""

from omnikrux.monitoring.query.run import NO_FILTER_RULE
from omnikrux.monitoring.sources.alertmanager import AlertmanagerConnector
from omnikrux.monitoring.sources.connector import SourceCatalog
from omnikrux.monitoring.sources.transport import TransportResponse
from tests.fakekube import service
from tests.monitoring.test_discovery import BASE, by_type, seed, tcp

QUERY = "/api/monitoring/query"


def error(response) -> tuple[int, str, str]:
    detail = response.json()["detail"]
    return response.status_code, detail["code"], detail["message"]


async def test_alertmanager_test_reports_version(fake_alertmanager, direct):
    t = direct(fake_alertmanager.url, type="alertmanager", name="Alerts")
    result = await AlertmanagerConnector().test(t, "Alerts")
    assert (result.ok, result.version, result.message) == (True, "0.27.0", None)


async def test_alertmanager_test_refuses_something_else(fake_prometheus, direct):
    t = direct(fake_prometheus.url, type="alertmanager", name="Alerts")
    result = await AlertmanagerConnector().test(t, "Alerts")
    assert result.ok is False
    assert result.message == (
        "Alerts answered, but not as an Alertmanager API (HTTP 404). Check the address and the type."
    )
    assert result.answered is True


class _Answers:
    """A transport that answers every request with a 200 and this body."""

    def __init__(self, body: bytes) -> None:
        self.body = body

    async def request(self, method, path, **kwargs):
        return TransportResponse(200, self.body, "application/json")


async def test_alertmanager_test_refuses_json_that_is_not_an_alertmanager():
    for body in (b'{"status": "success"}', b"not json", b'{"versionInfo": {}}'):
        result = await AlertmanagerConnector().test(_Answers(body), "Alerts")
        assert (result.ok, result.message) == (
            False,
            "Alerts answered, but not like an Alertmanager. Check the address and its path.",
        )


async def _alertmanager_source(http, url: str, name: str = "Alerts") -> str:
    r = await http.post(
        "/api/monitoring/sources",
        json={"type": "alertmanager", "reach": "url", "url": url, "name": name},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_alertmanager_cannot_be_queried(monitoring_app, fake_alertmanager, linked_project):
    http, _ = monitoring_app
    source_id = await _alertmanager_source(http, fake_alertmanager.url)
    body = {"source_id": source_id, "kind": "instant", "query": "up", "time": 1700000000}
    r = await http.post(QUERY, json=body)
    assert error(r) == (
        400,
        "bad_query",
        "Alerts is an Alertmanager: it holds alerts and silences, not metrics or logs.",
    )
    link = await http.put(
        f"/api/monitoring/projects/{linked_project.project_id}/sources/{source_id}",
        json={"filter": 'cluster="a"'},
    )
    assert link.status_code == 200, link.text
    r = await http.post(QUERY, json=body | {"project_id": linked_project.project_id})
    assert error(r) == (400, "bad_request", NO_FILTER_RULE)
    assert not [q for q in fake_alertmanager.requests if q.path != "/api/v2/status"]


async def test_discovery_finds_alertmanager(
    monitoring_app, fake_api, kube_cluster, fake_alertmanager
):
    http, _ = monitoring_app
    seed(
        fake_api,
        service(
            "monitoring",
            "alertmanager-operated",
            labels={"operated-alertmanager": "true"},
            ports=[tcp("http-web", 9093), tcp("tcp-mesh", 9094)],
            cluster_ip="None",
            selector={"app.kubernetes.io/name": "alertmanager"},
        ),
    )
    fake_api.service_backends[("monitoring", "alertmanager-operated:9093")] = fake_alertmanager.url
    body = (await http.get(f"{BASE}/{kube_cluster}")).json()
    found = by_type(body["found"])
    [am] = found["alertmanager"]
    assert (am["state"], am["service"], am["port"], am["version"]) == (
        "reachable",
        "alertmanager-operated",
        "9093",
        "0.27.0",
    )
    assert "missing" not in {t["state"] for t in found["alertmanager"]}


async def test_discovery_reports_no_missing_alertmanager(monitoring_app, fake_api, kube_cluster):
    http, _ = monitoring_app
    body = (await http.get(f"{BASE}/{kube_cluster}")).json()
    assert "alertmanager" not in by_type(body["found"])


async def test_catalog_leaves_out_alertmanager_sources(
    monitoring_app, fake_prometheus, fake_alertmanager, linked_project, direct
):
    http, _ = monitoring_app
    source_id = await _alertmanager_source(http, fake_alertmanager.url)
    link = await http.put(
        f"/api/monitoring/projects/{linked_project.project_id}/sources/{source_id}",
        json={"filter": 'cluster="a"'},
    )
    assert link.status_code == 200, link.text
    t = direct(fake_alertmanager.url, type="alertmanager", name="Alerts")
    assert await AlertmanagerConnector().catalog(
        t, matchers=(), now=1_800_000_000.0
    ) == SourceCatalog((), (), (), ())
    assert (
        await AlertmanagerConnector().label_values(
            t, "job", matchers=(), selector="up", start=1.0, end=2.0
        )
        == []
    )
    r = await http.get(f"/api/monitoring/projects/{linked_project.project_id}/catalog")
    assert r.status_code == 200
    assert [s["source_type"] for s in r.json()["sources"]] == ["prometheus"]
    assert not [q for q in fake_alertmanager.requests if q.path != "/api/v2/status"]
