"""The connector for Loki."""

import asyncio
import re
from collections.abc import Sequence
from decimal import Decimal
from urllib.parse import quote

from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.filters import inject_logql, render_matchers
from omnikrux.monitoring.query.series import QueryResult, series_result, streams_result
from omnikrux.monitoring.sources.connector import (
    DEFAULT_LIMITS,
    NOT_LIKE,
    NOTE_STREAM_LABELS_TRUNCATED,
    NOTE_STREAM_VALUES_TRUNCATED,
    RULER_OFF,
    AlertingCapability,
    CatalogLimits,
    ClusterProbe,
    ConnectorQuery,
    FieldCatalog,
    QueryRejected,
    SourceCatalog,
    StreamLabel,
    TestResult,
    checked_json,
    gather_all,
    json_object,
    number_text,
    status_message,
)
from omnikrux.monitoring.sources.transport import SourceTransport, SourceUnreachable
from omnikrux.monitoring.sources.types import SourceConfig

PROBE_SECONDS = 10.0
# What Loki's ruler answers (with a 404) to a list of rules when it holds none.
EMPTY_RULER = b"no rule groups found"
QUERY_SECONDS = 30.0
WHAT = "a Loki server"
VALUE_CALLS_AT_ONCE = 6
# A label name as LogQL reads it in a stream selector.
LABEL_NAME = re.compile(r"[a-zA-Z_][a-zA-Z0-9_]*")


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

    async def label_names(
        self,
        t: SourceTransport,
        *,
        matchers: Sequence[Matcher],
        start: float,
        end: float,
    ) -> list[str]:
        """The label names of the streams between `start` and `end` (seconds), sorted, without
        Loki's own (`__…`). With `matchers`, only the streams they select count (one `/series`
        call, so nothing outside the filter is asked for); without, every stream's."""
        window = [("start", _nanoseconds(start)), ("end", _nanoseconds(end))]
        if matchers:
            got = await t.request(
                "GET",
                "/loki/api/v1/series",
                params=[("match[]", _selector(matchers)), *window],
                timeout=PROBE_SECONDS,
            )
            data = checked_json(got, "The source", WHAT).get("data")
            names: set[str] = set()
            for entry in data if isinstance(data, list) else []:
                if isinstance(entry, dict):
                    names.update(str(k) for k in entry)
        else:
            names = set(await self._list(t, "/loki/api/v1/labels", window))
        # Only names Loki would accept in a selector: they are written into queries as they are.
        return sorted(n for n in names if LABEL_NAME.fullmatch(n) and not n.startswith("__"))

    async def catalog(
        self,
        t: SourceTransport,
        *,
        matchers: Sequence[Matcher],
        now: float,
        limits: CatalogLimits = DEFAULT_LIMITS,
    ) -> SourceCatalog:
        window = [
            ("start", _nanoseconds(now - limits.stream_window)),
            ("end", _nanoseconds(now)),
        ]
        if matchers:
            values = await self._series_values(t, matchers, window, limits)
            names = sorted(n for n in values if not n.startswith("__"))
        else:
            listed = await self._list(t, "/loki/api/v1/labels", window)
            names = sorted({n for n in listed if not n.startswith("__")})
        cut = len(names) > limits.max_stream_labels
        names = names[: limits.max_stream_labels]
        if not matchers:
            values = await self._values_of(t, names, window)
        streams = []
        for name in names:
            found = sorted(values[name])
            streams.append(
                StreamLabel(
                    name,
                    tuple(found[: limits.max_stream_values]),
                    len(found) > limits.max_stream_values,
                )
            )
        notes = [NOTE_STREAM_LABELS_TRUNCATED] if cut else []
        if any(s.truncated for s in streams):
            notes.append(NOTE_STREAM_VALUES_TRUNCATED)
        return SourceCatalog((), tuple(names), tuple(streams), tuple(notes))

    async def _series_values(
        self,
        t: SourceTransport,
        matchers: Sequence[Matcher],
        window: list[tuple[str, str]],
        limits: CatalogLimits,
    ) -> dict[str, set[str]]:
        """Label name -> values, from the label sets of the streams the filter selects: one call,
        so nothing outside the filter is ever asked for."""
        got = await t.request(
            "GET",
            "/loki/api/v1/series",
            params=[("match[]", _selector(matchers)), *window],
            timeout=PROBE_SECONDS,
        )
        data = checked_json(got, "The source", WHAT).get("data")
        entries = [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []
        values: dict[str, set[str]] = {}
        for entry in entries[: limits.max_stream_series]:
            for key, value in entry.items():
                values.setdefault(str(key), set()).add(str(value))
        return values

    async def _values_of(
        self, t: SourceTransport, names: list[str], window: list[tuple[str, str]]
    ) -> dict[str, set[str]]:
        """Label name -> values, for a project with no filter; a few calls at a time."""
        gate = asyncio.Semaphore(VALUE_CALLS_AT_ONCE)

        async def values_of(name: str) -> set[str]:
            async with gate:
                path = f"/loki/api/v1/label/{quote(name, safe='')}/values"
                return set(await self._list(t, path, window))

        found = await gather_all([values_of(name) for name in names])
        return dict(zip(names, found, strict=True))

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
        self,
        t: SourceTransport,
        *,
        cluster: ClusterProbe | None,
        source: SourceConfig | None = None,
    ) -> AlertingCapability:
        got = await t.request("GET", "/loki/api/v1/rules", timeout=PROBE_SECONDS)
        # A ruler that holds no rule yet answers 404 "no rule groups found", not 200: it is on.
        empty = got.status == 404 and got.body.strip().lower() == EMPTY_RULER
        if got.status == 200 or empty:
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
