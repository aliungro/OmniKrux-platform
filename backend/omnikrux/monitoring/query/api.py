"""`POST /api/monitoring/query`: every Monitoring query runs here, never in the browser.

With a `project_id`, the query runs only on a source linked to that project, with the link's
filter added to every selector (`inject_promql` for Prometheus, `inject_logql` for Loki). A query
the filter can't be added to is refused: the raw text is never sent instead. Without a
`project_id` the query runs as written (the Sources page uses this; no project's data is involved).

Every error answers `detail = {"code": QueryErrorCode, "message": plain words}`, including a body
that breaks a `QueryRequest` field limit (FastAPI's own 422 would be a list of errors)."""

import json
import time
from collections.abc import Callable, Sequence
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import ValidationError

from omnikrux.monitoring.projects.types import Matcher, UnknownProject
from omnikrux.monitoring.query.filters import (
    FilterError,
    inject_logql,
    inject_promql,
    render_matchers,
)
from omnikrux.monitoring.query.series import QueryRequest, QueryResponse
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.connector import (
    ConnectorQuery,
    QueryLanguage,
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
_REQUEST_SCHEMA = {
    "requestBody": {
        "required": True,
        "content": {"application/json": {"schema": QueryRequest.model_json_schema()}},
    }
}

router = APIRouter()


def query_error(status: int, code: QueryErrorCode, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def unreachable_error(exc: SourceUnreachable) -> HTTPException:
    """A transport failure as a query error, always with the transport's own words: a timeout is
    504; rejected credentials and an answer too large keep their codes; the rest is unreachable."""
    if exc.code == "timeout":
        return query_error(504, "timeout", exc.message)
    if exc.code == "unauthorized":
        return query_error(502, "unauthorized", exc.message)
    if exc.code == "too_large":
        return query_error(502, "too_large", exc.message)
    return query_error(502, "unreachable", exc.message)


async def _query_request(request: Request) -> QueryRequest:
    """The body as a `QueryRequest`; 422 `bad_request` in plain words when it isn't one."""
    raw = await request.body()
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):  # RecursionError: nesting too deep to read
        raise query_error(422, "bad_request", NOT_JSON) from None
    if not isinstance(data, dict):
        raise query_error(422, "bad_request", NOT_AN_OBJECT)
    try:
        return QueryRequest.model_validate(data)
    except ValidationError as exc:
        location = exc.errors()[0].get("loc") or ("",)
        message = _FIELD_WORDS.get(str(location[0]), FIELD_INVALID)
        raise query_error(422, "bad_request", message) from None


def _check_range(q: QueryRequest) -> None:
    if q.kind != "range":
        return
    start, end, step = q.start, q.end, q.step
    if start is None or end is None or step is None or not end > start:
        raise query_error(400, "bad_request", RANGE_NEEDS)
    # Prometheus's own rule: (end - start) / step may be at most 11000.
    if (end - start) / step > MAX_POINTS:
        raise query_error(400, "bad_request", TOO_MANY_POINTS)


_INJECTORS: dict[str, Callable[[str, Sequence[Matcher]], str]] = {
    "promql": inject_promql,
    "logql": inject_logql,
}


async def _source(services: MonitoringServices, id: str) -> SourceConfig:
    try:
        return await services.sources.get(id)
    except KeyError:
        raise query_error(404, "not_found", SOURCE_GONE) from None


async def _link_matchers(
    services: MonitoringServices, project_id: str, source_id: str
) -> tuple[Matcher, ...]:
    """The project's filter on the source; 404 when either is missing or they aren't linked."""
    try:
        project = await services.projects.get(project_id)
    except UnknownProject:
        raise query_error(404, "not_found", PROJECT_GONE) from None
    for link in project.links:
        if link.source_id == source_id:
            return link.matchers
    raise query_error(404, "not_linked", NOT_LINKED)


def _filtered(language: QueryLanguage, query: str, matchers: Sequence[Matcher]) -> str:
    """The query with the filter on every selector; 400 `bad_query` when it can't be added.

    Each language names its own injector. A language without one is refused (400 `bad_request`):
    a project's filter is never added by another language's rules.
    """
    inject = _INJECTORS.get(language)
    if inject is None:
        raise query_error(400, "bad_request", NO_FILTER_RULE)
    try:
        return inject(query, matchers)
    except FilterError as exc:
        raise query_error(400, "bad_query", str(exc)) from None


@router.post("/query", openapi_extra=_REQUEST_SCHEMA)
async def run_query(request: Request) -> QueryResponse:
    q = await _query_request(request)
    _check_range(q)
    services: MonitoringServices = request.app.state.monitoring
    source = await _source(services, q.source_id)
    matchers: tuple[Matcher, ...] = ()
    if q.project_id is not None:
        matchers = await _link_matchers(services, q.project_id, source.id)
    try:
        connector = services.connectors.get(source.type)
    except UnknownSourceType as exc:
        raise query_error(400, "bad_request", exc.message) from None
    sent = _filtered(connector.language, q.query, matchers) if q.project_id is not None else q.query
    if source.secrets_unreadable:
        raise query_error(502, "unreachable", SECRETS_UNREADABLE)

    limit = q.limit
    if limit is None and connector.language == "logql":
        limit = DEFAULT_LOG_LIMIT
    asked = ConnectorQuery(
        kind=q.kind,
        query=sent,
        time=q.time,
        start=q.start,
        end=q.end,
        step=q.step,
        limit=limit,
        direction=q.direction,
    )
    began = time.perf_counter()
    try:
        result = await connector.query(services.transports.for_source(source), asked, source.name)
    except SourceUnreachable as exc:
        raise unreachable_error(exc) from None
    except QueryRejected as exc:
        raise query_error(exc.status, exc.code, exc.message) from None
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
        project_id=q.project_id,
        applied_filter=render_matchers(matchers),
        query=sent,
        took_ms=took_ms,
    )
