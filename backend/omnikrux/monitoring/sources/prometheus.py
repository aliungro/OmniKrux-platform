"""The connector for Prometheus and the tools that speak its API (Thanos, VictoriaMetrics, Mimir)."""

from collections.abc import Sequence
from dataclasses import replace
from urllib.parse import quote

from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.filters import inject_promql, render_matchers
from omnikrux.monitoring.query.series import QueryResult, series_result
from omnikrux.monitoring.sources.connector import (
    DEFAULT_LIMITS,
    NO_OPERATOR,
    NOT_LIKE,
    NOTE_METRICS_TRUNCATED,
    NOTE_NO_SERIES,
    NOTE_SERIES_SAMPLED,
    AlertingCapability,
    CatalogLimits,
    CatalogMetric,
    ClusterProbe,
    ConnectorQuery,
    FieldCatalog,
    MetricField,
    QueryRejected,
    SourceCatalog,
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
ALL_SERIES = '{__name__=~".+"}'
FAMILY_TYPES = ("histogram", "gaugehistogram", "summary")
FAMILY_SUFFIXES = ("_bucket", "_sum", "_count", "_created")

# Metric name -> (its label names, its series count) from the series sample.
PerMetric = dict[str, tuple[tuple[str, ...], int]]


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

    async def catalog(
        self,
        t: SourceTransport,
        *,
        matchers: Sequence[Matcher],
        now: float,
        limits: CatalogLimits = DEFAULT_LIMITS,
    ) -> SourceCatalog:
        params = _match(matchers)
        names = await self._list(t, "/api/v1/label/__name__/values", params)
        labels = await self._list(t, "/api/v1/labels", params)
        metadata = await self._metadata_or_empty(t)
        notes: list[str] = []
        if len(names) > limits.max_metrics:  # a long label list alone isn't worth a note
            notes.append(NOTE_METRICS_TRUNCATED)
        names = names[: limits.max_metrics]
        sample = await self._series_sample(t, matchers, now, limits)
        per_metric: PerMetric = {}
        if sample is None:
            notes.append(NOTE_NO_SERIES)
        else:
            series, full = sample
            if full:
                notes.append(NOTE_SERIES_SAMPLED)
            per_metric = _labels_per_metric(series, limits.max_labels_per_metric)
        metrics = []
        for name in names:
            # Only names the filtered list returned are looked up: metadata is read whole, and
            # nothing else in it may reach the project.
            kind, family, entry = _family(name, metadata, per_metric)
            metric_labels, count = per_metric.get(name, ((), 0))
            metrics.append(
                CatalogMetric(
                    name=name,
                    type=kind,
                    help=_cut(_text(entry, "help"), limits.max_help),
                    unit=_text(entry, "unit"),
                    labels=metric_labels,
                    series=None if sample is None else count,
                    family=family,
                )
            )
        return SourceCatalog(
            tuple(_follow_buckets(metrics)),
            tuple(labels[: limits.max_metrics]),
            (),
            tuple(notes),
        )

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

    async def _metadata(
        self, t: SourceTransport, params: Sequence[tuple[str, str]] = ()
    ) -> dict[str, dict]:
        """Metric name -> its first metadata entry; empty when the tool has none to give."""
        got = await t.request("GET", "/api/v1/metadata", params=list(params), timeout=PROBE_SECONDS)
        data = json_object(got.body) if got.status == 200 else None
        raw = data.get("data") if data is not None else None
        if not isinstance(raw, dict):
            return {}
        return {
            name: entries[0]
            for name, entries in raw.items()
            if isinstance(entries, list) and entries and isinstance(entries[0], dict)
        }

    async def _metadata_or_empty(self, t: SourceTransport) -> dict[str, dict]:
        """Metadata for a catalog. An answer too large or too slow to read means none: types then
        come only from the family rule. The endpoint takes no `match[]`."""
        try:
            return await self._metadata(t, [("limit_per_metric", "1")])
        except SourceUnreachable as exc:
            if exc.code in ("too_large", "timeout"):
                return {}
            raise

    async def _series_sample(
        self,
        t: SourceTransport,
        matchers: Sequence[Matcher],
        now: float,
        limits: CatalogLimits,
    ) -> tuple[list[dict], bool] | None:
        """The window's first `series_sample` label sets under the filter, and whether the
        sample is full; None when the source refuses to list them (4xx) or answers too much."""
        params = [
            ("match[]", inject_promql(ALL_SERIES, matchers)),
            ("start", number_text(now - limits.series_window)),
            ("end", number_text(now)),
            ("limit", str(limits.series_sample)),
        ]
        try:
            got = await t.request("GET", "/api/v1/series", params=params, timeout=PROBE_SECONDS)
        except SourceUnreachable as exc:
            if exc.code == "too_large":
                return None
            raise
        if 400 <= got.status < 500:
            return None
        data = checked_json(got, "The source", WHAT).get("data")
        entries = [e for e in data if isinstance(e, dict)] if isinstance(data, list) else []
        # A tool that ignores `limit` answers everything: read only the sample's worth.
        return entries[: limits.series_sample], len(entries) >= limits.series_sample


def _labels_per_metric(series: list[dict], cap: int) -> PerMetric:
    """Metric name -> (its label names but `__name__`, sorted, at most `cap`; its series)."""
    labels: dict[str, set[str]] = {}
    counts: dict[str, int] = {}
    for entry in series:
        name = entry.get("__name__")
        if not isinstance(name, str):
            continue
        labels.setdefault(name, set()).update(str(k) for k in entry if k != "__name__")
        counts[name] = counts.get(name, 0) + 1
    return {name: (tuple(sorted(labels[name])[:cap]), counts[name]) for name in labels}


def _family(
    name: str, metadata: dict[str, dict], per_metric: PerMetric
) -> tuple[str | None, str | None, dict]:
    """The name's type, the family it belongs to, and the metadata entry that describes it."""
    own = metadata.get(name) or {}
    own_type = _text(own, "type")
    if own_type in FAMILY_TYPES:  # a summary's quantile series, or a native histogram
        return own_type, name, own
    for suffix in FAMILY_SUFFIXES:
        if not name.endswith(suffix):
            continue
        base = name[: -len(suffix)]
        entry = metadata.get(base) or {}
        base_type = _text(entry, "type")
        if base_type in FAMILY_TYPES:
            return base_type, base, entry
        no_metadata = own_type is None and base_type is None
        if suffix == "_bucket" and no_metadata and "le" in per_metric.get(name, ((), 0))[0]:
            return "histogram", base, own
    return own_type, None, own


def _follow_buckets(metrics: list[CatalogMetric]) -> list[CatalogMetric]:
    """Without metadata, a histogram found by its `_bucket`'s `le` label takes its `_sum` and
    `_count` along."""
    found = {m.family for m in metrics if m.type == "histogram" and m.name.endswith("_bucket")}
    out = []
    for m in metrics:
        if m.type is None and m.family is None:
            for suffix in ("_sum", "_count"):
                base = m.name[: -len(suffix)]
                if m.name.endswith(suffix) and base in found:
                    m = replace(m, type="histogram", family=base)
        out.append(m)
    return out


def _cut(text: str | None, cap: int) -> str | None:
    """Text over `cap` characters cut to `cap`, its last one an ellipsis."""
    if text is None or len(text) <= cap:
        return text
    return text[: cap - 1] + "…"


def _match(matchers: Sequence[Matcher]) -> list[tuple[str, str]]:
    return [("match[]", "{" + render_matchers(matchers) + "}")] if matchers else []


def _text(entry: dict, key: str) -> str | None:
    value = entry.get(key)
    return value if isinstance(value, str) and value else None
