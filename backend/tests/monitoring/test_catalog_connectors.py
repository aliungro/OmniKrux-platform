"""Each connector describes its source as a catalog, always narrowed by the project's filter."""

import asyncio
import json
from dataclasses import asdict

import pytest

from omnikrux.monitoring.query.filters import Matcher
from omnikrux.monitoring.sources.connector import (
    NOTE_METRICS_TRUNCATED,
    NOTE_NO_SERIES,
    NOTE_SERIES_SAMPLED,
    NOTE_STREAM_LABELS_TRUNCATED,
    NOTE_STREAM_VALUES_TRUNCATED,
    CatalogLimits,
    CatalogMetric,
    QueryRejected,
    StreamLabel,
)
from omnikrux.monitoring.sources.loki import LokiConnector
from omnikrux.monitoring.sources.prometheus import PrometheusConnector
from omnikrux.monitoring.sources.transport import SourceUnreachable

M = (Matcher("cluster", "=", "a"),)
NOW = 1_800_000_000.0
NAME = "Source · test"
CATALOG_PATHS = ("/api/v1/label/", "/api/v1/labels", "/api/v1/metadata", "/api/v1/series")


class Failing:
    """A transport that raises `SourceUnreachable(code)` for one path and passes the rest on."""

    def __init__(self, inner, path: str, code: str) -> None:
        self.inner, self.path, self.code = inner, path, code

    async def request(self, method, path, **kwargs):
        if path == self.path:
            raise SourceUnreachable(self.code, f"{NAME} failed ({self.code}).")
        return await self.inner.request(method, path, **kwargs)


class Counting:
    """A transport that counts the calls to paths ending in `ends` in flight at once."""

    def __init__(self, inner, ends: tuple[str, ...] = ("/values",)) -> None:
        self.inner, self.ends, self.now, self.peak = inner, ends, 0, 0

    async def request(self, method, path, **kwargs):
        if not path.endswith(self.ends):
            return await self.inner.request(method, path, **kwargs)
        self.now += 1
        self.peak = max(self.peak, self.now)
        try:
            await asyncio.sleep(0.02)
            return await self.inner.request(method, path, **kwargs)
        finally:
            self.now -= 1


def catalog_requests(fake):
    return [r for r in fake.requests if r.path.startswith(CATALOG_PATHS)]


def loki_requests(fake):
    return [r for r in fake.requests if r.path.startswith("/loki/api/v1/")]


# --- Prometheus --------------------------------------------------------------------------------


async def test_prometheus_catalog_joins_names_metadata_and_series(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = [
        "http_requests_total",
        "http_request_duration_seconds_bucket",
        "http_request_duration_seconds_sum",
        "http_request_duration_seconds_count",
        "up",
    ]
    fake_prometheus.labels = ["__name__", "job", "le", "route", "status"]
    fake_prometheus.metadata = {
        "http_requests_total": [{"type": "counter", "help": "Requests.", "unit": ""}],
        "http_request_duration_seconds": [
            {"type": "histogram", "help": "Latency.", "unit": "seconds"}
        ],
    }
    fake_prometheus.series = [
        {"__name__": "http_requests_total", "route": "/a", "status": "200"},
        {"__name__": "http_requests_total", "route": "/b", "status": "500"},
        {"__name__": "http_request_duration_seconds_bucket", "route": "/a", "le": "0.1"},
        {"__name__": "up", "job": "api"},
    ]
    cat = await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=(), now=NOW)
    by = {m.name: m for m in cat.metrics}
    assert by["http_requests_total"] == CatalogMetric(
        "http_requests_total", "counter", "Requests.", None, ("route", "status"), 2, None
    )
    bucket = by["http_request_duration_seconds_bucket"]
    assert bucket.family == "http_request_duration_seconds"
    assert bucket.type == "histogram" and by["http_request_duration_seconds_count"].type == (
        "histogram"
    )
    assert bucket.labels == ("le", "route") and bucket.series == 1
    assert by["http_request_duration_seconds_sum"].family == "http_request_duration_seconds"
    assert by["http_request_duration_seconds_sum"].series == 0
    assert by["up"] == CatalogMetric("up", None, None, None, ("job",), 1, None)
    assert [m.name for m in cat.metrics] == fake_prometheus.label_values["__name__"]
    assert cat.labels == ("__name__", "job", "le", "route", "status")
    assert cat.notes == () and cat.streams == ()


