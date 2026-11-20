"""The series format every Monitoring query answers in; the dashboards and log views read it.
Also what `POST /api/monitoring/query` takes and answers."""

import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from omnikrux.monitoring.sources.types import SourceType

MAX_SERIES = 2000
TRUNCATED_WARNING = "Showing the first 2000 series."
MAX_QUERY_CHARS = 10000
MAX_LOG_LIMIT = 5000


class Series(BaseModel):
    labels: dict[str, str]
    # Unix seconds and the value; a value that isn't a finite number is None.
    points: list[tuple[float, float | None]]


class Stream(BaseModel):
    labels: dict[str, str]
    # Nanosecond timestamp (as the tool sends it) and the log line.
    entries: list[tuple[str, str]]


class QueryResult(BaseModel):
    result_type: Literal["matrix", "vector", "scalar", "streams"]
    series: list[Series] = []
    streams: list[Stream] = []
    warnings: list[str] = []
    truncated: bool = False


class QueryRequest(BaseModel):
    """One query on one source. With `project_id`, the project's filter on that source is added
    to every selector; without it the query runs as written. Times and the step are seconds."""

    # NaN and the infinities pass `gt`/`le` checks and comparisons unnoticed: refuse them here.
    model_config = ConfigDict(allow_inf_nan=False)

    source_id: str
    project_id: str | None = None
    kind: Literal["instant", "range"]
    query: str = Field(min_length=1, max_length=MAX_QUERY_CHARS)
    time: float | None = None
    start: float | None = None
    end: float | None = None
    step: float | None = Field(None, gt=0)
    limit: int | None = Field(None, ge=1, le=MAX_LOG_LIMIT)
    direction: Literal["backward", "forward"] = "backward"


class QueryResponse(QueryResult):
    source_id: str
    source_name: str
    source_type: SourceType
    project_id: str | None
    applied_filter: str
    query: str  # the text actually sent to the tool, after the filter
    took_ms: int


def number(value: Any) -> float | None:
    """A sample value as a float; None for NaN, an infinity or anything unreadable."""
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _point(pair: Any) -> tuple[float, float | None]:
    return float(pair[0]), number(pair[1])


def _labels(raw: Any) -> dict[str, str]:
    return {str(k): str(v) for k, v in (raw or {}).items()}


def series_result(data: dict, warnings: list[str]) -> QueryResult:
    """A Prometheus-style `data` object (matrix, vector or scalar) as a `QueryResult`, keeping the
    first `MAX_SERIES` series. ValueError when the shape isn't one of those."""
    kind = data.get("resultType")
    raw = data.get("result") or []
    try:
        if kind == "scalar":
            series = [Series(labels={}, points=[_point(raw)])] if raw else []
        elif kind == "matrix":
            series = [
                Series(
                    labels=_labels(item.get("metric")),
                    points=[_point(p) for p in item.get("values") or []],
                )
                for item in raw[: MAX_SERIES + 1]
            ]
        elif kind == "vector":
            series = [
                Series(
                    labels=_labels(item.get("metric")),
                    points=[_point(item["value"])] if item.get("value") else [],
                )
                for item in raw[: MAX_SERIES + 1]
            ]
        else:
            raise ValueError(f"Not a result type: {kind!r}")
    except (TypeError, KeyError, IndexError, AttributeError) as exc:
        raise ValueError("Not a result shape") from exc
    truncated = len(series) > MAX_SERIES
    if truncated:
        series = series[:MAX_SERIES]
        warnings = [*warnings, TRUNCATED_WARNING]
    return QueryResult(result_type=kind, series=series, warnings=warnings, truncated=truncated)


def streams_result(data: dict, warnings: list[str]) -> QueryResult:
    """A Loki `streams` result. ValueError when the shape isn't one."""
    try:
        streams = [
            Stream(
                labels=_labels(item.get("stream")),
                entries=[(str(e[0]), str(e[1])) for e in item.get("values") or []],
            )
            for item in (data.get("result") or [])[: MAX_SERIES + 1]
        ]
    except (TypeError, KeyError, IndexError, AttributeError) as exc:
        raise ValueError("Not a result shape") from exc
    truncated = len(streams) > MAX_SERIES
    if truncated:
        streams = streams[:MAX_SERIES]
        warnings = [*warnings, TRUNCATED_WARNING]
    return QueryResult(
        result_type="streams", streams=streams, warnings=warnings, truncated=truncated
    )
