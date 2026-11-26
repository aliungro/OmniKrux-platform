"""The query proxy: every query runs on the server, with the project's filter on every selector."""

import socket

import pytest

from omnikrux.monitoring.query import api as query_api
from omnikrux.monitoring.query.filters import UNREADABLE
from omnikrux.monitoring.sources import messages, prometheus
from omnikrux.monitoring.sources.transport import SourceUnreachable
from tests.monitoring.conftest import LinkedProject

QUERY = "/api/monitoring/query"
RANGE = {"kind": "range", "start": 1700000000, "end": 1700003600, "step": 60}


def closed_port_url() -> str:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}"


async def add_source(http, url: str, **over) -> dict:
    response = await http.post(
        "/api/monitoring/sources", json={"type": "prometheus", "reach": "url", "url": url} | over
    )
    assert response.status_code == 201, response.text
    return response.json()


async def set_up(http, name: str, source_id: str, filter: str) -> str:
    response = await http.post(
        "/api/monitoring/setup",
        json={
            "name": name,
            "kind": "custom",
            "sources": [{"source_id": source_id, "filter": filter}],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def error(response) -> tuple[int, str, str]:
    detail = response.json()["detail"]
    return response.status_code, detail["code"], detail["message"]


async def test_query_carries_the_project_filter(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    src, pid = linked_project.source_id, linked_project.project_id
    r = await http.post(
        QUERY,
        json={
            "source_id": src,
            "project_id": pid,
            "kind": "range",
            "query": "rate(http_requests_total[5m])",
            "start": 1700000000,
            "end": 1700003600,
            "step": 60,
        },
    )
    assert r.status_code == 200, r.text
    sent = fake_prometheus.requests[-1]
    assert sent.path == "/api/v1/query_range"
    assert sent.params["query"] == ['rate(http_requests_total{cluster="a"}[5m])']
    assert (
        r.json()["applied_filter"] == 'cluster="a"' and r.json()["query"] == sent.params["query"][0]
    )
    assert sent.params["start"] == ["1700000000"] and sent.params["step"] == ["60"]


async def test_the_answer_carries_the_result_and_where_it_came_from(
    monitoring_app, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    fake_prometheus.results['up{cluster="a"}'] = {
        "resultType": "vector",
        "result": [{"metric": {"__name__": "up", "cluster": "a"}, "value": [1700000000, "1"]}],
    }
    r = await http.post(
        QUERY,
        json={
            "source_id": linked_project.source_id,
            "project_id": linked_project.project_id,
            "kind": "instant",
            "query": "up",
            "time": 1700000000,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    took = body.pop("took_ms")
    assert isinstance(took, int) and took >= 0
    assert body == {
        "result_type": "vector",
        "series": [{"labels": {"__name__": "up", "cluster": "a"}, "points": [[1700000000.0, 1.0]]}],
        "streams": [],
        "warnings": [],
        "truncated": False,
        "source_id": linked_project.source_id,
        "source_name": "Shop",
        "source_type": "prometheus",
        "project_id": linked_project.project_id,
        "applied_filter": 'cluster="a"',
        "query": 'up{cluster="a"}',
    }
    sent = fake_prometheus.requests[-1]
    assert sent.path == "/api/v1/query" and sent.params["time"] == ["1700000000"]


async def test_without_a_project_the_query_runs_as_written(monitoring_app, fake_prometheus):
    http, _ = monitoring_app
    source = await add_source(http, fake_prometheus.url)
    r = await http.post(
        QUERY, json={"source_id": source["id"], "kind": "instant", "query": 'up{job="x"}'}
    )
    assert r.status_code == 200, r.text
    assert fake_prometheus.requests[-1].params["query"] == ['up{job="x"}']
    assert r.json()["applied_filter"] == "" and r.json()["project_id"] is None


async def test_logql_carries_the_project_filter(monitoring_app, fake_loki):
    http, _ = monitoring_app
    source = await add_source(http, fake_loki.url, type="loki")
    project_id = await set_up(http, "Logs", source["id"], 'cluster="a"')
    r = await http.post(
        QUERY,
        json={"source_id": source["id"], "project_id": project_id, "query": '{app="api"}'} | RANGE,
    )
    assert r.status_code == 200, r.text
    sent = fake_loki.requests[-1]
    assert sent.path == "/loki/api/v1/query_range"
    assert sent.params["query"] == ['{app="api",cluster="a"}']
    assert sent.params["limit"] == ["1000"] and sent.params["direction"] == ["backward"]
    body = r.json()
    assert body["query"] == '{app="api",cluster="a"}' and body["applied_filter"] == 'cluster="a"'
    assert body["result_type"] == "streams" and body["source_type"] == "loki"


async def test_logs_take_the_given_limit_and_direction(monitoring_app, fake_loki):
    http, _ = monitoring_app
    source = await add_source(http, fake_loki.url, type="loki")
    r = await http.post(
        QUERY,
        json={
            "source_id": source["id"],
            "query": '{app="api"}',
            "limit": 50,
            "direction": "forward",
        }
        | RANGE,
    )
    assert r.status_code == 200, r.text
    sent = fake_loki.requests[-1]
    assert sent.params["limit"] == ["50"] and sent.params["direction"] == ["forward"]


async def test_query_refuses_what_it_cannot_filter(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    before = len(fake_prometheus.requests)
    r = await http.post(
        QUERY,
        json={
            "source_id": linked_project.source_id,
            "project_id": linked_project.project_id,
            "kind": "instant",
            "query": 'up{job="x}',
        },
    )
    assert error(r) == (400, "bad_query", UNREADABLE)
    assert len(fake_prometheus.requests) == before


async def test_unlinked_source_is_refused(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    other = await add_source(http, fake_prometheus.url, name="Other")
    before = len(fake_prometheus.requests)
    r = await http.post(
        QUERY,
        json={
            "source_id": other["id"],
            "project_id": linked_project.project_id,
            "kind": "instant",
            "query": "up",
        },
    )
    assert r.status_code == 404
    assert r.json() == {
        "detail": {"code": "not_linked", "message": "This source isn't linked to that project."}
    }
    assert len(fake_prometheus.requests) == before


async def test_unknown_source_and_project(monitoring_app, linked_project):
    http, _ = monitoring_app
    r = await http.post(QUERY, json={"source_id": "nope", "kind": "instant", "query": "up"})
    assert error(r) == (404, "not_found", "That source no longer exists.")
    r = await http.post(
        QUERY,
        json={
            "source_id": linked_project.source_id,
            "project_id": "nope",
            "kind": "instant",
            "query": "up",
        },
    )
    assert error(r) == (404, "not_found", "That project no longer exists.")


async def test_range_limits(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    base = {
        "source_id": linked_project.source_id,
        "project_id": linked_project.project_id,
        "kind": "range",
        "query": "up",
    }
    needs = "A range query needs a start, an end after it, and a step."
    before = len(fake_prometheus.requests)
    for times in (
        {"start": 1700003600, "end": 1700003600, "step": 60},
        {"start": 1700003600, "end": 1700000000, "step": 60},
        {"end": 1700003600, "step": 60},
        {"start": 1700000000, "step": 60},
        {"start": 1700000000, "end": 1700003600},
    ):
        r = await http.post(QUERY, json=base | times)
        assert error(r) == (400, "bad_request", needs), times
    r = await http.post(QUERY, json=base | {"start": 1700000000, "end": 1700003600, "step": 0.1})
    assert error(r) == (
        400,
        "bad_request",
        "This range has too many points for the step. Use a larger step.",
    )
    assert len(fake_prometheus.requests) == before
    # Exactly the most points a range may have.
    r = await http.post(QUERY, json=base | {"start": 0, "end": 11000, "step": 1})
    assert r.status_code == 200, r.text


async def test_field_limits_answer_in_plain_words(monitoring_app, linked_project):
    http, _ = monitoring_app
    base = {"source_id": linked_project.source_id, "kind": "instant", "query": "up"}
    secret = "tok-SECRET-" + "x" * 10000
    cases = [
        (base | {"query": secret}, query_api.QUERY_LENGTH),
        (base | {"query": ""}, query_api.QUERY_LENGTH),
        (base | {"limit": 0}, query_api.LIMIT_RANGE),
        (base | {"limit": 5001}, query_api.LIMIT_RANGE),
        (base | {"step": 0}, query_api.STEP_RANGE),
        (base | {"kind": "sideways"}, query_api.KIND_CHOICE),
        (base | {"direction": "up"}, query_api.DIRECTION_CHOICE),
        ({"kind": "instant", "query": "up"}, query_api.SOURCE_NEEDED),
        (base | {"time": "soon"}, query_api.TIME_NUMBER),
        ([1, 2], query_api.NOT_AN_OBJECT),
    ]
    for body, message in cases:
        r = await http.post(QUERY, json=body)
        assert r.status_code == 422, (body, r.text)
        assert r.json() == {"detail": {"code": "bad_request", "message": message}}
        assert "SECRET" not in r.text
    r = await http.post(QUERY, content=b"{not json", headers={"Content-Type": "application/json"})
    assert error(r) == (422, "bad_request", query_api.NOT_JSON)


async def test_numbers_that_are_not_finite_are_refused(
    monitoring_app, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    # Python's JSON reader (and so the server's) takes NaN; JSON itself has no such number.
    text = (
        f'{{"source_id": "{linked_project.source_id}", "kind": "range", "query": "up", '
        '"start": NaN, "end": 1700003600, "step": 60}'
    )
    before = len(fake_prometheus.requests)
    r = await http.post(QUERY, content=text.encode(), headers={"Content-Type": "application/json"})
    assert error(r) == (422, "bad_request", query_api.TIME_NUMBER)
    assert len(fake_prometheus.requests) == before


async def test_tool_errors_are_plain(monitoring_app, fake_prometheus, linked_project, monkeypatch):
    http, _ = monitoring_app
    body = {
        "source_id": linked_project.source_id,
        "project_id": linked_project.project_id,
        "kind": "instant",
        "query": "sum(up)",
    }
    fake_prometheus.errors['sum(up{cluster="a"})'] = "parse error: unexpected thing"
    r = await http.post(QUERY, json=body)
    assert error(r) == (400, "bad_query", "parse error: unexpected thing")

    closed = await add_source(http, closed_port_url(), name="Gone")
    r = await http.post(QUERY, json={"source_id": closed["id"], "kind": "instant", "query": "up"})
    assert error(r) == (502, "unreachable", messages.REFUSED.format(name="Gone"))

    monkeypatch.setattr(prometheus, "QUERY_SECONDS", 0.2)
    fake_prometheus.mode = "hang"
    r = await http.post(QUERY, json=body)
    assert error(r) == (504, "timeout", messages.TIMEOUT.format(name="Shop", seconds="0.2"))


async def test_a_language_without_a_filter_rule_is_refused(
    monitoring_app, fake_prometheus, linked_project, monkeypatch
):
    """A connector whose language has no injector is refused in words, never filtered as LogQL."""
    http, _ = monitoring_app
    monkeypatch.setattr(prometheus.PrometheusConnector, "language", "sql")
    before = len(fake_prometheus.requests)
    r = await http.post(
        QUERY,
        json={
            "source_id": linked_project.source_id,
            "project_id": linked_project.project_id,
            "kind": "instant",
            "query": "up",
        },
    )
    assert error(r) == (400, "bad_request", query_api.NO_FILTER_RULE)
    assert len(fake_prometheus.requests) == before


async def test_rejected_credentials_are_their_own_code(monitoring_app, fake_prometheus):
    from tests.monitoring.fakes import Bearer

    http, _ = monitoring_app
    fake_prometheus.require = Bearer("right")
    source = await add_source(
        http, fake_prometheus.url, name="Locked", auth={"type": "bearer", "token": "wrong-SECRET"}
    )
    r = await http.post(QUERY, json={"source_id": source["id"], "kind": "instant", "query": "up"})
    assert error(r) == (502, "unauthorized", messages.REJECTED.format(name="Locked", status=401))
    assert "SECRET" not in r.text


async def test_a_tool_failure_is_a_tool_error(monitoring_app, fake_prometheus, linked_project):
    http, _ = monitoring_app
    fake_prometheus.mode = "error500"
    r = await http.post(
        QUERY, json={"source_id": linked_project.source_id, "kind": "instant", "query": "up"}
    )
    status, code, _ = error(r)
    assert (status, code) == (502, "tool_error")


@pytest.mark.parametrize(
    ("code", "status", "answer"),
    [
        ("timeout", 504, "timeout"),
        ("unauthorized", 502, "unauthorized"),
        ("too_large", 502, "too_large"),
        ("unreachable", 502, "unreachable"),
        ("tls", 502, "unreachable"),
        ("redirect", 502, "unreachable"),
        ("no_endpoints", 502, "unreachable"),
        ("forbidden", 502, "unreachable"),
        ("unknown_cluster", 502, "unreachable"),
    ],
)
def test_every_transport_failure_has_a_query_code(code, status, answer):
    failure = query_api.unreachable_error(SourceUnreachable(code, "The tool's own words."))
    assert failure.status_code == status
    assert failure.detail == {"code": answer, "message": "The tool's own words."}


async def test_query_refuses_cross_origin(monitoring_app, linked_project):
    http, _ = monitoring_app
    r = await http.post(
        QUERY,
        json={"source_id": linked_project.source_id, "kind": "instant", "query": "up"},
        headers={"Origin": "http://evil.example"},
    )
    assert r.status_code == 403


async def test_query_through_cluster_service(
    monitoring_app, fake_api, kube_cluster, fake_prometheus
):
    http, _ = monitoring_app
    fake_api.service_backends[("monitoring", "prometheus-server:80")] = fake_prometheus.url
    created = await http.post(
        "/api/monitoring/sources",
        json={
            "type": "prometheus",
            "reach": "cluster",
            "cluster_id": kube_cluster,
            "namespace": "monitoring",
            "service": "prometheus-server",
            "port": "80",
            "name": "In cluster",
        },
    )
    assert created.status_code == 201, created.text
    source = created.json()
    project_id = await set_up(http, "Cluster shop", source["id"], 'cluster="a"')
    fake_prometheus.results['up{cluster="a"}'] = {
        "resultType": "vector",
        "result": [{"metric": {"cluster": "a"}, "value": [1700000000, "1"]}],
    }
    r = await http.post(
        QUERY,
        json={
            "source_id": source["id"],
            "project_id": project_id,
            "kind": "instant",
            "query": "up",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["series"] == [{"labels": {"cluster": "a"}, "points": [[1700000000.0, 1.0]]}]
    assert fake_prometheus.requests[-1].params["query"] == ['up{cluster="a"}']


def test_linked_project_is_a_plain_record():
    linked = LinkedProject(project_id="p", source_id="s", project_name="Shop")
    assert (linked.project_id, linked.source_id, linked.project_name) == ("p", "s", "Shop")


async def test_query_route_uses_the_plain_words(monitoring_app, linked_project, fake_prometheus):
    http, _ = monitoring_app
    body = {
        "source_id": linked_project.source_id,
        "project_id": linked_project.project_id,
        "kind": "instant",
        "query": "sum(up)",
    }
    fake_prometheus.errors['sum(up{cluster="a"})'] = (
        'invalid parameter "query": 1:5: parse error: unclosed left parenthesis'
    )
    r = await http.post(QUERY, json=body)
    assert error(r) == (
        400,
        "bad_query",
        "The query doesn't read: a bracket is never closed.",
    )

    # Without a project filter the text is the user's own: its position is theirs too.
    fake_prometheus.errors["sum(up"] = (
        'invalid parameter "query": 1:5: parse error: unclosed left parenthesis'
    )
    r = await http.post(QUERY, json={**body, "project_id": None, "query": "sum(up"})
    assert error(r) == (
        400,
        "bad_query",
        "The query doesn't read at line 1, column 5: a bracket is never closed.",
    )
