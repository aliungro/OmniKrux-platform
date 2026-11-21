"""Every Monitoring query runs here, never in the browser:

- `POST /query` runs one query, filtered when it names a project (the Sources page runs them
  unfiltered);
- `POST /query/batch` runs a panel's queries as one request, each item through its own
  project's filter, each succeeding or failing on its own;
- `GET /label-values` reads one label's values for a dashboard variable, through a project's
  filter.

The pipeline itself (filters, checks, the connector call) is in `run.py`; this module reads the
request and answers. Every refusal answers `detail = {"code": QueryErrorCode, "message": plain
words}`, including a body that breaks a `QueryRequest` field limit (FastAPI's own 422 would be a
list of errors)."""

import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from omnikrux.monitoring.query.run import (
    DIRECTION_CHOICE,
    FIELD_INVALID,
    KIND_CHOICE,
    LABEL_NAME,
    LIMIT_RANGE,
    MAX_LABEL_VALUES,
    MAX_POINTS,
    NO_FILTER_RULE,
    NOT_AN_OBJECT,
    NOT_JSON,
    NOT_LINKED,
    PROJECT_CHOICE,
    PROJECT_GONE,
    PROJECT_NEEDED,
    QUERY_LENGTH,
    RANGE_NEEDS,
    SOURCE_GONE,
    SOURCE_NEEDED,
    STEP_RANGE,
    TIME_NUMBER,
    TOO_MANY_POINTS,
    QueryError,
    QueryErrorCode,
    query_request,
    read_label_values,
    run_query,
    transport_error,
)
from omnikrux.monitoring.query.series import QueryRequest, QueryResponse
from omnikrux.monitoring.sources.transport import SourceUnreachable

__all__ = [
    "BATCH_LIST",
    "BATCH_NOT_AN_OBJECT",
    "BATCH_SIZE",
    "DIRECTION_CHOICE",
    "FIELD_INVALID",
    "KIND_CHOICE",
    "LABEL_NAME",
    "LIMIT_RANGE",
    "MAX_BATCH",
    "MAX_LABEL_VALUES",
    "MAX_POINTS",
    "MAX_RUNNING",
    "NOT_AN_OBJECT",
    "NOT_JSON",
    "NOT_LINKED",
    "NO_FILTER_RULE",
    "PROJECT_CHOICE",
    "PROJECT_GONE",
    "PROJECT_NEEDED",
    "QUERY_LENGTH",
    "RANGE_NEEDS",
    "SOURCE_GONE",
    "SOURCE_NEEDED",
    "STEP_RANGE",
    "TIME_NUMBER",
    "TOO_MANY_POINTS",
    "BatchError",
    "BatchIn",
    "BatchItemOut",
    "BatchOut",
    "LabelValuesOut",
    "QueryError",
    "QueryErrorCode",
    "batch_route",
    "label_values_route",
    "query_error",
    "query_route",
    "router",
    "run_query",
    "unreachable_error",
]

MAX_BATCH = 64
MAX_RUNNING = 8  # batch items running at once

BATCH_NOT_AN_OBJECT = 'Send the batch as a JSON object with a "queries" list.'
BATCH_LIST = 'Put the queries in a "queries" list.'
BATCH_SIZE = "Send 1 to 64 queries in one batch."


class BatchIn(BaseModel):
    """What `POST /query/batch` takes. The route reads each item on its own, so an item that
    breaks a `QueryRequest` limit fails alone; this model describes the body."""

    queries: list[QueryRequest] = Field(min_length=1, max_length=MAX_BATCH)


class BatchError(BaseModel):
    code: QueryErrorCode
    message: str
    status: int  # the HTTP status the same query alone would have answered


class BatchItemOut(BaseModel):
    ok: bool
    response: QueryResponse | None = None
    error: BatchError | None = None


class BatchOut(BaseModel):
    results: list[BatchItemOut]  # in the order of the queries sent


class LabelValuesOut(BaseModel):
    values: list[str]  # sorted, at most MAX_LABEL_VALUES
    truncated: bool  # the label has more values than shown


