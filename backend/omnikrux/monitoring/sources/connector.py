"""What a connector is: one shape for every kind of monitoring tool.

A connector knows a tool's API (what to ask, how to read the answer) and nothing about reaching
it: the `SourceTransport` it is handed does that. `test` never raises for an unreachable tool (it
reports it); every other call raises `SourceUnreachable` as the transport does, and
`QueryRejected` when the tool itself refuses a request.

`catalog` describes what a source holds for one project: every request it sends carries the
project's matchers. Prometheus's `/api/v1/metadata` alone takes none, so it is read only for names
the filtered list returned: a name's own entry gives its type, help and unit. A suffixed name
(`_bucket`, `_sum`, `_count`, `_created`) with no entry of its own takes only its base's type and
family from the base's entry, never its help or unit, which could be another project's.
"""

import asyncio
import json
import re
from collections.abc import Awaitable, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.series import QueryResult
from omnikrux.monitoring.sources import messages
from omnikrux.monitoring.sources.transport import (
    SourceTransport,
    TransportResponse,
    scrub_text,
)
from omnikrux.monitoring.sources.types import SourceConfig, SourceType

QueryLanguage = Literal["promql", "logql", "none"]
QueryRejectedCode = Literal["bad_query", "tool_error", "unauthorized"]

MAX_TOOL_MESSAGE = 300
TOOL_ERROR = "{name} answered HTTP {status}. Try again, or check the tool."
NOT_AN_API = (
    "{name} answered, but not as {type} API (HTTP {status}). Check the address and the type."
)
QUERY_REFUSED = "{name} couldn't run that query."
NOT_LIKE = "{name} answered, but not like {what}. Check the address and its path."
RULER_OFF = "This Loki doesn't have its ruler turned on."
NO_OPERATOR = (
    "Rules can run in the tool only for a Prometheus run by the Prometheus Operator "
    "in a known cluster."
)


@dataclass(frozen=True)
class TestResult:
    __test__ = False  # not a pytest test class, whatever module imports it

    ok: bool
    version: str | None
    message: str | None
    # The tool answered over HTTP, but not as its type (`NOT_AN_API`).
    answered: bool = False


@dataclass(frozen=True)
class MetricField:
    name: str
    type: str | None
    help: str | None
    unit: str | None


@dataclass(frozen=True)
class FieldCatalog:
    metrics: tuple[MetricField, ...]
    labels: tuple[str, ...]
    truncated: bool


NOTE_METRICS_TRUNCATED = "Showing the first 5000 metrics. Search and the list cover only those."
NOTE_SERIES_SAMPLED = "Labels per metric come from the first 50000 series."
NOTE_NO_SERIES = "This source didn't list its series, so labels per metric are missing."
NOTE_STREAM_LABELS_TRUNCATED = "Showing the first 50 log labels."
NOTE_STREAM_VALUES_TRUNCATED = (
    "Some log labels have more than 200 values; only the first 200 are listed."
)
# How far back a Loki's labels are read (seconds): its streams from the last 7 days.
LOKI_LABEL_WINDOW = 7 * 86400


@dataclass(frozen=True)
class CatalogLimits:
    """How much of a source a catalog reads. Windows are in seconds."""

    max_metrics: int = 5000
    max_help: int = 200
    series_sample: int = 50000
    max_labels_per_metric: int = 50
    series_window: int = 900
    max_stream_labels: int = 50
    max_stream_values: int = 200
    max_stream_series: int = 5000
    stream_window: int = LOKI_LABEL_WINDOW


DEFAULT_LIMITS = CatalogLimits()


@dataclass(frozen=True)
class CatalogMetric:
    """One metric name. `series` is None when the source didn't list its series; `family` is the
    histogram or summary the name belongs to."""

    name: str
    type: str | None
    help: str | None
    unit: str | None
    labels: tuple[str, ...]
    series: int | None
    family: str | None


@dataclass(frozen=True)
class StreamLabel:
    name: str
    values: tuple[str, ...]
    truncated: bool


@dataclass(frozen=True)
class SourceCatalog:
    metrics: tuple[CatalogMetric, ...]
    labels: tuple[str, ...]
    streams: tuple[StreamLabel, ...]
    notes: tuple[str, ...]


@dataclass(frozen=True)
class AlertingCapability:
    omnikrux_engine: bool
    tool_engine: Literal["prometheus_rule", "loki_ruler"] | None
    reason: str | None


class ClusterProbe(Protocol):
    async def serves(self, group: str, version: str, plural: str) -> bool: ...

    async def read(self, path: str) -> dict | None:
        """The object at an API path; None when the cluster says it isn't there."""
        ...


@dataclass(frozen=True)
class ConnectorQuery:
    kind: Literal["instant", "range"]
    query: str
    time: float | None = None
    start: float | None = None
    end: float | None = None
    step: float | None = None
    limit: int | None = None
    direction: Literal["backward", "forward"] = "backward"


class QueryRejected(Exception):
    """The tool answered, and refused the request. `message` is plain words for the user."""

    def __init__(self, code: QueryRejectedCode, message: str, status: int) -> None:
        super().__init__(message)
        self.code: QueryRejectedCode = code
        self.message = message
        self.status = status


class UnknownSourceType(Exception):
    def __init__(self, type: str) -> None:
        super().__init__(f'There\'s no connector for "{type}" sources.')
        self.message = str(self)


