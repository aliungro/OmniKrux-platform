"""`POST /query/why-empty`: why a query came back empty, said only when a check proved it, and
always for the project the query ran for (under its filter)."""

import time
from dataclasses import replace

import pytest

from omnikrux.monitoring.query import api as query_api
from omnikrux.monitoring.query import why_empty
from omnikrux.monitoring.query.filters import UNREADABLE
from omnikrux.monitoring.query.why_empty import age_words, labels_words, missing_metric_words
from omnikrux.monitoring.sources.connector import QueryRejected
from omnikrux.monitoring.sources.loki import LokiConnector
from tests.monitoring.fakes import Canned

WHY = "/api/monitoring/query/why-empty"
HOUR = 3600
DAY = 86400
NS = 1_000_000_000
THROTTLED = "container_cpu_cfs_throttled_periods_total"


def refusal(r) -> tuple[int, str, str]:
    detail = r.json()["detail"]
    return r.status_code, detail["code"], detail["message"]


def answer(r) -> tuple[str, str | None]:
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"reason", "message"}
    return body["reason"], body["message"]


def prometheus_body(source_id: str, project_id: str, metrics: list[str], **over) -> dict:
    now = time.time()
    return {
        "source_id": source_id,
        "project_id": project_id,
        "query": f"sum(rate({metrics[0] if metrics else 'x'}[5m]))",
        "start": now - HOUR,
        "end": now,
        "metrics": metrics,
    } | over


def loki_body(shop, selector: str | None, query: str | None = None, **over) -> dict:
    now = time.time()
    return {
        "source_id": shop.loki_source_id,
        "project_id": shop.project_id,
        "query": query or selector or '{job="x"}',
        "start": now - HOUR,
        "end": now,
        "selector": selector,
    } | over


def ns(seconds: float) -> int:
    return int(seconds * NS)


def classic_stream(at: float, **labels: str) -> tuple[dict[str, str], list[tuple[int, str]]]:
    """A stream with classic Pod labels and one line at `at` (seconds)."""
    return (
        {"cluster": "a", "namespace": "shop", "pod": "web-1"} | labels,
        [(ns(at), "GET /health 200")],
    )


# --- Prometheus ---------------------------------------------------------------------------------


