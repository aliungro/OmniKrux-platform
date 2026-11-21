"""The connector for Loki."""

from collections.abc import Sequence
from decimal import Decimal
from urllib.parse import quote

from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.filters import inject_logql, render_matchers
from omnikrux.monitoring.query.series import QueryResult, series_result, streams_result
from omnikrux.monitoring.sources.connector import (
    NOT_LIKE,
    RULER_OFF,
    AlertingCapability,
    ClusterProbe,
    ConnectorQuery,
    FieldCatalog,
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
WHAT = "a Loki server"


class LokiConnector:
    type = "loki"
    label = "Loki"
    language = "logql"

    async def test(self, t: SourceTransport, name: str) -> TestResult:
        try:
            return await self._test(t, name)
        except SourceUnreachable as exc:
            return TestResult(False, None, exc.message)

    async def _test(self, t: SourceTransport, name: str) -> TestResult:
        got = await t.request("GET", "/loki/api/v1/status/buildinfo", timeout=PROBE_SECONDS)
        if got.status == 404:
            ready = await t.request("GET", "/ready", timeout=PROBE_SECONDS)
            if ready.status != 200:
                return TestResult(False, None, status_message(name, ready.status))
            if ready.body.strip().lower() != b"ready":
                return TestResult(False, None, NOT_LIKE.format(name=name, what=WHAT))
            return TestResult(True, None, None)
        if got.status != 200:
            return TestResult(False, None, status_message(name, got.status))
        data = json_object(got.body)
        if data is None:
            return TestResult(False, None, NOT_LIKE.format(name=name, what=WHAT))
        version = data.get("version")
        return TestResult(True, version if isinstance(version, str) else None, None)

    async def query(self, t: SourceTransport, q: ConnectorQuery, name: str) -> QueryResult:
        params = [("query", q.query)]
        if q.kind == "instant":
            path = "/loki/api/v1/query"
            if q.time is not None:
                params.append(("time", number_text(q.time)))
        else:
            path = "/loki/api/v1/query_range"
            for key, value in (("start", q.start), ("end", q.end), ("step", q.step)):
                if value is not None:
                    params.append((key, number_text(value)))
        if q.limit is not None:
            params.append(("limit", str(q.limit)))
        params.append(("direction", q.direction))
        got = await t.request("GET", path, params=params, timeout=QUERY_SECONDS)
        body = checked_json(got, name, WHAT)
        data = body.get("data")
        if body.get("status") != "success" or not isinstance(data, dict):
            raise QueryRejected("tool_error", NOT_LIKE.format(name=name, what=WHAT), 502)
        warnings = [str(w) for w in body.get("warnings") or []]
        try:
            if data.get("resultType") == "streams":
                return streams_result(data, warnings)
            return series_result(data, warnings)
        except ValueError:
            raise QueryRejected("tool_error", NOT_LIKE.format(name=name, what=WHAT), 502) from None

    async def describe_fields(
        self, t: SourceTransport, *, matchers: Sequence[Matcher], limit: int = 2000
    ) -> FieldCatalog:
        if matchers:
            got = await t.request(
                "GET",
                "/loki/api/v1/series",
                params=[("match[]", _selector(matchers))],
                timeout=PROBE_SECONDS,
            )
            data = checked_json(got, "The source", WHAT).get("data")
            keys: set[str] = set()
            for entry in data if isinstance(data, list) else []:
                if isinstance(entry, dict):
                    keys.update(str(k) for k in entry)
            labels = sorted(keys)
        else:
            labels = await self._list(t, "/loki/api/v1/labels", [])
        return FieldCatalog((), tuple(labels[:limit]), len(labels) > limit)

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
            params = [("query", inject_logql(selector, matchers))]
        else:
            params = [("query", _selector(matchers))] if matchers else []
        for key, value in (("start", start), ("end", end)):
            if value is not None:
                params.append((key, _nanoseconds(value)))
        path = f"/loki/api/v1/label/{quote(label, safe='')}/values"
        return (await self._list(t, path, params))[:limit]

    async def alerting(
        self, t: SourceTransport, *, cluster: ClusterProbe | None
    ) -> AlertingCapability:
        got = await t.request("GET", "/loki/api/v1/rules", timeout=PROBE_SECONDS)
        if got.status == 200:
            return AlertingCapability(True, "loki_ruler", None)
        return AlertingCapability(True, None, RULER_OFF)

    async def _list(
        self, t: SourceTransport, path: str, params: list[tuple[str, str]]
    ) -> list[str]:
        got = await t.request("GET", path, params=params, timeout=PROBE_SECONDS)
        data = checked_json(got, "The source", WHAT).get("data")
        return [str(item) for item in data] if isinstance(data, list) else []


def _selector(matchers: Sequence[Matcher]) -> str:
    return "{" + render_matchers(matchers) + "}"


def _nanoseconds(seconds: float) -> str:
    """Seconds as the whole nanoseconds Loki's label endpoints read, exactly (no float error)."""
    return str(int(Decimal(repr(seconds)) * 1_000_000_000))
