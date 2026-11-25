"""Why a query came back empty, in plain words, said only when a check proved it.

`POST /query/why-empty` (in `api.py`) runs here. Every check reads the source through the
project's filter, the same way the query did, so each reason is about this project only:

- Prometheus: each metric the query names is looked up over the whole retention. The first one
  with no series is `missing_metric`; when all have series, `nothing_matched`.
- Loki: the stream labels of the last 30 days are read; a label the selector needs that no stream
  has is `missing_labels`. Then the selector's streams are counted (none: `no_streams`), and
  its newest line up to now is read: none (`no_streams`), older than the range (`older_lines`),
  inside it (`filtered_out`, so the rest of the query dropped every line) or newer than it. Then
  the range itself is read for a line: one (`filtered_out`) or none (`older_lines`: the range is
  quiet, and the words give the newest line's true age).

A check that fails, times out (the whole explanation is bounded by `WHY_EMPTY_SECONDS`) or can't
read the source's secrets answers `unknown` with no words: nothing new is claimed. The words are
OmniKrux's own; a tool's error text never reaches the answer."""

import asyncio
import re
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    model_validator,
)

from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.filters import FilterError, parse_matchers
from omnikrux.monitoring.query.run import (
    NOT_AN_OBJECT,
    QUERY_LENGTH,
    SOURCE_NEEDED,
    TIME_NUMBER,
    QueryError,
    _connector,
    _filtered,
    _link_matchers,
    _source,
)
from omnikrux.monitoring.query.series import MAX_QUERY_CHARS
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.connector import Connector, QueryRejected, gather_all
from omnikrux.monitoring.sources.loki import LokiConnector
from omnikrux.monitoring.sources.transport import SourceTransport, SourceUnreachable

WHY_EMPTY_SECONDS = 10.0
LOKI_LOOKBACK = 30 * 86400
MAX_METRICS = 5
MAX_SELECTOR_CHARS = 2000
METRIC_PATTERN = r"^[A-Za-z_:][A-Za-z0-9_:]*$"

WhyEmptyReason = Literal[
    "missing_metric",
    "nothing_matched",
    "missing_labels",
    "no_streams",
    "older_lines",
    "filtered_out",
    "unknown",
]

# The answers' words.
MISSING_METRIC = "This Prometheus doesn't collect {thing} for this project: {metric} has no series."
MISSING_METRIC_PLAIN = "This Prometheus doesn't collect {metric} for this project."
# What a metric's prefix says is missing, checked in this order (the first match wins).
METRIC_THINGS = (
    ("container_cpu_cfs_", "CPU throttling"),
    ("container_", "container usage from the kubelet (cAdvisor)"),
    ("kube_", "Kubernetes object states (kube-state-metrics)"),
    ("node_", "node metrics (node-exporter)"),
)
NOTHING_MATCHED = (
    "The query's metrics are collected for this project, but nothing matched in this time range. "
    "Try a longer range."
)
MISSING_LABELS = (
    "This Loki has no streams with {labels} for this project in the last 30 days, so nothing "
    "sends these logs to it now."
)
NO_STREAMS = "No log streams in this Loki match {selector} for this project in the last 30 days."
OLDER_LINES = (
    "No lines in this time range. The newest matching line is {age} old: try a longer range."
)
FILTERED_OUT = (
    "Streams match {selector}, but no line in this time range passes the rest of the query."
)

# What a body that breaks a `WhyEmptyIn` field limit is told, by field. Never the value sent.
METRICS_LIST = "Send the metrics as a list of at most 5 metric names."
METRIC_NAME = "Use metric names: letters, digits, _ and :, not starting with a digit."
WINDOW_ORDER = "Send the time range the query ran over: a start, and an end after it."
SELECTOR_LENGTH = "Write a stream selector of 1 to 2000 characters."
PROJECT_NAMED = "Choose the project the query ran for."
_FIELD_WORDS = {
    "": WINDOW_ORDER,  # the model's own check: the end after the start
    "source_id": SOURCE_NEEDED,
    "project_id": PROJECT_NAMED,
    "query": QUERY_LENGTH,
    "start": TIME_NUMBER,
    "end": TIME_NUMBER,
    "metrics": METRICS_LIST,
    "selector": SELECTOR_LENGTH,
}
_FIELD_INVALID = "A field has a value that can't be used. Check the request and try again."