async def test_a_missing_cadvisor_metric_names_cpu_throttling(
    monitoring_app, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    shop = linked_project
    fake_prometheus.label_values["__name__"] = ["container_cpu_usage_seconds_total"]
    body = prometheus_body(
        shop.source_id, shop.project_id, ["container_cpu_usage_seconds_total", THROTTLED]
    )
    r = await http.post(WHY, json=body)
    assert answer(r) == (
        "missing_metric",
        (
            "This Prometheus doesn't collect CPU throttling for this project: "
            "container_cpu_cfs_throttled_periods_total has no series."
        ),
    )
    asked = [q for q in fake_prometheus.requests if q.path == "/api/v1/label/__name__/values"]
    assert sorted(q.params["match[]"][0] for q in asked) == [
        '{__name__="container_cpu_cfs_throttled_periods_total",cluster="a"}',
        '{__name__="container_cpu_usage_seconds_total",cluster="a"}',
    ]
    # The whole retention: no window is sent.
    assert all("start" not in q.params and "end" not in q.params for q in asked)


def test_missing_metric_words_name_the_exporter_by_prefix():
    assert missing_metric_words("container_memory_working_set_bytes") == (
        "This Prometheus doesn't collect container usage from the kubelet (cAdvisor) for this "
        "project: container_memory_working_set_bytes has no series."
    )
    assert missing_metric_words("kube_pod_status_ready") == (
        "This Prometheus doesn't collect Kubernetes object states (kube-state-metrics) for this "
        "project: kube_pod_status_ready has no series."
    )
    assert missing_metric_words("node_cpu_seconds_total") == (
        "This Prometheus doesn't collect node metrics (node-exporter) for this project: "
        "node_cpu_seconds_total has no series."
    )
    assert missing_metric_words(THROTTLED).startswith(
        "This Prometheus doesn't collect CPU throttling for this project"
    )


async def test_an_unknown_prefix_uses_the_plain_words(
    monitoring_app, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    shop = linked_project
    r = await http.post(
        WHY, json=prometheus_body(shop.source_id, shop.project_id, ["http_requests_total"])
    )
    assert answer(r) == (
        "missing_metric",
        "This Prometheus doesn't collect http_requests_total for this project.",
    )


async def test_collected_metrics_say_nothing_matched(
    monitoring_app, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    shop = linked_project
    fake_prometheus.label_values["__name__"] = ["kube_pod_info", "up"]
    r = await http.post(
        WHY, json=prometheus_body(shop.source_id, shop.project_id, ["up", "kube_pod_info"])
    )
    assert answer(r) == (
        "nothing_matched",
        (
            "The query's metrics are collected for this project, but nothing matched in this "
            "time range. Try a longer range."
        ),
    )


async def test_missing_is_judged_under_the_project_filter(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    fake_prometheus.label_values_from_series = True
    fake_prometheus.series = [{"__name__": THROTTLED, "cluster": "b"}]
    r = await http.post(WHY, json=prometheus_body(p.source_id, p.a, [THROTTLED]))
    assert answer(r)[0] == "missing_metric"
    assert fake_prometheus.requests[-1].params["match[]"] == [
        '{__name__="container_cpu_cfs_throttled_periods_total",cluster="a"}'
    ]
    r = await http.post(WHY, json=prometheus_body(p.source_id, p.b, [THROTTLED]))
    assert answer(r)[0] == "nothing_matched"
    assert fake_prometheus.requests[-1].params["match[]"] == [
        '{__name__="container_cpu_cfs_throttled_periods_total",cluster="b"}'
    ]


async def test_a_query_without_metric_names_says_unknown(
    monitoring_app, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    shop = linked_project
    body = prometheus_body(shop.source_id, shop.project_id, [], query="vector(1) > 2")
    assert answer(await http.post(WHY, json=body)) == ("unknown", None)
    assert fake_prometheus.requests == []


# --- Loki ---------------------------------------------------------------------------------------


async def test_missing_loki_labels_are_named(monitoring_app, fake_loki, linked_project_with_loki):
    http, _ = monitoring_app
    shop = linked_project_with_loki
    now = time.time()
    fake_loki.stream_lines = [
        classic_stream(now - HOUR),
        # Another project's stream has the OpenTelemetry label: it doesn't count for this one.
        ({"cluster": "b", "k8s_pod_name": "web-1"}, [(ns(now - HOUR), "x")]),
    ]
    selector = '{k8s_pod_name=~".+"}'
    r = await http.post(WHY, json=loki_body(shop, selector, f'{selector} |= "error"'))
    assert answer(r) == (
        "missing_labels",
        (
            'This Loki has no streams with the label "k8s_pod_name" for this project in the last '
            "30 days, so nothing sends these logs to it now."
        ),
    )
    [asked] = [q for q in fake_loki.requests if q.path == "/loki/api/v1/series"]
    assert asked.params["match[]"] == ['{cluster="a"}']
    start, end = int(asked.params["start"][0]), int(asked.params["end"][0])
    assert end - start == 30 * DAY * NS
    assert abs(end - ns(now)) < 60 * NS

    selector = '{k8s_namespace_name="shop", k8s_pod_name=~".+", namespace="shop"}'
    r = await http.post(WHY, json=loki_body(shop, selector))
    assert answer(r)[1] == (
        'This Loki has no streams with the labels "k8s_namespace_name" and "k8s_pod_name" for '
        "this project in the last 30 days, so nothing sends these logs to it now."
    )


async def test_only_labels_the_selector_needs_count(
    monitoring_app, fake_loki, linked_project_with_loki
):
    """A negative matcher, or a regex that matches the empty value, selects streams without the
    label: it isn't missing."""
    http, _ = monitoring_app
    shop = linked_project_with_loki
    fake_loki.stream_lines = [classic_stream(time.time() - 600)]
    selector = '{namespace="shop", app!="x", team=~".*", tier!~"db", k8s_pod_name=""}'
    r = await http.post(WHY, json=loki_body(shop, selector, f'{selector} |= "panic"'))
    assert answer(r)[0] == "filtered_out"


async def test_labels_seen_only_long_ago_say_thirty_days(
    monitoring_app, fake_loki, linked_project_with_loki
):
    http, _ = monitoring_app
    shop = linked_project_with_loki
    now = time.time()
    fake_loki.stream_lines = [
        classic_stream(now - HOUR),
        ({"cluster": "a", "k8s_pod_name": "web-1"}, [(ns(now - 40 * DAY), "x")]),
    ]
    r = await http.post(WHY, json=loki_body(shop, '{k8s_pod_name="web-1"}'))
    reason, message = answer(r)
    assert reason == "missing_labels"
    assert "for this project in the last 30 days" in message


async def test_lokis_own_labels_are_never_called_missing(
    monitoring_app, fake_loki, linked_project_with_loki
):
    """Loki never lists `__…` labels with a stream's labels, so the check can't tell: it is
    skipped, never reported missing."""
    http, _ = monitoring_app
    shop = linked_project_with_loki
    fake_loki.stream_lines = [classic_stream(time.time() - 600, __stream_shard__="1")]
    selector = '{__stream_shard__="1", namespace="shop"}'
    r = await http.post(WHY, json=loki_body(shop, selector, f'{selector} |= "panic"'))
    assert answer(r)[0] == "filtered_out"


async def test_a_malformed_stream_count_is_refused_not_zero():
    loki = LokiConnector()
    for body in (b'{"status":"success","data":{"a":1}}', b'{"status":"error","data":[]}'):
        with pytest.raises(QueryRejected):
            await loki.stream_count(Canned(200, body), '{a="b"}', matchers=(), start=0, end=1)
    null = Canned(200, b'{"status":"success","data":null}')
    assert await loki.stream_count(null, '{a="b"}', matchers=(), start=0, end=1) == 0
    listed = Canned(200, b'{"status":"success","data":[{"a":"b"},{"a":"c"}]}')
    assert await loki.stream_count(listed, '{a="b"}', matchers=(), start=0, end=1) == 2


def test_labels_words():
    assert labels_words(["k8s_pod_name"]) == 'the label "k8s_pod_name"'
    assert labels_words(["namespace", "pod"]) == 'the labels "namespace" and "pod"'
    assert labels_words(["a", "b", "c"]) == 'the labels "a", "b" and "c"'


async def test_no_streams_in_thirty_days(monitoring_app, fake_loki, linked_project_with_loki):
    http, _ = monitoring_app
    shop = linked_project_with_loki
    now = time.time()
    fake_loki.stream_lines = [
        classic_stream(now - HOUR),
        classic_stream(now - 40 * DAY, pod="api-1"),
        classic_stream(now - HOUR, pod="api-1", cluster="b"),
    ]
    selector = '{namespace="shop", pod="api-1"}'
    r = await http.post(WHY, json=loki_body(shop, selector))
    assert answer(r) == (
        "no_streams",
        (
            'No log streams in this Loki match {namespace="shop", pod="api-1"} for this project '
            "in the last 30 days."
        ),
    )
    asked = [q for q in fake_loki.requests if q.path == "/loki/api/v1/series"]
    assert asked[-1].params["match[]"] == ['{namespace="shop", pod="api-1",cluster="a"}']


async def test_streams_without_lines_say_no_streams(
    monitoring_app, fake_loki, linked_project_with_loki
):
    """Loki lists the stream, but reading its lines finds none: no log streams to show."""
    http, _ = monitoring_app
    shop = linked_project_with_loki
    fake_loki.stream_lines = [classic_stream(time.time() - HOUR)]
    fake_loki.results['{namespace="shop",cluster="a"}'] = {"resultType": "streams", "result": []}
    r = await http.post(WHY, json=loki_body(shop, '{namespace="shop"}'))
    assert answer(r)[0] == "no_streams"
    # The same for a range in the past: the newest line is read up to now, not to the range's end.
    now = time.time()
    body = loki_body(shop, '{namespace="shop"}', start=now - 2 * DAY, end=now - DAY)
    assert answer(await http.post(WHY, json=body))[0] == "no_streams"


async def test_older_lines_say_how_old(monitoring_app, fake_loki, linked_project_with_loki):
    http, _ = monitoring_app
    shop = linked_project_with_loki
    now = time.time()
    start, end = now - HOUR, now
    fake_loki.stream_lines = [
        classic_stream(start - 3 * DAY),
        classic_stream(start - 5 * DAY, pod="web-2"),
    ]
    body = loki_body(shop, '{namespace="shop"}', start=start, end=end)
    r = await http.post(WHY, json=body)
    assert answer(r) == (
        "older_lines",
        "No lines in this time range. The newest matching line is 3 days old: try a longer range.",
    )
    [asked] = [q for q in fake_loki.requests if q.path == "/loki/api/v1/query_range"]
    assert asked.params["query"] == ['{namespace="shop",cluster="a"}']
    assert asked.params["limit"] == ["1"] and asked.params["direction"] == ["backward"]
    # Up to now, not to the range's end: the newest line's age is true for any range.
    assert abs(int(asked.params["end"][0]) - ns(now)) < 60 * NS
    assert abs(int(asked.params["start"][0]) - ns(now - 30 * DAY)) < 60 * NS


async def test_a_past_range_is_judged_by_the_newest_line_up_to_now(
    monitoring_app, fake_loki, linked_project_with_loki
):
    """Yesterday 10:00-11:00 with a line before it and one five minutes ago: the range is quiet,
    and the newest line is five minutes old, not a day."""
    http, _ = monitoring_app
    shop = linked_project_with_loki
    now = time.time()
    start, end = now - DAY - HOUR, now - DAY
    fake_loki.stream_lines = [
        classic_stream(start - HOUR),
        classic_stream(now - 300, pod="web-2"),
    ]
    body = loki_body(shop, '{namespace="shop"}', start=start, end=end)
    r = await http.post(WHY, json=body)
    assert answer(r) == (
        "older_lines",
        "No lines in this time range. The newest matching line is 5 minutes old: try a longer range.",
    )
    reads = [q for q in fake_loki.requests if q.path == "/loki/api/v1/query_range"]
    assert len(reads) == 2
    # The second read covers the range itself.
    assert abs(int(reads[1].params["start"][0]) - ns(start)) < NS
    assert abs(int(reads[1].params["end"][0]) - ns(end)) < NS

    # A line inside the past range as well: the rest of the query dropped it.
    fake_loki.stream_lines.append(classic_stream(start + 600, pod="web-3"))
    r = await http.post(
        WHY,
        json=loki_body(
            shop, '{namespace="shop"}', '{namespace="shop"} |= "x"', start=start, end=end
        ),
    )
    assert answer(r)[0] == "filtered_out"


async def test_lines_in_range_were_filtered_out(
    monitoring_app, fake_loki, linked_project_with_loki
):
    http, _ = monitoring_app
    shop = linked_project_with_loki
    fake_loki.stream_lines = [classic_stream(time.time() - 600)]
    selector = '{namespace="shop"}'
    r = await http.post(WHY, json=loki_body(shop, selector, f'{selector} |= "panic"'))
    assert answer(r) == (
        "filtered_out",
        (
            'Streams match {namespace="shop"}, but no line in this time range passes the rest of '
            "the query."
        ),
    )


async def test_a_log_query_without_a_selector_says_unknown(
    monitoring_app, fake_loki, linked_project_with_loki
):
    http, _ = monitoring_app
    shop = linked_project_with_loki
    r = await http.post(WHY, json=loki_body(shop, None, '{job="x"}'))
    assert answer(r) == ("unknown", None)
    assert fake_loki.requests == []


# --- Failures say nothing new --------------------------------------------------------------------


async def test_why_empty_says_unknown_when_a_check_fails(
    monitoring_app, fake_prometheus, fake_loki, linked_project_with_loki, monkeypatch
):
    http, app = monitoring_app
    shop = linked_project_with_loki
    prometheus = prometheus_body(shop.source_id, shop.project_id, [THROTTLED])
    for mode in ("error500", "not_prometheus"):
        fake_prometheus.mode = mode
        assert answer(await http.post(WHY, json=prometheus)) == ("unknown", None)

    now = time.time()
    fake_loki.stream_lines = [classic_stream(now - 3 * DAY)]
    logs = loki_body(shop, '{namespace="shop"}')
    fake_loki.mode = "error500"
    assert answer(await http.post(WHY, json=logs)) == ("unknown", None)
    # Unreachable mid-check: the labels and streams read, the newest line doesn't.
    fake_loki.mode = "ok"
    fake_loki.fail_paths["/loki/api/v1/query_range"] = 502
    assert answer(await http.post(WHY, json=logs)) == ("unknown", None)

    # Secrets that can't be read: nothing is asked.
    store = app.state.monitoring.sources
    real_get = store.get

    async def unreadable(id):
        return replace(await real_get(id), secrets_unreadable=True)

    monkeypatch.setattr(store, "get", unreadable)
    fake_prometheus.mode = "ok"
    before = len(fake_prometheus.requests)
    assert answer(await http.post(WHY, json=prometheus)) == ("unknown", None)
    assert len(fake_prometheus.requests) == before


async def test_why_empty_gives_up_after_ten_seconds(
    monitoring_app, fake_prometheus, linked_project, monkeypatch
):
    assert why_empty.WHY_EMPTY_SECONDS == 10.0
    http, _ = monitoring_app
    shop = linked_project
    monkeypatch.setattr(why_empty, "WHY_EMPTY_SECONDS", 0.3)
    fake_prometheus.mode = "hang"
    began = time.perf_counter()
    r = await http.post(WHY, json=prometheus_body(shop.source_id, shop.project_id, [THROTTLED]))
    assert answer(r) == ("unknown", None)
    assert time.perf_counter() - began < 5


# --- Refusals ------------------------------------------------------------------------------------


async def test_why_empty_refuses_bad_bodies(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    good = prometheus_body(p.source_id, p.a, ["up"])
    cases = [
        (good | {"metrics": [f"m{n}" for n in range(6)]}, why_empty.METRICS_LIST),
        (good | {"metrics": "up"}, why_empty.METRICS_LIST),
        (good | {"metrics": ["up", "9lives"]}, why_empty.METRIC_NAME),
        (good | {"metrics": ['up{job="x"}']}, why_empty.METRIC_NAME),
        (good | {"end": good["start"]}, why_empty.WINDOW_ORDER),
        (good | {"end": good["start"] - 1}, why_empty.WINDOW_ORDER),
        (good | {"start": "soon"}, query_api.TIME_NUMBER),
        (good | {"query": ""}, query_api.QUERY_LENGTH),
        (good | {"query": "x" * 10001}, query_api.QUERY_LENGTH),
        (good | {"selector": "{" + "a" * 2000 + "}"}, why_empty.SELECTOR_LENGTH),
        ({k: v for k, v in good.items() if k != "project_id"}, why_empty.PROJECT_NAMED),
        ({k: v for k, v in good.items() if k != "source_id"}, query_api.SOURCE_NEEDED),
        ([good], query_api.NOT_AN_OBJECT),
    ]
    for body, words in cases:
        r = await http.post(WHY, json=body)
        assert refusal(r) == (422, "bad_request", words), body
    r = await http.post(WHY, content=b"{not json", headers={"Content-Type": "application/json"})
    assert refusal(r) == (422, "bad_request", query_api.NOT_JSON)

    r = await http.post(WHY, json=good | {"source_id": "gone"})
    assert refusal(r) == (404, "not_found", query_api.SOURCE_GONE)
    r = await http.post(WHY, json=good | {"project_id": "gone"})
    assert refusal(r) == (404, "not_found", query_api.PROJECT_GONE)
    other = await http.post(
        "/api/monitoring/sources",
        json={"type": "prometheus", "reach": "url", "url": fake_prometheus.url, "name": "Other"},
    )
    assert other.status_code == 201, other.text
    r = await http.post(WHY, json=good | {"source_id": other.json()["id"]})
    assert refusal(r) == (404, "not_linked", query_api.NOT_LINKED)
    r = await http.post(WHY, json=good | {"query": 'up{job="x'})
    assert refusal(r) == (400, "bad_query", UNREADABLE)
    assert [q for q in fake_prometheus.requests if "label" in q.path] == []


async def test_a_selector_the_filter_cant_take_is_refused(
    monitoring_app, fake_loki, linked_project_with_loki
):
    http, _ = monitoring_app
    shop = linked_project_with_loki
    r = await http.post(WHY, json=loki_body(shop, '{app="x', '{app="x"}'))
    assert refusal(r) == (400, "bad_query", UNREADABLE)
    assert fake_loki.requests == []


async def test_why_empty_refuses_a_cross_origin_request(
    monitoring_app, fake_prometheus, two_projects_on_one_source
):
    http, _ = monitoring_app
    p = two_projects_on_one_source
    r = await http.post(
        WHY,
        json=prometheus_body(p.source_id, p.a, ["up"]),
        headers={"Origin": "http://evil.example"},
    )
    assert r.status_code == 403
    assert fake_prometheus.requests == []


@pytest.mark.parametrize(
    ("seconds", "words"),
    [
        (-5, "less than a minute"),
        (0, "less than a minute"),
        (59.9, "less than a minute"),
        (60, "1 minute"),
        (119, "1 minute"),
        (120, "2 minutes"),
        (3599, "59 minutes"),
        (3600, "1 hour"),
        (7199, "1 hour"),
        (7200, "2 hours"),
        (86399, "23 hours"),
        (86400, "1 day"),
        (3 * 86400 + 4000, "3 days"),
        (40 * 86400, "40 days"),
    ],
)
def test_age_words(seconds, words):
    assert age_words(seconds) == words
