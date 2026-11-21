"""The connector for Prometheus and the tools that speak its API (Thanos, VictoriaMetrics, Mimir)."""

from collections.abc import Sequence
from urllib.parse import quote

from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.filters import inject_promql, render_matchers
from omnikrux.monitoring.query.series import QueryResult, series_result
from omnikrux.monitoring.sources.connector import (
    NO_OPERATOR,
    NOT_LIKE,
    AlertingCapability,
    ClusterProbe,
    ConnectorQuery,
    FieldCatalog,
    MetricField,
    QueryRejected,
    TestResult,
    checked_json,
    json_object,
    number_text,
    status_message,
)
from omnikrux.monitoring.sources.transport import SourceTransport, SourceUnreachable

PROBE_SECONDS = 10.0
QUERY_SECONDS = 30.0
WHAT = "a Prometheus-compatible server"


class PrometheusConnector:
    type = "prometheus"
    label = "Prometheus-compatible"
    language = "promql"

    async def test(self, t: SourceTransport, name: str) -> TestResult:
        try:
            return await self._test(t, name)
        except SourceUnreachable as exc:
            return TestResult(False, None, exc.message)

    async def _test(self, t: SourceTransport, name: str) -> TestResult:
        got = await t.request("GET", "/api/v1/status/buildinfo", timeout=PROBE_SECONDS)
        version = None
        if got.status == 404:  # Thanos, VictoriaMetrics and Mimir have no build info
            got = await t.request(
                "GET", "/api/v1/query", params=[("query", "1")], timeout=PROBE_SECONDS
            )
        elif got.status == 200:
            data = json_object(got.body)
            info = data.get("data") if data is not None else None
            if isinstance(info, dict) and isinstance(info.get("version"), str):
                version = info["version"]
        if got.status != 200:
            return TestResult(False, None, status_message(name, got.status))
        data = json_object(got.body)
        if data is None or data.get("status") != "success":
            return TestResult(False, None, NOT_LIKE.format(name=name, what=WHAT))
        return TestResult(True, version, None)

    async def query(self, t: SourceTransport, q: ConnectorQuery, name: str) -> QueryResult:
        params = [("query", q.query)]
        if q.kind == "instant":
            path = "/api/v1/query"
            if q.time is not None:
                params.append(("time", number_text(q.time)))
        else:
            path = "/api/v1/query_range"
            for key, value in (("start", q.start), ("end", q.end), ("step", q.step)):
                if value is not None:
                    params.append((key, number_text(value)))
        got = await t.request("GET", path, params=params, timeout=QUERY_SECONDS)
        body = checked_json(got, name, WHAT)
        data = body.get("data")
        if body.get("status") != "success" or not isinstance(data, dict):
            raise QueryRejected("tool_error", NOT_LIKE.format(name=name, what=WHAT), 502)
        warnings = [str(w) for w in body.get("warnings") or []]
        try:
            return series_result(data, warnings)
        except ValueError:
            raise QueryRejected("tool_error", NOT_LIKE.format(name=name, what=WHAT), 502) from None

    async def describe_fields(
        self, t: SourceTransport, *, matchers: Sequence[Matcher], limit: int = 2000
    ) -> FieldCatalog:
        params = _match(matchers)
        names = await self._list(t, "/api/v1/label/__name__/values", params)
        labels = await self._list(t, "/api/v1/labels", params)
        metadata = await self._metadata(t)
        metrics = []
        for metric in names[:limit]:
            entry = metadata.get(metric) or {}
            metrics.append(
                MetricField(
                    metric, _text(entry, "type"), _text(entry, "help"), _text(entry, "unit")
                )
            )
        truncated = len(names) > limit or len(labels) > limit
        return FieldCatalog(tuple(metrics), tuple(labels[:limit]), truncated)

    async def label_values(
        self,
        t: SourceTransport,
        label: str,
        *,
        matchers: Sequence[Matcher],
        limit: int = 1000,
        selector: str | None = None,
        start: float | None = None,
        end: float | None = None,
    ) -> list[str]:
        if selector is not None:
            params = [("match[]", inject_promql(selector, matchers))]
        else:
            params = _match(matchers)
        for key, value in (("start", start), ("end", end)):
            if value is not None:
                params.append((key, number_text(value)))
        path = f"/api/v1/label/{quote(label, safe='')}/values"
        return (await self._list(t, path, params))[:limit]

    async def alerting(
        self, t: SourceTransport, *, cluster: ClusterProbe | None
    ) -> AlertingCapability:
        if cluster is not None and await cluster.serves(
            "monitoring.coreos.com", "v1", "prometheusrules"
        ):
            return AlertingCapability(True, "prometheus_rule", None)
        return AlertingCapability(True, None, NO_OPERATOR)

    async def _list(
        self, t: SourceTransport, path: str, params: list[tuple[str, str]]
    ) -> list[str]:
        got = await t.request("GET", path, params=params, timeout=PROBE_SECONDS)
        data = checked_json(got, "The source", WHAT).get("data")
        return [str(item) for item in data] if isinstance(data, list) else []

    async def _metadata(self, t: SourceTransport) -> dict[str, dict]:
        """Metric name -> its first metadata entry; empty when the tool has none to give."""
        got = await t.request("GET", "/api/v1/metadata", timeout=PROBE_SECONDS)
        data = json_object(got.body) if got.status == 200 else None
        raw = data.get("data") if data is not None else None
        if not isinstance(raw, dict):
            return {}
        return {
            name: entries[0]
            for name, entries in raw.items()
            if isinstance(entries, list) and entries and isinstance(entries[0], dict)
        }


def _match(matchers: Sequence[Matcher]) -> list[tuple[str, str]]:
    return [("match[]", "{" + render_matchers(matchers) + "}")] if matchers else []


def _text(entry: dict, key: str) -> str | None:
    value = entry.get(key)
    return value if isinstance(value, str) and value else None