MetricName = Annotated[str, StringConstraints(pattern=METRIC_PATTERN)]


class WhyEmptyIn(BaseModel):
    """The query that came back empty: the source and project it ran on, the text it ran (after
    variables, before the filter) and the range it covered (seconds). `metrics` are the metric
    names a Prometheus query reads; `selector` is a Loki query's stream selector `{…}`."""

    # NaN and the infinities pass comparisons unnoticed: refuse them here.
    model_config = ConfigDict(allow_inf_nan=False)

    source_id: str
    project_id: str
    query: str = Field(min_length=1, max_length=MAX_QUERY_CHARS)
    start: float
    end: float
    metrics: list[MetricName] = Field(default=[], max_length=MAX_METRICS)
    selector: str | None = Field(None, min_length=1, max_length=MAX_SELECTOR_CHARS)

    @model_validator(mode="after")
    def _end_after_start(self) -> "WhyEmptyIn":
        if not self.end > self.start:
            raise ValueError(WINDOW_ORDER)
        return self


class WhyEmptyOut(BaseModel):
    reason: WhyEmptyReason
    message: str | None  # None exactly for `unknown`


UNKNOWN = WhyEmptyOut(reason="unknown", message=None)


def _field_words(exc: ValidationError) -> str:
    location = exc.errors()[0].get("loc") or ("",)
    if location[0] == "metrics" and len(location) > 1:
        return METRIC_NAME
    return _FIELD_WORDS.get(str(location[0]), _FIELD_INVALID)


def why_empty_request(data: object) -> WhyEmptyIn:
    """A decoded JSON value as a `WhyEmptyIn`; 422 `bad_request` in plain words when it isn't
    one."""
    if not isinstance(data, dict):
        raise QueryError(422, "bad_request", NOT_AN_OBJECT)
    try:
        return WhyEmptyIn.model_validate(data)
    except ValidationError as exc:
        raise QueryError(422, "bad_request", _field_words(exc)) from None


# --- Words --------------------------------------------------------------------------------------


def missing_metric_words(metric: str) -> str:
    for prefix, thing in METRIC_THINGS:
        if metric.startswith(prefix):
            return MISSING_METRIC.format(thing=thing, metric=metric)
    return MISSING_METRIC_PLAIN.format(metric=metric)


def labels_words(names: list[str]) -> str:
    """`the label "a"`, `the labels "a" and "b"`, `the labels "a", "b" and "c"`."""
    quoted = [f'"{name}"' for name in names]
    if len(quoted) == 1:
        return f"the label {quoted[0]}"
    return f"the labels {', '.join(quoted[:-1])} and {quoted[-1]}"