_REQUEST_SCHEMA = {
    "requestBody": {
        "required": True,
        "content": {"application/json": {"schema": QueryRequest.model_json_schema()}},
    }
}
# `BatchIn` written out with the item schema inline: its own JSON schema refers to `$defs`,
# which an OpenAPI document doesn't resolve.
_BATCH_SCHEMA = {
    "requestBody": {
        "required": True,
        "content": {
            "application/json": {
                "schema": {
                    "title": "BatchIn",
                    "type": "object",
                    "required": ["queries"],
                    "properties": {
                        "queries": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": MAX_BATCH,
                            "items": QueryRequest.model_json_schema(),
                        }
                    },
                }
            }
        },
    }
}

router = APIRouter()


def query_error(status: int, code: QueryErrorCode, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def http_error(exc: QueryError) -> HTTPException:
    return query_error(exc.status, exc.code, exc.message)


def unreachable_error(exc: SourceUnreachable) -> HTTPException:
    """A transport failure as an HTTP query error (see `run.transport_error`)."""
    return http_error(transport_error(exc))


async def _json_body(request: Request) -> object:
    """The decoded body; 422 `bad_request` when it isn't JSON."""
    raw = await request.body()
    try:
        return json.loads(raw)
    except (ValueError, RecursionError):  # RecursionError: nesting too deep to read
        raise query_error(422, "bad_request", NOT_JSON) from None


async def _query_request(request: Request) -> QueryRequest:
    """The body as a `QueryRequest`; 422 `bad_request` in plain words when it isn't one."""
    data = await _json_body(request)
    try:
        return query_request(data)
    except QueryError as exc:
        raise http_error(exc) from None


@router.post("/query", openapi_extra=_REQUEST_SCHEMA)
async def query_route(request: Request) -> QueryResponse:
    q = await _query_request(request)
    try:
        return await run_query(request.app.state.monitoring, q)
    except QueryError as exc:
        raise http_error(exc) from None


def _failed(exc: QueryError) -> BatchItemOut:
    return BatchItemOut(
        ok=False, error=BatchError(code=exc.code, message=exc.message, status=exc.status)
    )


@router.post("/query/batch", openapi_extra=_BATCH_SCHEMA)
async def batch_route(request: Request) -> BatchOut:
    """Each item runs through its own project's filter, at most `MAX_RUNNING` at once, with M1's
    limits and timeouts. One item's failure never fails or cancels another: the answer is 200
    with every item's result in the order sent."""
    data = await _json_body(request)
    if not isinstance(data, dict):
        raise query_error(422, "bad_request", BATCH_NOT_AN_OBJECT)
    items = data.get("queries")
    if not isinstance(items, list):
        raise query_error(422, "bad_request", BATCH_LIST)
    if not 1 <= len(items) <= MAX_BATCH:
        raise query_error(422, "bad_request", BATCH_SIZE)
    services = request.app.state.monitoring
    running = asyncio.Semaphore(MAX_RUNNING)

    async def one(item: object) -> BatchItemOut:
        try:
            q = query_request(item)
            if q.project_id is None:  # a batch never reads a source unfiltered
                raise QueryError(422, "bad_request", PROJECT_CHOICE)
            async with running:
                return BatchItemOut(ok=True, response=await run_query(services, q))
        except QueryError as exc:
            return _failed(exc)

    return BatchOut(results=list(await asyncio.gather(*(one(item) for item in items))))


@router.get("/label-values")
async def label_values_route(
    request: Request,
    source_id: str | None = None,
    project_id: str | None = None,
    label: str | None = None,
    match: str | None = None,
    start: str | None = None,
    end: str | None = None,
) -> LabelValuesOut:
    """One label's values for a dashboard variable, through the project's filter. `match` is an
    optional selector (it gets the filter too); `start` and `end` are seconds. Every parameter is
    read here, so a missing or bad one answers `{code, message}` like every query error."""
    try:
        values, truncated = await read_label_values(
            request.app.state.monitoring,
            source_id=source_id,
            project_id=project_id,
            label=label,
            selector=match,
            start=start,
            end=end,
        )
    except QueryError as exc:
        raise http_error(exc) from None
    return LabelValuesOut(values=values, truncated=truncated)