async def test_catalog_calls_carry_the_filter(fake_prometheus, fake_loki, direct):
    fake_prometheus.label_values["__name__"] = ["up"]
    await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    sent = catalog_requests(fake_prometheus)
    assert {r.path for r in sent} == {
        "/api/v1/label/__name__/values",
        "/api/v1/labels",
        "/api/v1/metadata",
        "/api/v1/series",
    }
    # The one exception: /api/v1/metadata takes no match[], so it is read whole and only the
    # entries of names from the filtered list are used (test_metadata_never_adds_names).
    for r in sent:
        if r.path == "/api/v1/metadata":
            assert "match[]" not in r.params
            assert r.params["limit_per_metric"] == ["1"]
        else:
            assert r.params["match[]"] and all('cluster="a"' in m for m in r.params["match[]"])
    [series] = [r for r in sent if r.path == "/api/v1/series"]
    assert series.params["match[]"] == ['{__name__=~".+",cluster="a"}']
    assert float(series.params["start"][0]) == NOW - 900
    assert float(series.params["end"][0]) == NOW
    assert series.params["limit"] == ["50000"]

    await LokiConnector().catalog(direct(fake_loki.url, type="loki"), matchers=M, now=NOW)
    [only] = loki_requests(fake_loki)
    assert only.path == "/loki/api/v1/series"
    assert only.params["match[]"] == ['{cluster="a"}']
    assert int(only.params["start"][0]) == int((NOW - 604800) * 1_000_000_000)
    assert int(only.params["end"][0]) == int(NOW * 1_000_000_000)


async def test_loki_catalog_reads_seven_days(fake_loki, direct):
    fake_loki.labels = ["app"]
    fake_loki.label_values = {"app": ["api"]}
    await LokiConnector().catalog(direct(fake_loki.url, type="loki"), matchers=(), now=NOW)
    sent = loki_requests(fake_loki)
    assert sent and all(
        int(r.params["start"][0]) == int((NOW - 604800) * 1_000_000_000) for r in sent
    )


async def test_prometheus_catalog_without_matchers_sends_no_filter(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["up"]
    await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=(), now=NOW)
    [series] = [r for r in fake_prometheus.requests if r.path == "/api/v1/series"]
    assert series.params["match[]"] == ['{__name__=~".+"}']
    lists = [r for r in fake_prometheus.requests if r.path.startswith("/api/v1/label")]
    assert lists and all("match[]" not in r.params for r in lists)