def age_words(seconds: float) -> str:
    """An age in whole units, rounded down: minutes, then hours, then days."""
    if seconds < 60:
        return "less than a minute"
    for size, unit in ((86400, "day"), (3600, "hour"), (60, "minute")):
        if seconds >= size:
            n = int(seconds // size)
            return f"1 {unit}" if n == 1 else f"{n} {unit}s"
    return "less than a minute"  # not reached: seconds >= 60 here


# --- The checks ---------------------------------------------------------------------------------


async def explain_empty(services: MonitoringServices, body: WhyEmptyIn, now: float) -> WhyEmptyOut:
    """Why `body`'s query came back empty, judged under the project's filter on the source.
    Refusals (`QueryError`) are those of a query: the source, the link, the connector and the
    filter, checked in that order. Anything a check can't prove answers `unknown`."""
    source = await _source(services, body.source_id)
    matchers = await _link_matchers(services, body.project_id, source.id)
    connector = _connector(services, source)
    _filtered(connector, body.query, matchers)  # 400 `bad_query` when the filter can't be added
    loki = isinstance(connector, LokiConnector)
    if loki and body.selector is not None:
        _filtered(connector, body.selector, matchers)
    if source.secrets_unreadable:
        return UNKNOWN
    t = services.transports.for_source(source)
    try:
        async with asyncio.timeout(WHY_EMPTY_SECONDS):
            if isinstance(connector, LokiConnector):
                return await _loki(connector, t, body, matchers, now)
            if connector.language == "promql":
                return await _prometheus(connector, t, body, matchers)
            return UNKNOWN
    except (TimeoutError, SourceUnreachable, QueryRejected, FilterError):
        return UNKNOWN


async def _prometheus(
    connector: Connector, t: SourceTransport, body: WhyEmptyIn, matchers: tuple[Matcher, ...]
) -> WhyEmptyOut:
    if not body.metrics:
        return UNKNOWN

    async def has_series(metric: str) -> bool:
        # No start or end: Prometheus searches its whole retention.
        names = await connector.label_values(
            t, "__name__", matchers=matchers, selector=f'{{__name__="{metric}"}}'
        )
        return metric in names

    found = await gather_all([has_series(m) for m in body.metrics])
    for metric, present in zip(body.metrics, found, strict=True):
        if not present:
            return WhyEmptyOut(reason="missing_metric", message=missing_metric_words(metric))
    return WhyEmptyOut(reason="nothing_matched", message=NOTHING_MATCHED)


def _needed_labels(selector: str) -> list[str] | None:
    """The labels a stream must have for `selector` to select it, in the selector's order: those
    of `=` matchers with a value and `=~` matchers whose pattern doesn't match the empty value.
    None when the selector can't be read."""
    try:
        parsed = parse_matchers(selector)
    except FilterError:
        return None
    needed: list[str] = []
    for m in parsed:
        # Loki's own `__…` labels are never listed with a stream's labels: no claim about them.
        if m.label.startswith("__"):
            continue
        if _needs_label(m) and m.label not in needed:
            needed.append(m.label)
    return needed


def _needs_label(m: Matcher) -> bool:
    """Whether a stream without the label (read as the empty value) fails the matcher."""
    if m.op == "=":
        return m.value != ""
    if m.op != "=~":
        return False  # `!=` and `!~` select streams without the label too
    try:
        return re.fullmatch(m.value, "") is None
    except re.error:  # a pattern Python can't read: don't claim the label is needed
        return False


async def _loki(
    connector: LokiConnector,
    t: SourceTransport,
    body: WhyEmptyIn,
    matchers: tuple[Matcher, ...],
    now: float,
) -> WhyEmptyOut:
    selector = body.selector
    if selector is None:
        return UNKNOWN
    needed = _needed_labels(selector)
    if needed is None:
        return UNKNOWN
    since = now - LOKI_LOOKBACK
    if needed:
        labels = set(await connector.label_names(t, matchers=matchers, start=since, end=now))
        missing = [name for name in needed if name not in labels]
        if missing:
            return WhyEmptyOut(
                reason="missing_labels", message=MISSING_LABELS.format(labels=labels_words(missing))
            )
    streams = await connector.stream_count(t, selector, matchers=matchers, start=since, end=now)
    if streams == 0:
        return WhyEmptyOut(reason="no_streams", message=NO_STREAMS.format(selector=selector))
    # The newest line up to now, over the same 30 days the streams were counted in: its age is
    # true whatever range the query covered.
    newest = await connector.newest_line(t, selector, matchers=matchers, start=since, end=now)
    if newest is None:
        return WhyEmptyOut(reason="no_streams", message=NO_STREAMS.format(selector=selector))
    older = OLDER_LINES.format(age=age_words(now - newest))
    if newest < body.start:
        return WhyEmptyOut(reason="older_lines", message=older)
    if newest > body.end:
        # Lines came after the range: whether the range itself holds one decides the reason.
        inside = await connector.newest_line(
            t, selector, matchers=matchers, start=body.start, end=body.end
        )
        if inside is None:
            return WhyEmptyOut(reason="older_lines", message=older)
    return WhyEmptyOut(reason="filtered_out", message=FILTERED_OUT.format(selector=selector))
