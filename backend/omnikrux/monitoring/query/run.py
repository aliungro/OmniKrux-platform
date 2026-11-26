"""Running one Monitoring query, and reading one label's values, on the server.

With a `project_id`, a query runs only on a source linked to that project, with the link's filter
added to every selector by the injector its connector's language names (`inject_promql` for
Prometheus, `inject_logql` for Loki). A query the filter can't be added to is refused: the raw
text is never sent instead. Without a `project_id` a query runs as written (the Sources page uses
this through `POST /query`; no project's data is involved).

Every failure is a `QueryError` carrying the HTTP status, a `QueryErrorCode` and plain words. The
routes turn it into `{"code", "message"}`: an HTTP error for `POST /query` and `GET
/label-values`, one item's error for `POST /query/batch`."""

import math
import re
import time
from collections.abc import Callable, Sequence
from typing import Literal

from pydantic import ValidationError

from omnikrux.monitoring.projects.types import Matcher, UnknownProject
from omnikrux.monitoring.query.filters import (
    FilterError,
    inject_logql,
    inject_promql,
    render_matchers,
)
from omnikrux.monitoring.query.series import MAX_QUERY_CHARS, QueryRequest, QueryResponse
from omnikrux.monitoring.query.words import plain_query_error
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.connector import (
    Connector,
    ConnectorQuery,
    QueryRejected,
    UnknownSourceType,
)
from omnikrux.monitoring.sources.health import SECRETS_UNREADABLE
from omnikrux.monitoring.sources.transport import SourceUnreachable
from omnikrux.monitoring.sources.types import SourceConfig

QueryErrorCode = Literal[
    "not_found",
    "not_linked",
    "bad_request",
    "bad_query",
    "unreachable",
    "timeout",
    "unauthorized",
    "too_large",
    "tool_error",
]

MAX_POINTS = 11000
DEFAULT_LOG_LIMIT = 1000
MAX_LABEL_VALUES = 1000

SOURCE_GONE = "That source no longer exists."
PROJECT_GONE = "That project no longer exists."
NOT_LINKED = "This source isn't linked to that project."
RANGE_NEEDS = "A range query needs a start, an end after it, and a step."
TOO_MANY_POINTS = "This range has too many points for the step. Use a larger step."
NO_FILTER_RULE = (
    "OmniKrux can't add a project's filter to this source's queries yet, so it doesn't run them "
    "for a project."
)

# What a body that breaks a `QueryRequest` field limit is told, by field. Never the value sent.
QUERY_LENGTH = "Write a query of 1 to 10000 characters."
LIMIT_RANGE = "A log limit is a whole number from 1 to 5000."
STEP_RANGE = "A step is a number of seconds above 0."
KIND_CHOICE = "Choose an instant or a range query."
DIRECTION_CHOICE = "Read logs either backward or forward."
SOURCE_NEEDED = "Choose a source to query."
PROJECT_CHOICE = "Choose the project by its id, or leave it out."
TIME_NUMBER = "A time is a number of seconds since 1970, like 1700000000."
NOT_AN_OBJECT = "Send the query as a JSON object."
NOT_JSON = "The request body isn't valid JSON. Correct it and try again."
FIELD_INVALID = "A query field has a value that can't be used. Check the query and try again."
_FIELD_WORDS = {
    "source_id": SOURCE_NEEDED,
    "project_id": PROJECT_CHOICE,
    "kind": KIND_CHOICE,
    "query": QUERY_LENGTH,
    "time": TIME_NUMBER,
    "start": TIME_NUMBER,
    "end": TIME_NUMBER,
    "step": STEP_RANGE,
    "limit": LIMIT_RANGE,
    "direction": DIRECTION_CHOICE,
}