class Connector(Protocol):
    type: SourceType
    label: str
    language: QueryLanguage

    async def test(self, t: SourceTransport, name: str) -> TestResult: ...

    async def query(self, t: SourceTransport, q: ConnectorQuery, name: str) -> QueryResult: ...

    async def describe_fields(
        self, t: SourceTransport, *, matchers: Sequence[Matcher], limit: int = 2000
    ) -> FieldCatalog: ...

    async def catalog(
        self,
        t: SourceTransport,
        *,
        matchers: Sequence[Matcher],
        now: float,
        limits: CatalogLimits = DEFAULT_LIMITS,
    ) -> SourceCatalog:
        """What the source holds under `matchers`, read over windows ending at `now` (seconds).
        Raises `SourceUnreachable` and `QueryRejected` as the lookups do; what a source can't
        list but the catalog can do without becomes a note."""
        ...

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
        """The label's values, at most `limit` in the tool's order. With a `selector`, only
        series it selects count, with `matchers` added to it by the language's injector
        (`FilterError` when they can't be); without one, `matchers` alone narrow the series.
        `start` and `end` (seconds) bound the time searched."""
        ...

    async def alerting(
        self,
        t: SourceTransport,
        *,
        cluster: ClusterProbe | None,
        source: SourceConfig | None = None,
    ) -> AlertingCapability:
        """What the tool can run. `cluster` asks the source's cluster (None when it isn't reached
        through one); `source` is the source asked about."""
        ...


class ConnectorRegistry:
    def __init__(self) -> None:
        self._connectors: dict[str, Connector] = {}

    def register(self, c: Connector) -> None:
        if c.type in self._connectors:
            raise ValueError(f"A connector for {c.type} is already registered.")
        self._connectors[c.type] = c

    def get(self, type: str) -> Connector:
        try:
            return self._connectors[type]
        except KeyError:
            raise UnknownSourceType(type) from None

    def types(self) -> list[SourceType]:
        return [c.type for c in self._connectors.values()]


def default_connectors() -> ConnectorRegistry:
    # Imported here: the connectors import this module for the shapes above.
    from omnikrux.monitoring.sources.alertmanager import AlertmanagerConnector
    from omnikrux.monitoring.sources.loki import LokiConnector
    from omnikrux.monitoring.sources.prometheus import PrometheusConnector

    registry = ConnectorRegistry()
    registry.register(PrometheusConnector())
    registry.register(LokiConnector())
    registry.register(AlertmanagerConnector())
    return registry


# --- Helpers the connectors share --------------------------------------------------------------


def json_object(body: bytes) -> dict | None:
    """The body as a JSON object, or None when it isn't one."""
    try:
        data = json.loads(body)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def tool_text(body: bytes) -> str:
    """What the tool said was wrong, capped; empty when it said nothing (a cluster's service
    proxy hands back no error body)."""
    data = json_object(body)
    if data is not None:
        text = data.get("error")
        text = text if isinstance(text, str) else ""
    else:
        text = body.decode("utf-8", "replace")
    return " ".join(scrub_text(text).split())[:MAX_TOOL_MESSAGE]


def status_message(name: str, status: int) -> str:
    """What a non-2xx answer to a probe says."""
    if status in (401, 403):
        return messages.REJECTED.format(name=name, status=status)
    return TOOL_ERROR.format(name=name, status=status)


def probe_failure(name: str, status: int, type_word: str) -> TestResult:
    """What a non-2xx answer to a probe says: 404 and 405 mean the address isn't that kind of
    API at all (the tool answered); other statuses are `status_message`'s."""
    if status in (404, 405):
        message = NOT_AN_API.format(name=name, type=type_word, status=status)
        return TestResult(False, None, message, answered=True)
    return TestResult(False, None, status_message(name, status))


_NOT_AN_API = re.compile(
    "^"
    + re.escape(NOT_AN_API)
    .replace(re.escape("{name}"), ".+")
    .replace(re.escape("{type}"), "(?:a Prometheus|a Loki|an Alertmanager)")
    .replace(re.escape("{status}"), "[0-9]+")
    + "$",
    re.DOTALL,
)


def is_not_an_api(message: str | None) -> bool:
    """Whether a stored check message is `NOT_AN_API`'s (the stored check keeps no flag)."""
    return message is not None and _NOT_AN_API.match(message) is not None


def reject(response: TransportResponse, name: str) -> QueryRejected:
    """The error a non-2xx answer to a query or a lookup stands for."""
    status = response.status
    if status in (400, 422):
        message = tool_text(response.body) or QUERY_REFUSED.format(name=name)
        return QueryRejected("bad_query", message, 400)
    code = "unauthorized" if status in (401, 403) else "tool_error"
    return QueryRejected(code, status_message(name, status), 502)


def checked_json(response: TransportResponse, name: str, what: str) -> dict[str, Any]:
    """The JSON object of a 2xx answer; `QueryRejected` for any other status or a non-JSON body."""
    if not 200 <= response.status < 300:
        raise reject(response, name)
    data = json_object(response.body)
    if data is None:
        raise QueryRejected("tool_error", NOT_LIKE.format(name=name, what=what), 502)
    return data


async def gather_all[T](calls: Sequence[Awaitable[T]]) -> list[T]:
    """Every call's result, in order. The first failure cancels the rest and is raised as is."""
    tasks = [asyncio.ensure_future(call) for call in calls]
    try:
        return list(await asyncio.gather(*tasks))
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


def number_text(value: float) -> str:
    """A time or step in seconds as the tools read it."""
    return f"{value:.3f}".rstrip("0").rstrip(".")
