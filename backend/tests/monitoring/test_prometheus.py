"""The Prometheus connector, against the real local fake through a direct transport."""

import pytest

from omnikrux.monitoring.query.filters import Matcher
from omnikrux.monitoring.query.series import MAX_SERIES, TRUNCATED_WARNING
from omnikrux.monitoring.sources.connector import ConnectorQuery, QueryRejected, TestResult
from omnikrux.monitoring.sources.prometheus import PrometheusConnector
from omnikrux.monitoring.sources.transport import SourceUnreachable, TransportResponse

NAME = "Prometheus · test"


class Canned:
    """A transport that answers every request the same, as a cluster's service proxy would."""

    def __init__(self, status: int, body: bytes = b"") -> None:
        self.answer = TransportResponse(status, body, "")

    async def request(self, method, path, **kwargs):
        return self.answer


class Probe:
    def __init__(self, answer: bool) -> None:
        self.answer = answer
        self.asked: list[tuple[str, str, str]] = []

    async def serves(self, group: str, version: str, plural: str) -> bool:
        self.asked.append((group, version, plural))
        return self.answer


async def test_prometheus_test_reports_version(fake_prometheus, direct):
    connector = PrometheusConnector()
    t = direct(fake_prometheus.url, name=NAME)
    assert await connector.test(t, NAME) == TestResult(True, "3.1.0", None)
    fake_prometheus.mode = "no_buildinfo"
    assert await connector.test(t, NAME) == TestResult(True, None, None)
    fake_prometheus.mode = "not_prometheus"
    assert await connector.test(t, NAME) == TestResult(
        False,
        None,
        f"{NAME} answered, but not like a Prometheus-compatible server. "
        "Check the address and its path.",
    )


async def test_prometheus_test_reports_what_the_tool_answered(fake_prometheus, direct):
    fake_prometheus.mode = "error500"
    got = await PrometheusConnector().test(direct(fake_prometheus.url, name=NAME), NAME)
    assert got == TestResult(
        False, None, f"{NAME} answered HTTP 500. Try again, or check the tool."
    )


async def test_prometheus_test_returns_the_transports_message_when_unreachable(direct):
    got = await PrometheusConnector().test(direct("http://127.0.0.1:9", name=NAME), NAME)
    assert got.ok is False and got.version is None
    assert got.message and NAME in got.message


async def test_other_calls_raise_when_unreachable(direct):
    connector = PrometheusConnector()
    t = direct("http://127.0.0.1:9", name=NAME)
    with pytest.raises(SourceUnreachable):
        await connector.query(t, ConnectorQuery("instant", "up"), NAME)
    with pytest.raises(SourceUnreachable):
        await connector.describe_fields(t, matchers=())
    with pytest.raises(SourceUnreachable):
        await connector.label_values(t, "job", matchers=())


async def test_prometheus_range_query_becomes_series(fake_prometheus, direct):
    t0 = 1_700_000_000.0
    fake_prometheus.results["up"] = {
        "resultType": "matrix",
        "result": [
            {
                "metric": {"job": "api"},
                "values": [[t0, "1"], [t0 + 15, "NaN"], [t0 + 30, "+Inf"]],
            }
        ],
    }
    query = ConnectorQuery("range", "up", start=t0, end=t0 + 30, step=15)
    got = await PrometheusConnector().query(direct(fake_prometheus.url, name=NAME), query, NAME)
    assert got.result_type == "matrix"
    assert len(got.series) == 1
    assert got.series[0].labels == {"job": "api"}
    assert got.series[0].points == [(t0, 1.0), (t0 + 15, None), (t0 + 30, None)]
    request = fake_prometheus.requests[-1]
    assert request.path == "/api/v1/query_range"
    assert request.params["step"] == ["15"]


async def test_prometheus_instant_vector_and_scalar(fake_prometheus, direct):
    fake_prometheus.results["up"] = {
        "resultType": "vector",
        "result": [{"metric": {"job": "a"}, "value": [1_700_000_000, "2"]}],
    }
    fake_prometheus.results["1"] = {"resultType": "scalar", "result": [1_700_000_000, "1"]}
    connector, t = PrometheusConnector(), direct(fake_prometheus.url, name=NAME)
    vector = await connector.query(t, ConnectorQuery("instant", "up", time=1_700_000_000), NAME)
    assert vector.result_type == "vector"
    assert vector.series[0].points == [(1_700_000_000.0, 2.0)]
    scalar = await connector.query(t, ConnectorQuery("instant", "1"), NAME)
    assert scalar.result_type == "scalar"
    assert scalar.series[0].points == [(1_700_000_000.0, 1.0)]


async def test_prometheus_bad_query_is_plain(fake_prometheus, direct):
    fake_prometheus.errors["up{"] = "parse error at char 4: unexpected end of input"
    with pytest.raises(QueryRejected) as caught:
        await PrometheusConnector().query(
            direct(fake_prometheus.url, name=NAME), ConnectorQuery("instant", "up{"), NAME
        )
    assert caught.value.code == "bad_query"
    assert caught.value.status == 400
    assert caught.value.message == "parse error at char 4: unexpected end of input"