# Label values (dashboard variables).
LABEL_NAME = "Use a label name: letters, digits and _, not starting with a digit."
PROJECT_NEEDED = "Choose the project whose label values to read."
_LABEL = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class QueryError(Exception):
    """A query that can't run or that failed: the HTTP status, its code and plain words."""

    def __init__(self, status: int, code: QueryErrorCode, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code: QueryErrorCode = code
        self.message = message


def transport_error(exc: SourceUnreachable) -> QueryError:
    """A transport failure as a query error, always with the transport's own words: a timeout is
    504; rejected credentials and an answer too large keep their codes; the rest is unreachable."""
    if exc.code == "timeout":
        return QueryError(504, "timeout", exc.message)
    if exc.code == "unauthorized":
        return QueryError(502, "unauthorized", exc.message)
    if exc.code == "too_large":
        return QueryError(502, "too_large", exc.message)
    return QueryError(502, "unreachable", exc.message)


def field_words(exc: ValidationError) -> str:
    """What a `QueryRequest` that breaks a field limit is told: the first bad field's words."""
    location = exc.errors()[0].get("loc") or ("",)
    return _FIELD_WORDS.get(str(location[0]), FIELD_INVALID)


def query_request(data: object) -> QueryRequest:
    """A decoded JSON value as a `QueryRequest`; 422 `bad_request` in plain words when it isn't
    one."""
    if not isinstance(data, dict):
        raise QueryError(422, "bad_request", NOT_AN_OBJECT)
    try:
        return QueryRequest.model_validate(data)
    except ValidationError as exc:
        raise QueryError(422, "bad_request", field_words(exc)) from None


def _check_range(q: QueryRequest) -> None:
    if q.kind != "range":
        return
    start, end, step = q.start, q.end, q.step
    if start is None or end is None or step is None or not end > start:
        raise QueryError(400, "bad_request", RANGE_NEEDS)
    # Prometheus's own rule: (end - start) / step may be at most 11000.
    if (end - start) / step > MAX_POINTS:
        raise QueryError(400, "bad_request", TOO_MANY_POINTS)


_INJECTORS: dict[str, Callable[[str, Sequence[Matcher]], str]] = {
    "promql": inject_promql,
    "logql": inject_logql,
}


async def _source(services: MonitoringServices, id: str) -> SourceConfig:
    try:
        return await services.sources.get(id)
    except KeyError:
        raise QueryError(404, "not_found", SOURCE_GONE) from None


async def _link_matchers(
    services: MonitoringServices, project_id: str, source_id: str
) -> tuple[Matcher, ...]:
    """The project's filter on the source; 404 when either is missing or they aren't linked."""
    try:
        project = await services.projects.get(project_id)
    except UnknownProject:
        raise QueryError(404, "not_found", PROJECT_GONE) from None
    for link in project.links:
        if link.source_id == source_id:
            return link.matchers
    raise QueryError(404, "not_linked", NOT_LINKED)


def _connector(services: MonitoringServices, source: SourceConfig) -> Connector:
    try:
        return services.connectors.get(source.type)
    except UnknownSourceType as exc:
        raise QueryError(400, "bad_request", exc.message) from None


def _injector(connector: Connector) -> Callable[[str, Sequence[Matcher]], str]:
    """The injector the connector's language names, read now (never cached); 400 `bad_request`
    for a language without one: a project's filter is never added by another language's rules."""
    inject = _INJECTORS.get(connector.language)
    if inject is None:
        raise QueryError(400, "bad_request", NO_FILTER_RULE)
    return inject


def _filtered(connector: Connector, query: str, matchers: Sequence[Matcher]) -> str:
    """The query with the filter on every selector; 400 `bad_query` when it can't be added."""
    inject = _injector(connector)
    try:
        return inject(query, matchers)
    except FilterError as exc:
        raise QueryError(400, "bad_query", str(exc)) from None


def _rejected(connector: Connector, exc: QueryRejected) -> QueryError:
    """A tool's refusal; a `bad_query` one in plain words (anything unrecognised unchanged)."""
    message = exc.message
    if exc.code == "bad_query" and connector.language in ("promql", "logql"):
        message = plain_query_error(connector.language, message)
    return QueryError(exc.status, exc.code, message)


async def run_query(services: MonitoringServices, req: QueryRequest) -> QueryResponse:
    """Run one query, with its project's filter when it names a project. Checks run in this
    order: the range, the source, the link, the connector, the filter, the secrets."""
    _check_range(req)
    source = await _source(services, req.source_id)
    matchers: tuple[Matcher, ...] = ()
    if req.project_id is not None:
        matchers = await _link_matchers(services, req.project_id, source.id)
    connector = _connector(services, source)
    sent = _filtered(connector, req.query, matchers) if req.project_id is not None else req.query
    if source.secrets_unreadable:
        raise QueryError(502, "unreachable", SECRETS_UNREADABLE)

    limit = req.limit
    if limit is None and connector.language == "logql":
        limit = DEFAULT_LOG_LIMIT
    asked = ConnectorQuery(
        kind=req.kind,
        query=sent,
        time=req.time,
        start=req.start,
        end=req.end,
        step=req.step,
        limit=limit,
        direction=req.direction,
    )
    began = time.perf_counter()
    try:
        result = await connector.query(services.transports.for_source(source), asked, source.name)
    except SourceUnreachable as exc:
        raise transport_error(exc) from None
    except QueryRejected as exc:
        raise _rejected(connector, exc) from None
    took_ms = int((time.perf_counter() - began) * 1000)

    return QueryResponse(
        result_type=result.result_type,
        series=result.series,
        streams=result.streams,
        warnings=result.warnings,
        truncated=result.truncated,
        source_id=source.id,
        source_name=source.name,
        source_type=source.type,
        project_id=req.project_id,
        applied_filter=render_matchers(matchers),
        query=sent,
        took_ms=took_ms,
    )


def _label_time(text: str | None) -> float | None:
    """A `start` or `end` query parameter in seconds; 400 `bad_request` when it isn't a finite
    number."""
    if text is None or text == "":
        return None
    try:
        value = float(text)
    except ValueError:
        raise QueryError(400, "bad_request", TIME_NUMBER) from None
    if not math.isfinite(value):
        raise QueryError(400, "bad_request", TIME_NUMBER)
    return value


async def read_label_values(
    services: MonitoringServices,
    *,
    source_id: str | None,
    project_id: str | None,
    label: str | None,
    selector: str | None,
    start: str | None,
    end: str | None,
) -> tuple[list[str], bool]:
    """One label's values on a source, always through the project's filter: sorted, at most
    `MAX_LABEL_VALUES`, and whether there were more. A `selector` narrows the series counted and
    gets the filter like any query's selector. Checks run in this order: the parameters, the
    source, the link, the connector and its filter rule, the secrets, then the filter itself as
    the connector adds it."""
    if not source_id:
        raise QueryError(400, "bad_request", SOURCE_NEEDED)
    if not project_id:
        raise QueryError(400, "bad_request", PROJECT_NEEDED)
    if label is None or _LABEL.fullmatch(label) is None:
        raise QueryError(400, "bad_request", LABEL_NAME)
    selector = selector or None
    if selector is not None and len(selector) > MAX_QUERY_CHARS:
        raise QueryError(400, "bad_request", QUERY_LENGTH)
    start_at, end_at = _label_time(start), _label_time(end)

    source = await _source(services, source_id)
    matchers = await _link_matchers(services, project_id, source.id)
    connector = _connector(services, source)
    _injector(connector)  # the connector adds the filter with this language's own rules
    if source.secrets_unreadable:
        raise QueryError(502, "unreachable", SECRETS_UNREADABLE)
    try:
        # One more than shown: the connector cuts before any sort, so this is how "more" shows.
        values = await connector.label_values(
            services.transports.for_source(source),
            label,
            matchers=matchers,
            limit=MAX_LABEL_VALUES + 1,
            selector=selector,
            start=start_at,
            end=end_at,
        )
    except FilterError as exc:
        raise QueryError(400, "bad_query", str(exc)) from None
    except SourceUnreachable as exc:
        raise transport_error(exc) from None
    except QueryRejected as exc:
        raise _rejected(connector, exc) from None
    values.sort()
    return values[:MAX_LABEL_VALUES], len(values) > MAX_LABEL_VALUES
