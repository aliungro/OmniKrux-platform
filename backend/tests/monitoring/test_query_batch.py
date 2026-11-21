"""`POST /query/batch`: a panel's queries run as one request, each with its own project's filter,
and each item succeeds or fails on its own."""

import asyncio
import json
import socket

from omnikrux.monitoring.query import api as query_api
from omnikrux.monitoring.query.filters import UNREADABLE
from omnikrux.monitoring.sources import messages
from tests.monitoring.conftest import TwoProjects

BATCH = "/api/monitoring/query/batch"
QUERY = "/api/monitoring/query"


def closed_port_url() -> str:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return f"http://127.0.0.1:{port}"


async def add_source(http, url: str, name: str) -> str:
    r = await http.post(
        "/api/monitoring/sources",
        json={"type": "prometheus", "reach": "url", "url": url, "name": name},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def set_up(http, name: str, source_id: str, filter: str) -> str:
    r = await http.post(
        "/api/monitoring/setup",
        json={
            "name": name,
            "kind": "custom",
            "sources": [{"source_id": source_id, "filter": filter}],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def refusal(r) -> tuple[int, str, str]:
    detail = r.json()["detail"]
    return r.status_code, detail["code"], detail["message"]


async def test_batch_applies_each_project_filter(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    # projects A (filter cluster="a") and B (cluster="b") link the same source
    http, _ = monitoring_app
    src, a, b = (
        two_projects_on_one_source.source_id,
        two_projects_on_one_source.a,
        two_projects_on_one_source.b,
    )
    r = await http.post(
        BATCH,
        json={
            "queries": [
                {"source_id": src, "project_id": a, "kind": "instant", "query": "up"},
                {"source_id": src, "project_id": b, "kind": "instant", "query": "up"},
            ]
        },
    )
    assert r.status_code == 200, r.text
    sent = sorted(
        q.params["query"][0] for q in fake_prometheus.requests if q.path == "/api/v1/query"
    )
    assert sent == ['up{cluster="a"}', 'up{cluster="b"}']
    results = r.json()["results"]
    assert [i["ok"] for i in results] == [True, True]
    assert [i["response"]["project_id"] for i in results] == [a, b]  # the input's order
    assert [i["response"]["applied_filter"] for i in results] == ['cluster="a"', 'cluster="b"']
    assert all(i["error"] is None for i in results)


async def test_a_value_that_breaks_out_of_its_string_keeps_the_filter(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    """Review Focus 3: an escaped variable value stays one string; the filter still applies."""
    http, _ = monitoring_app
    p = two_projects_on_one_source
    query = 'up{job="a\\"} or up{x=\\""}'  # the value `a"} or up{x="`, escaped by the page
    r = await http.post(
        BATCH,
        json={
            "queries": [
                {"source_id": p.source_id, "project_id": p.a, "kind": "instant", "query": query}
            ]
        },
    )
    assert r.json()["results"][0]["ok"] is True, r.text
    assert fake_prometheus.requests[-1].params["query"] == [
        'up{job="a\\"} or up{x=\\"",cluster="a"}'
    ]


async def test_batch_items_fail_on_their_own(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    fake_prometheus.errors['sum(up{cluster="a"})'] = "parse error: unexpected thing"
    closed = await add_source(http, closed_port_url(), "Gone")
    gone_project = await set_up(http, "Gone project", closed, 'cluster="g"')
    r = await http.post(
        BATCH,
        json={
            "queries": [
                {"source_id": p.source_id, "project_id": p.a, "kind": "instant", "query": "up{"},
                {"source_id": closed, "project_id": gone_project, "kind": "instant", "query": "up"},
                {"source_id": p.source_id, "project_id": p.b, "kind": "instant", "query": "up"},
                {
                    "source_id": p.source_id,
                    "project_id": p.a,
                    "kind": "instant",
                    "query": "sum(up)",
                },
            ]
        },
    )
    assert r.status_code == 200, r.text
    first, second, third, fourth = r.json()["results"]
    assert first == {
        "ok": False,
        "response": None,
        "error": {"code": "bad_query", "message": UNREADABLE, "status": 400},
    }
    assert second["ok"] is False and second["response"] is None
    assert second["error"] == {
        "code": "unreachable",
        "message": messages.REFUSED.format(name="Gone"),
        "status": 502,
    }
    assert third["ok"] is True and third["response"]["query"] == 'up{cluster="b"}'
    assert fourth["error"] == {
        "code": "bad_query",
        "message": "parse error: unexpected thing",
        "status": 400,
    }


async def test_an_item_that_breaks_a_field_limit_fails_alone(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    good = {"source_id": p.source_id, "project_id": p.a, "kind": "instant", "query": "up"}
    r = await http.post(
        BATCH,
        json={
            "queries": [
                good | {"query": ""},
                good | {"limit": 0},
                good | {"time": "soon"},
                [1, 2],
                good,
            ]
        },
    )
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert [i["error"] for i in results[:4]] == [
        {"code": "bad_request", "message": query_api.QUERY_LENGTH, "status": 422},
        {"code": "bad_request", "message": query_api.LIMIT_RANGE, "status": 422},
        {"code": "bad_request", "message": query_api.TIME_NUMBER, "status": 422},
        {"code": "bad_request", "message": query_api.NOT_AN_OBJECT, "status": 422},
    ]
    assert results[4]["ok"] is True
    assert [q.params["query"] for q in fake_prometheus.requests] == [['up{cluster="a"}']]


async def test_an_item_without_a_project_is_refused(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    """Isolation: a batch never runs a query unfiltered, even on a source no project needs."""
    http, _ = monitoring_app
    p = two_projects_on_one_source
    r = await http.post(
        BATCH,
        json={
            "queries": [
                {"source_id": p.source_id, "kind": "instant", "query": "up"},
                {"source_id": p.source_id, "project_id": None, "kind": "instant", "query": "up"},
                {"source_id": p.source_id, "project_id": p.b, "kind": "instant", "query": "up"},
            ]
        },
    )
    results = r.json()["results"]
    refused = {"code": "bad_request", "message": query_api.PROJECT_CHOICE, "status": 422}
    assert [i["error"] for i in results[:2]] == [refused, refused]
    assert results[2]["ok"] is True
    assert [q.params["query"] for q in fake_prometheus.requests] == [['up{cluster="b"}']]


async def test_batch_limits(monitoring_app, two_projects_on_one_source):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    item = {"source_id": p.source_id, "project_id": p.a, "kind": "instant", "query": "up"}
    for body in ({"queries": []}, {"queries": [item] * 65}):
        r = await http.post(BATCH, json=body)
        assert refusal(r) == (422, "bad_request", query_api.BATCH_SIZE)
    for body in ({}, {"queries": item}, {"queries": "up"}):
        r = await http.post(BATCH, json=body)
        assert refusal(r) == (422, "bad_request", query_api.BATCH_LIST)
    r = await http.post(BATCH, json=[item])
    assert refusal(r) == (422, "bad_request", query_api.BATCH_NOT_AN_OBJECT)
    r = await http.post(BATCH, content=b"{not json", headers={"content-type": "application/json"})
    assert refusal(r) == (422, "bad_request", query_api.NOT_JSON)
    r = await http.post(BATCH, json={"queries": [item] * 64})
    assert r.status_code == 200 and len(r.json()["results"]) == 64


async def test_at_most_eight_items_run_at_once(monitoring_app, monkeypatch):
    http, _ = monitoring_app
    running = 0
    most = 0
    answered = asyncio.Event()

    async def slow(services, req):
        nonlocal running, most
        running += 1
        most = max(most, running)
        await asyncio.sleep(0.02)
        running -= 1
        answered.set()
        raise query_api.QueryError(404, "not_found", "gone")

    monkeypatch.setattr(query_api, "run_query", slow)
    item = {"source_id": "s", "project_id": "p", "kind": "instant", "query": "up"}
    r = await http.post(BATCH, json={"queries": [item] * 20})
    assert r.status_code == 200
    assert answered.is_set() and most == query_api.MAX_RUNNING == 8
    assert [i["error"]["status"] for i in r.json()["results"]] == [404] * 20


async def test_batch_refuses_cross_origin(monitoring_app, two_projects_on_one_source):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    item = {"source_id": p.source_id, "project_id": p.a, "kind": "instant", "query": "up"}
    r = await http.post(BATCH, json={"queries": [item]}, headers={"Origin": "http://evil.example"})
    assert r.status_code == 403


async def test_query_route_is_unchanged(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    """M1's `POST /query` answers byte for byte as before: success, not linked and bad query."""
    http, _ = monitoring_app
    p: TwoProjects = two_projects_on_one_source
    fake_prometheus.results['up{cluster="a"}'] = {
        "resultType": "vector",
        "result": [{"metric": {"cluster": "a"}, "value": [1700000000, "1"]}],
    }
    r = await http.post(
        QUERY, json={"source_id": p.source_id, "project_id": p.a, "kind": "instant", "query": "up"}
    )
    assert r.status_code == 200
    body = r.json()
    assert list(body) == [
        "result_type",
        "series",
        "streams",
        "warnings",
        "truncated",
        "source_id",
        "source_name",
        "source_type",
        "project_id",
        "applied_filter",
        "query",
        "took_ms",
    ]
    assert isinstance(body.pop("took_ms"), int)
    assert body == {
        "result_type": "vector",
        "series": [{"labels": {"cluster": "a"}, "points": [[1700000000.0, 1.0]]}],
        "streams": [],
        "warnings": [],
        "truncated": False,
        "source_id": p.source_id,
        "source_name": "Shared",
        "source_type": "prometheus",
        "project_id": p.a,
        "applied_filter": 'cluster="a"',
        "query": 'up{cluster="a"}',
    }

    def exact(status: int, code: str, message: str) -> tuple[int, bytes]:
        body = {"detail": {"code": code, "message": message}}
        return status, json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()

    other = await add_source(http, fake_prometheus.url, "Other")
    r = await http.post(
        QUERY, json={"source_id": other, "project_id": p.a, "kind": "instant", "query": "up"}
    )
    assert (r.status_code, r.content) == exact(
        404, "not_linked", "This source isn't linked to that project."
    )
    r = await http.post(
        QUERY, json={"source_id": p.source_id, "project_id": p.a, "kind": "instant", "query": "up{"}
    )
    assert (r.status_code, r.content) == exact(
        400, "bad_query", "The query has an unclosed quote or bracket."
    )
    r = await http.post(QUERY, json={"source_id": p.source_id, "kind": "instant", "query": "up"})
    assert r.status_code == 200 and r.json()["query"] == "up"  # Sources page: unfiltered