async def test_a_refusal_with_an_empty_body_still_reads_plainly():
    with pytest.raises(QueryRejected) as caught:
        await PrometheusConnector().query(Canned(400), ConnectorQuery("instant", "up{"), NAME)
    assert caught.value.code == "bad_query"
    assert caught.value.message == f"{NAME} couldn't run that query."


async def test_a_long_tool_error_is_capped(fake_prometheus, direct):
    fake_prometheus.errors["up{"] = "x" * 1000
    with pytest.raises(QueryRejected) as caught:
        await PrometheusConnector().query(
            direct(fake_prometheus.url, name=NAME), ConnectorQuery("instant", "up{"), NAME
        )
    assert caught.value.message == "x" * 300


async def test_tool_errors(fake_prometheus, direct):
    fake_prometheus.mode = "error500"
    with pytest.raises(QueryRejected) as caught:
        await PrometheusConnector().query(
            direct(fake_prometheus.url, name=NAME), ConnectorQuery("instant", "up"), NAME
        )
    assert (caught.value.code, caught.value.status) == ("tool_error", 502)
    assert caught.value.message == f"{NAME} answered HTTP 500. Try again, or check the tool."


@pytest.mark.parametrize("status", [401, 403])
async def test_rejected_credentials_through_a_proxy(status):
    # A direct transport raises for these itself; through a cluster they arrive as an answer.
    with pytest.raises(QueryRejected) as caught:
        await PrometheusConnector().query(Canned(status), ConnectorQuery("instant", "up"), NAME)
    assert caught.value.code == "unauthorized"
    assert caught.value.message == (
        f"{NAME} rejected the credentials (HTTP {status}). Check the source's authentication."
    )


async def test_series_beyond_2000_are_truncated(fake_prometheus, direct):
    fake_prometheus.results["many"] = {
        "resultType": "vector",
        "result": [
            {"metric": {"i": str(i)}, "value": [1_700_000_000, "1"]} for i in range(MAX_SERIES + 1)
        ],
    }
    got = await PrometheusConnector().query(
        direct(fake_prometheus.url, name=NAME), ConnectorQuery("instant", "many"), NAME
    )
    assert len(got.series) == 2000
    assert got.truncated is True
    assert got.warnings == [TRUNCATED_WARNING] == ["Showing the first 2000 series."]


async def test_prometheus_fields_respect_matchers(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["http_requests_total", "up"]
    fake_prometheus.labels = ["__name__", "cluster", "job"]
    fake_prometheus.metadata = {
        "http_requests_total": [{"type": "counter", "help": "Requests.", "unit": ""}],
    }
    got = await PrometheusConnector().describe_fields(
        direct(fake_prometheus.url, name=NAME), matchers=[Matcher("cluster", "=", "a")]
    )
    by_name = {m.name: m for m in got.metrics}
    assert by_name["http_requests_total"].type == "counter"
    assert by_name["http_requests_total"].help == "Requests."
    assert by_name["http_requests_total"].unit is None
    assert by_name["up"].type is None
    assert got.labels == ("__name__", "cluster", "job")
    assert got.truncated is False
    matched = [
        r
        for r in fake_prometheus.requests
        if r.path in ("/api/v1/labels", "/api/v1/label/__name__/values")
    ]
    assert len(matched) == 2
    assert all(r.params["match[]"] == ['{cluster="a"}'] for r in matched)


async def test_prometheus_fields_without_matchers_send_no_match(fake_prometheus, direct):
    await PrometheusConnector().describe_fields(direct(fake_prometheus.url, name=NAME), matchers=())
    assert all("match[]" not in r.params for r in fake_prometheus.requests)


async def test_prometheus_fields_truncate_at_the_limit(fake_prometheus, direct):
    fake_prometheus.label_values["__name__"] = ["a", "b", "c"]
    got = await PrometheusConnector().describe_fields(
        direct(fake_prometheus.url, name=NAME), matchers=(), limit=2
    )
    assert [m.name for m in got.metrics] == ["a", "b"]
    assert got.truncated is True


async def test_prometheus_label_values(fake_prometheus, direct):
    fake_prometheus.label_values["job"] = ["api", "db", "web"]
    got = await PrometheusConnector().label_values(
        direct(fake_prometheus.url, name=NAME),
        "job",
        matchers=[Matcher("cluster", "=", "a")],
        limit=2,
    )
    assert got == ["api", "db"]
    assert fake_prometheus.requests[-1].params["match[]"] == ['{cluster="a"}']


async def test_prometheus_alerting_needs_operator(fake_prometheus, direct):
    connector, t = PrometheusConnector(), direct(fake_prometheus.url, name=NAME)
    reason = (
        "Rules can run in the tool only for a Prometheus run by the Prometheus Operator "
        "in a known cluster."
    )
    no = await connector.alerting(t, cluster=Probe(False))
    assert (no.omnikrux_engine, no.tool_engine, no.reason) == (True, None, reason)
    none = await connector.alerting(t, cluster=None)
    assert (none.omnikrux_engine, none.tool_engine, none.reason) == (True, None, reason)
    probe = Probe(True)
    yes = await connector.alerting(t, cluster=probe)
    assert (yes.omnikrux_engine, yes.tool_engine, yes.reason) == (True, "prometheus_rule", None)
    assert probe.asked == [("monitoring.coreos.com", "v1", "prometheusrules")]
