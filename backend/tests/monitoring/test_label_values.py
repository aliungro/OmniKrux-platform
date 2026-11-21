"""`GET /label-values`: the values of one label for a dashboard variable, always read through a
project's filter."""

from dataclasses import replace

from omnikrux.monitoring.query import api as query_api
from omnikrux.monitoring.query.filters import UNREADABLE
from omnikrux.monitoring.sources.health import SECRETS_UNREADABLE

VALUES = "/api/monitoring/label-values"


def refusal(r) -> tuple[int, str, str]:
    detail = r.json()["detail"]
    return r.status_code, detail["code"], detail["message"]


async def test_label_values_use_selector_and_filter(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    fake_prometheus.label_values["pod"] = ["web-2", "api-1", "db-0"]
    r = await http.get(
        VALUES,
        params={
            "source_id": p.source_id,
            "project_id": p.a,
            "label": "pod",
            "match": 'kube_pod_info{namespace=~"api"}',
            "start": "1700000000",
            "end": "1700003600",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"values": ["api-1", "db-0", "web-2"], "truncated": False}
    sent = fake_prometheus.requests[-1]
    assert sent.path == "/api/v1/label/pod/values"
    assert sent.params["match[]"] == ['kube_pod_info{namespace=~"api",cluster="a"}']
    assert sent.params["start"] == ["1700000000"] and sent.params["end"] == ["1700003600"]


async def test_each_project_reads_its_own_values(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    """A ready-made variable's bare metric name gets the filter; without `match` the filter alone
    narrows the values."""
    http, _ = monitoring_app
    p = two_projects_on_one_source
    base = {"source_id": p.source_id, "label": "namespace"}
    r = await http.get(
        VALUES, params=base | {"project_id": p.b, "match": "kube_namespace_status_phase"}
    )
    assert r.status_code == 200, r.text
    assert fake_prometheus.requests[-1].params["match[]"] == [
        'kube_namespace_status_phase{cluster="b"}'
    ]
    r = await http.get(VALUES, params=base | {"project_id": p.a})
    assert r.status_code == 200, r.text
    sent = fake_prometheus.requests[-1]
    assert sent.params["match[]"] == ['{cluster="a"}']
    assert "start" not in sent.params and "end" not in sent.params


async def test_loki_label_values(monitoring_app, fake_loki):
    http, _ = monitoring_app
    source = await http.post(
        "/api/monitoring/sources",
        json={"type": "loki", "reach": "url", "url": fake_loki.url, "name": "Logs"},
    )
    assert source.status_code == 201, source.text
    source_id = source.json()["id"]
    project = await http.post(
        "/api/monitoring/setup",
        json={
            "name": "Logs project",
            "kind": "custom",
            "sources": [{"source_id": source_id, "filter": 'cluster="a"'}],
        },
    )
    assert project.status_code == 201, project.text
    fake_loki.label_values["app"] = ["y", "x"]
    r = await http.get(
        VALUES,
        params={
            "source_id": source_id,
            "project_id": project.json()["id"],
            "label": "app",
            "match": '{job="x"}',
            "start": "1700000000",
            "end": "1700003600.5",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"values": ["x", "y"], "truncated": False}
    sent = fake_loki.requests[-1]
    assert sent.path == "/loki/api/v1/label/app/values"
    assert sent.params["query"] == ['{job="x",cluster="a"}']
    assert sent.params["start"] == ["1700000000000000000"]
    assert sent.params["end"] == ["1700003600500000000"]


async def test_label_values_refuse_a_bad_label_name(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    before = len(fake_prometheus.requests)
    for label in ("1pod", "pod/../x", "pod-name", "", None):
        params = {"source_id": p.source_id, "project_id": p.a}
        if label is not None:
            params["label"] = label
        r = await http.get(VALUES, params=params)
        assert refusal(r) == (
            400,
            "bad_request",
            "Use a label name: letters, digits and _, not starting with a digit.",
        )
    assert len(fake_prometheus.requests) == before


async def test_label_values_need_a_project_and_a_source(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    r = await http.get(VALUES, params={"source_id": p.source_id, "label": "pod"})
    assert refusal(r) == (400, "bad_request", query_api.PROJECT_NEEDED)
    r = await http.get(VALUES, params={"project_id": p.a, "label": "pod"})
    assert refusal(r) == (400, "bad_request", query_api.SOURCE_NEEDED)
    base = {"source_id": p.source_id, "project_id": p.a, "label": "pod"}
    for time in ("soon", "nan", "inf"):
        r = await http.get(VALUES, params=base | {"start": time})
        assert refusal(r) == (400, "bad_request", query_api.TIME_NUMBER)
    r = await http.get(VALUES, params=base | {"match": "x" * 10001})
    assert refusal(r) == (400, "bad_request", query_api.QUERY_LENGTH)
    assert fake_prometheus.requests == []


async def test_label_values_errors_are_query_errors(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    base = {"source_id": p.source_id, "project_id": p.a, "label": "pod"}
    r = await http.get(VALUES, params=base | {"match": "kube_pod_info{"})
    assert refusal(r) == (400, "bad_query", UNREADABLE)
    assert fake_prometheus.requests == []
    r = await http.get(VALUES, params=base | {"source_id": "nope"})
    assert refusal(r)[:2] == (404, "not_found")
    r = await http.get(VALUES, params=base | {"project_id": "nope"})
    assert refusal(r)[:2] == (404, "not_found")
    other = await http.post(
        "/api/monitoring/sources",
        json={"type": "prometheus", "reach": "url", "url": fake_prometheus.url, "name": "Other"},
    )
    r = await http.get(VALUES, params=base | {"source_id": other.json()["id"]})
    assert refusal(r) == (404, "not_linked", "This source isn't linked to that project.")
    fake_prometheus.mode = "error500"
    r = await http.get(VALUES, params=base)
    assert refusal(r)[:2] == (502, "tool_error")


async def test_label_values_refuse_unreadable_secrets(
    monitoring_app, fake_prometheus, two_projects_on_one_source, monkeypatch
):
    http, app = monitoring_app
    p = two_projects_on_one_source
    store = app.state.monitoring.sources
    real_get = store.get

    async def unreadable(id):
        source = await real_get(id)
        return replace(source, secrets_unreadable=True)

    monkeypatch.setattr(store, "get", unreadable)
    r = await http.get(VALUES, params={"source_id": p.source_id, "project_id": p.a, "label": "pod"})
    assert refusal(r) == (502, "unreachable", SECRETS_UNREADABLE)
    assert fake_prometheus.requests == []


async def test_label_values_are_capped(monitoring_app, fake_prometheus, two_projects_on_one_source):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    fake_prometheus.label_values["pod"] = [f"pod-{n:04d}" for n in reversed(range(1001))]
    r = await http.get(VALUES, params={"source_id": p.source_id, "project_id": p.a, "label": "pod"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["truncated"] is True
    assert body["values"] == [f"pod-{n:04d}" for n in range(1000)]
    fake_prometheus.label_values["pod"] = [f"pod-{n:04d}" for n in range(1000)]
    r = await http.get(VALUES, params={"source_id": p.source_id, "project_id": p.a, "label": "pod"})
    assert r.json()["truncated"] is False and len(r.json()["values"]) == 1000


async def test_label_values_refuse_cross_origin(monitoring_app, two_projects_on_one_source):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    r = await http.get(
        VALUES,
        params={"source_id": p.source_id, "project_id": p.a, "label": "pod"},
        headers={"Origin": "http://evil.example"},
    )
    assert r.status_code == 403
