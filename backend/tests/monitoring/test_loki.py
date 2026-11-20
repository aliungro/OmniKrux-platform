"""The Loki connector, against the real local fake through a direct transport."""

import pytest

from omnikrux.monitoring.query.filters import Matcher
from omnikrux.monitoring.sources.connector import ConnectorQuery, QueryRejected, TestResult
from omnikrux.monitoring.sources.loki import LokiConnector
from tests.monitoring.test_prometheus import Canned

NAME = "Loki · test"
A = [Matcher("cluster", "=", "a")]


async def test_loki_test_reports_version(fake_loki, direct):
    connector, t = LokiConnector(), direct(fake_loki.url, "loki", NAME)
    assert await connector.test(t, NAME) == TestResult(True, "3.3.0", None)
    fake_loki.mode = "no_buildinfo"
    assert await connector.test(t, NAME) == TestResult(True, None, None)
    fake_loki.mode = "not_prometheus"
    got = await connector.test(t, NAME)
    assert got == TestResult(
        False, None, f"{NAME} answered, but not like a Loki server. Check the address and its path."
    )


async def test_loki_streams_and_metrics(fake_loki, direct):
    fake_loki.results['{app="x"}'] = {
        "resultType": "streams",
        "result": [{"stream": {"app": "x"}, "values": [["1700000000000000000", "hello"]]}],
    }
    fake_loki.results['rate({app="x"}[1m])'] = {
        "resultType": "matrix",
        "result": [{"metric": {"app": "x"}, "values": [[1_700_000_000, "0.5"]]}],
    }
    connector, t = LokiConnector(), direct(fake_loki.url, "loki", NAME)
    query = ConnectorQuery(
        "range", '{app="x"}', start=1, end=2, step=1, limit=50, direction="forward"
    )
    logs = await connector.query(t, query, NAME)
    assert logs.result_type == "streams"
    assert logs.streams[0].labels == {"app": "x"}
    assert logs.streams[0].entries == [("1700000000000000000", "hello")]
    sent = fake_loki.requests[-1]
    assert sent.path == "/loki/api/v1/query_range"
    assert sent.params["limit"] == ["50"] and sent.params["direction"] == ["forward"]
    metric = await connector.query(t, ConnectorQuery("range", 'rate({app="x"}[1m])'), NAME)
    assert metric.result_type == "matrix"
    assert metric.series[0].labels == {"app": "x"}
    assert metric.series[0].points == [(1_700_000_000.0, 0.5)]


async def test_loki_fields_with_and_without_matchers(fake_loki, direct):
    fake_loki.labels = ["app", "namespace"]
    connector, t = LokiConnector(), direct(fake_loki.url, "loki", NAME)
    plain = await connector.describe_fields(t, matchers=())
    assert plain.metrics == () and plain.labels == ("app", "namespace")
    assert fake_loki.requests[-1].path == "/loki/api/v1/labels"
    filtered = await connector.describe_fields(t, matchers=A)
    assert fake_loki.requests[-1].path == "/loki/api/v1/series"
    assert fake_loki.requests[-1].params["match[]"] == ['{cluster="a"}']
    assert filtered.metrics == ()


async def test_loki_series_labels_are_collected():
    body = b'{"status":"success","data":[{"app":"x","pod":"p1"},{"app":"y","env":"e"}]}'
    got = await LokiConnector().describe_fields(Canned(200, body), matchers=A)
    assert got.labels == ("app", "env", "pod")


async def test_loki_label_values(fake_loki, direct):
    fake_loki.label_values["app"] = ["x", "y", "z"]
    got = await LokiConnector().label_values(
        direct(fake_loki.url, "loki", NAME), "app", matchers=A, limit=2
    )
    assert got == ["x", "y"]
    assert fake_loki.requests[-1].params["query"] == ['{cluster="a"}']


async def test_loki_alerting_follows_ruler(fake_loki, direct):
    connector, t = LokiConnector(), direct(fake_loki.url, "loki", NAME)
    on = await connector.alerting(t, cluster=None)
    assert (on.omnikrux_engine, on.tool_engine, on.reason) == (True, "loki_ruler", None)
    fake_loki.ruler = False
    off = await connector.alerting(t, cluster=None)
    assert (off.omnikrux_engine, off.tool_engine, off.reason) == (
        True,
        None,
        "This Loki doesn't have its ruler turned on.",
    )


@pytest.mark.parametrize("status", [400, 422])
async def test_loki_refuses_with_plain_text(status):
    with pytest.raises(QueryRejected) as caught:
        await LokiConnector().query(
            Canned(status, b"parse error at line 1, col 1: bad"),
            ConnectorQuery("instant", "{"),
            NAME,
        )
    assert caught.value.code == "bad_query"
    assert caught.value.message == "parse error at line 1, col 1: bad"