async def test_metadata_never_adds_names(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["up"]
    fake_prometheus.metadata = {
        "up": [{"type": "gauge", "help": "Up.", "unit": ""}],
        "secret_metric": [{"type": "counter", "help": "Team B's secret help.", "unit": "bytes"}],
    }
    cat = await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    assert [m.name for m in cat.metrics] == ["up"]
    text = json.dumps(asdict(cat))
    assert "secret_metric" not in text and "Team B's secret help." not in text


async def test_series_refused_keeps_the_metrics(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["http_requests_total", "up"]
    fake_prometheus.series = [{"__name__": "up", "job": "api"}]
    fake_prometheus.fail_paths["/api/v1/series"] = 422
    cat = await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    assert [m.name for m in cat.metrics] == ["http_requests_total", "up"]
    assert all(m.labels == () and m.series is None for m in cat.metrics)
    assert cat.notes == (NOTE_NO_SERIES,)


@pytest.mark.parametrize("code", ["too_large", "timeout"])
async def test_series_too_large_or_slow_keeps_the_metrics(fake_prometheus, direct, code):
    fake_prometheus.label_values["__name__"] = ["up"]
    t = Failing(direct(fake_prometheus.url), "/api/v1/series", code)
    cat = await PrometheusConnector().catalog(t, matchers=M, now=NOW)
    assert [(m.name, m.labels, m.series) for m in cat.metrics] == [("up", (), None)]
    assert cat.notes == (NOTE_NO_SERIES,)


async def test_an_unreachable_series_call_raises(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["up"]
    t = Failing(direct(fake_prometheus.url), "/api/v1/series", "unreachable")
    with pytest.raises(SourceUnreachable) as caught:
        await PrometheusConnector().catalog(t, matchers=M, now=NOW)
    assert caught.value.code == "unreachable"


async def test_a_series_error_answer_raises(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["up"]
    fake_prometheus.fail_paths["/api/v1/series"] = 500
    with pytest.raises(QueryRejected) as caught:
        await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    assert caught.value.code == "tool_error"


async def test_sampled_series_say_so(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["up"]
    fake_prometheus.series = [{"__name__": "up", "job": f"j{i}"} for i in range(5)]
    cat = await PrometheusConnector().catalog(
        direct(fake_prometheus.url), matchers=M, now=NOW, limits=CatalogLimits(series_sample=3)
    )
    [series] = [r for r in fake_prometheus.requests if r.path == "/api/v1/series"]
    assert series.params["limit"] == ["3"]
    assert cat.metrics[0].series == 3
    assert cat.notes == (NOTE_SERIES_SAMPLED,)


async def test_labels_per_metric_are_capped(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["wide"]
    fake_prometheus.series = [
        {"__name__": "wide", **{f"l{i:02}": "x" for i in range(60)}},
    ]
    cat = await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    assert cat.metrics[0].labels == tuple(f"l{i:02}" for i in range(50))


async def test_long_help_is_cut(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["up", "short"]
    fake_prometheus.metadata = {
        "up": [{"type": "gauge", "help": "h" * 250, "unit": ""}],
        "short": [{"type": "gauge", "help": "s" * 200, "unit": ""}],
    }
    cat = await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    by = {m.name: m for m in cat.metrics}
    assert by["up"].help == "h" * 199 + "…" and len(by["up"].help) == 200
    assert by["short"].help == "s" * 200


async def test_histogram_family_without_metadata(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = [
        "rpc_seconds_bucket",
        "rpc_seconds_count",
        "rpc_seconds_sum",
        "jobs_count",
        "plain_bucket",
    ]
    fake_prometheus.series = [
        {"__name__": "rpc_seconds_bucket", "le": "0.5", "method": "get"},
        {"__name__": "rpc_seconds_count", "method": "get"},
        {"__name__": "rpc_seconds_sum", "method": "get"},
        {"__name__": "jobs_count", "queue": "q"},
        {"__name__": "plain_bucket", "zone": "z"},
    ]
    cat = await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    by = {m.name: m for m in cat.metrics}
    for name in ("rpc_seconds_bucket", "rpc_seconds_count", "rpc_seconds_sum"):
        assert (by[name].type, by[name].family) == ("histogram", "rpc_seconds")
    assert (by["jobs_count"].type, by["jobs_count"].family) == (None, None)
    assert (by["plain_bucket"].type, by["plain_bucket"].family) == (None, None)


async def test_summary_base_joins_its_family(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = [
        "rpc_duration_seconds",
        "rpc_duration_seconds_count",
        "rpc_duration_seconds_sum",
        "native_seconds",
    ]
    fake_prometheus.metadata = {
        "rpc_duration_seconds": [{"type": "summary", "help": "RPC time.", "unit": ""}],
        "native_seconds": [{"type": "histogram", "help": "Native.", "unit": ""}],
    }
    cat = await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    by = {m.name: m for m in cat.metrics}
    for name in ("rpc_duration_seconds", "rpc_duration_seconds_count", "rpc_duration_seconds_sum"):
        assert (by[name].type, by[name].family) == ("summary", "rpc_duration_seconds")
    assert by["rpc_duration_seconds"].help == "RPC time."
    assert (by["native_seconds"].type, by["native_seconds"].family) == (
        "histogram",
        "native_seconds",
    )


async def test_a_suffixed_name_with_its_own_metadata_never_borrows_the_base(
    fake_prometheus, direct
):
    fake_prometheus.label_values["__name__"] = ["x_count"]
    fake_prometheus.metadata = {
        "x_count": [{"type": "gauge", "help": "", "unit": ""}],
        "x": [{"type": "summary", "help": "Team B's secret help.", "unit": "bytes"}],
    }
    cat = await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    [x] = cat.metrics
    assert (x.type, x.family, x.help, x.unit) == ("gauge", None, None, None)
    assert "Team B's secret help." not in json.dumps(asdict(cat))


async def test_a_suffixed_name_without_metadata_takes_only_the_base_type(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["x_count"]
    fake_prometheus.metadata = {
        "x": [{"type": "summary", "help": "Team B's secret help.", "unit": "bytes"}],
    }
    cat = await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    [x] = cat.metrics
    assert (x.type, x.family, x.help, x.unit) == ("summary", "x", None, None)
    text = json.dumps(asdict(cat))
    assert "Team B's secret help." not in text and "bytes" not in text


async def test_names_labels_and_metadata_are_read_together(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["up"]
    t = Counting(direct(fake_prometheus.url), ("/values", "/api/v1/labels", "/api/v1/metadata"))
    await PrometheusConnector().catalog(t, matchers=M, now=NOW)
    assert t.peak == 3


@pytest.mark.parametrize("code", ["too_large", "timeout"])
async def test_metadata_too_large_keeps_the_names(fake_prometheus, direct, code):
    fake_prometheus.label_values["__name__"] = ["up", "rpc_seconds_bucket", "rpc_seconds_sum"]
    fake_prometheus.series = [{"__name__": "rpc_seconds_bucket", "le": "1"}]
    t = Failing(direct(fake_prometheus.url), "/api/v1/metadata", code)
    cat = await PrometheusConnector().catalog(t, matchers=M, now=NOW)
    by = {m.name: m for m in cat.metrics}
    assert list(by) == ["up", "rpc_seconds_bucket", "rpc_seconds_sum"]
    assert (by["up"].type, by["up"].help) == (None, None)
    assert by["rpc_seconds_bucket"].type == "histogram"
    assert by["rpc_seconds_sum"].family == "rpc_seconds"
    assert cat.notes == ()


async def test_metadata_unreachable_still_raises(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["up"]
    t = Failing(direct(fake_prometheus.url), "/api/v1/metadata", "unreachable")
    with pytest.raises(SourceUnreachable):
        await PrometheusConnector().catalog(t, matchers=M, now=NOW)


async def test_many_metrics_say_so(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["a", "b", "c"]
    limits = CatalogLimits(max_metrics=2)
    cat = await PrometheusConnector().catalog(
        direct(fake_prometheus.url), matchers=M, now=NOW, limits=limits
    )
    assert [m.name for m in cat.metrics] == ["a", "b"]
    assert cat.notes == (NOTE_METRICS_TRUNCATED,)


async def test_a_long_label_list_alone_adds_no_note(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["a", "b"]
    fake_prometheus.labels = ["x", "y", "z"]
    limits = CatalogLimits(max_metrics=2)
    cat = await PrometheusConnector().catalog(
        direct(fake_prometheus.url), matchers=M, now=NOW, limits=limits
    )
    assert [m.name for m in cat.metrics] == ["a", "b"]
    assert cat.labels == ("x", "y")
    assert cat.notes == ()


async def test_a_refused_name_list_raises(fake_prometheus, direct):
    fake_prometheus.fail_paths["/api/v1/label/__name__/values"] = 500
    with pytest.raises(QueryRejected) as caught:
        await PrometheusConnector().catalog(direct(fake_prometheus.url), matchers=M, now=NOW)
    assert caught.value.code == "tool_error"
    assert caught.value.message == "The source answered HTTP 500. Try again, or check the tool."


async def test_a_tool_echoing_secrets_never_reaches_the_catalog_error(direct, caplog):
    from aiohttp import web

    from omnikrux.monitoring.sources.types import SourceSecrets
    from tests.monitoring.test_transport import serve

    bearer = "tok-1a2b3c4d5e6f"

    async def handler(request):
        echo = f"bad match; Authorization={request.headers.get('Authorization')} {bearer}"
        return web.Response(status=400, text=echo)

    async with serve(handler) as url:
        t = direct(url, auth_type="bearer", secrets=SourceSecrets(token=bearer))
        with pytest.raises(QueryRejected) as caught:
            await PrometheusConnector().catalog(t, matchers=M, now=NOW)
    for text in (caught.value.message, repr(caught.value), str(caught.value), caplog.text):
        assert bearer not in text
    assert "bad match" in caught.value.message


# --- Loki --------------------------------------------------------------------------------------


async def test_loki_catalog_lists_labels_and_values(fake_loki, direct):
    fake_loki.labels = ["namespace", "app", "__stream_shard__"]
    fake_loki.label_values = {"app": ["web", "api"], "namespace": ["demo"]}
    cat = await LokiConnector().catalog(direct(fake_loki.url, type="loki"), matchers=(), now=NOW)
    assert cat.streams == (
        StreamLabel("app", ("api", "web"), False),
        StreamLabel("namespace", ("demo",), False),
    )
    assert cat.labels == ("app", "namespace") and cat.metrics == () and cat.notes == ()
    sent = loki_requests(fake_loki)
    assert sent[0].path == "/loki/api/v1/labels"
    assert sorted(r.path for r in sent[1:]) == [
        "/loki/api/v1/label/app/values",
        "/loki/api/v1/label/namespace/values",
    ]
    start, end = str(int((NOW - 604800) * 1_000_000_000)), str(int(NOW * 1_000_000_000))
    for r in sent:
        assert r.params["start"] == [start] and r.params["end"] == [end]
        assert "query" not in r.params and "match[]" not in r.params


async def test_loki_values_are_capped(fake_loki, direct):
    fake_loki.labels = ["app", "pod"]
    fake_loki.label_values = {
        "app": [f"a{i:03}" for i in range(201)],
        "pod": [f"p{i:03}" for i in range(250)],
    }
    cat = await LokiConnector().catalog(direct(fake_loki.url, type="loki"), matchers=(), now=NOW)
    assert [(s.name, len(s.values), s.truncated) for s in cat.streams] == [
        ("app", 200, True),
        ("pod", 200, True),
    ]
    assert cat.streams[0].values == tuple(f"a{i:03}" for i in range(200))
    assert cat.notes == (NOTE_STREAM_VALUES_TRUNCATED,)


async def test_loki_labels_are_capped(fake_loki, direct):
    fake_loki.labels = [f"l{i:02}" for i in range(55)]
    cat = await LokiConnector().catalog(direct(fake_loki.url, type="loki"), matchers=(), now=NOW)
    assert cat.labels == tuple(f"l{i:02}" for i in range(50))
    assert len(cat.streams) == 50
    assert cat.notes == (NOTE_STREAM_LABELS_TRUNCATED,)
    assert len(loki_requests(fake_loki)) == 51


async def test_loki_values_are_read_six_at_a_time(fake_loki, direct):
    fake_loki.labels = [f"l{i:02}" for i in range(20)]
    t = Counting(direct(fake_loki.url, type="loki"))
    cat = await LokiConnector().catalog(t, matchers=(), now=NOW)
    assert len(cat.streams) == 20
    assert t.peak == 6


async def test_loki_catalog_with_matchers_reads_one_series_call(fake_loki, direct):
    fake_loki.series = [
        {"app": "web", "pod": "p2", "__stream_shard__": "1"},
        {"app": "api", "pod": "p1"},
        {"app": "web", "pod": "p1", "level": "error"},
    ]
    fake_loki.labels = ["team_b_only"]
    cat = await LokiConnector().catalog(direct(fake_loki.url, type="loki"), matchers=M, now=NOW)
    assert cat.streams == (
        StreamLabel("app", ("api", "web"), False),
        StreamLabel("level", ("error",), False),
        StreamLabel("pod", ("p1", "p2"), False),
    )
    assert cat.labels == ("app", "level", "pod") and cat.metrics == ()
    assert "team_b_only" not in json.dumps(asdict(cat))


async def test_loki_series_are_capped(fake_loki, direct):
    fake_loki.series = [{"app": f"a{i:04}"} for i in range(5003)]
    limits = CatalogLimits(max_stream_values=10_000)
    cat = await LokiConnector().catalog(
        direct(fake_loki.url, type="loki"), matchers=M, now=NOW, limits=limits
    )
    assert len(cat.streams[0].values) == 5000


async def test_loki_series_caps_labels_and_values(fake_loki, direct):
    fake_loki.series = [
        {**{f"l{i:02}": "x" for i in range(52)}, "app": f"a{j:03}"} for j in range(205)
    ]
    cat = await LokiConnector().catalog(direct(fake_loki.url, type="loki"), matchers=M, now=NOW)
    assert len(cat.labels) == 50 and cat.labels[0] == "app"
    assert cat.streams[0] == StreamLabel("app", tuple(f"a{j:03}" for j in range(200)), True)
    assert cat.notes == (NOTE_STREAM_LABELS_TRUNCATED, NOTE_STREAM_VALUES_TRUNCATED)


async def test_a_refused_loki_lookup_raises(fake_loki, direct):
    fake_loki.labels = ["app"]
    fake_loki.fail_paths["/loki/api/v1/label/app/values"] = 500
    with pytest.raises(QueryRejected):
        await LokiConnector().catalog(direct(fake_loki.url, type="loki"), matchers=(), now=NOW)


# --- Both --------------------------------------------------------------------------------------


@pytest.mark.parametrize("type", ["prometheus", "loki"])
async def test_unreachable_source_raises(direct, type):
    connector = PrometheusConnector() if type == "prometheus" else LokiConnector()
    t = direct("http://127.0.0.1:9", type=type)
    for matchers in ((), M):
        with pytest.raises(SourceUnreachable) as caught:
            await connector.catalog(t, matchers=matchers, now=NOW)
        assert caught.value.code == "unreachable"
