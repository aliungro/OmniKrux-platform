"""The dry run: how often a condition would have fired over the last hours, on real data.

`replay` and `candidate_thresholds` are pure. `dry_run` reads one range query per project of the
scope, always through M2's `run_query` with the project's id (so the project's filter is on every
selector), and replays the condition on what came back. It stores nothing, tells nobody and
writes no audit record: it changes nothing.

A project whose query fails says so in its own `error` and counts nothing; it never reads as
"would not have fired".
"""

import asyncio
import logging
import math
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from omnikrux.monitoring.alerts.evaluate import breaches
from omnikrux.monitoring.alerts.rule_expr import (
    LOG_QUERY_COPY,
    RuleExprError,
    eval_expr,
    expr_without_document,
    is_log_query,
    parse_duration,
)
from omnikrux.monitoring.alerts.types import (
    EVERY_CHOICES,
    MAX_FOR_SECONDS,
    Condition,
    Of,
    Op,
    ScopeKind,
)
from omnikrux.monitoring.projects.types import Project, UnknownGroup, UnknownProject
from omnikrux.monitoring.query.run import (
    NOT_LINKED,
    QUERY_LENGTH,
    SOURCE_GONE,
    QueryError,
    QueryErrorCode,
    run_query,
)
from omnikrux.monitoring.query.series import MAX_QUERY_CHARS, MAX_SERIES, QueryRequest, Series
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.types import QUERYABLE_TYPES

log = logging.getLogger(__name__)

MAX_CANDIDATES = 20
MAX_RUNNING = 4  # project queries running at once
# The most points one project's answer may hold for a dry run (series × points). Each candidate
# threshold replays them all again, so this bounds the work of one request per project.
MAX_PROJECT_POINTS = 200_000

PROJECT_GONE = "That project doesn't exist anymore. It may have been removed."
GROUP_GONE = "That group doesn't exist anymore. It may have been removed."
GROUP_SOURCE = (
    "A group's rule runs on each project's first source of the type. Leave the source id out."
)
FOR_DURATION = "Use a duration from 0s to 24h, like 5m."
DRY_RUN_FAILED = "Something went wrong running this query. Try again."
_SOURCE_WORDS = {"prometheus": "Prometheus-compatible", "loki": "Loki"}


def no_source_copy(project: str, source_type: str) -> str:
    return f"{project} has no {_SOURCE_WORDS[source_type]} source."


def wrong_type_copy(source_type: str) -> str:
    return f"That source isn't a {_SOURCE_WORDS[source_type]} source. Pick one that is."


def too_many_points_copy(series: int | str) -> str:
    return (
        f"This query returns {series} series, too many to replay over this window. "
        "Narrow it with a label, alert on the total, or use a shorter window."
    )


class DryRunRefused(Exception):
    """The dry run can't start: the HTTP status, a code and plain words."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


# --- replay -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Episode:
    """One series firing without a break, from `start` to `end` (seconds)."""

    start: float
    end: float
    ongoing: bool
    labels: Mapping[str, str]


def _episodes(
    points: Sequence[tuple[float, float | None]], cond: Condition, end: float
) -> list[tuple[float, float, bool]]:
    """(start, end, ongoing) for each firing stretch of one series' points (sorted, in range)."""
    gap = cond.every_seconds * 1.5  # one step, with room for a timestamp that drifts
    last_point = end - cond.every_seconds / 2  # at or after this, a point is the last one
    out: list[tuple[float, float, bool]] = []
    # The current run of breaching points: where it began, where it fires, its latest point.
    run: list[float | None] = [None, None, None]

    def close() -> None:
        _, fire_at, latest = run
        if fire_at is not None and latest is not None:
            out.append((fire_at, latest, latest >= last_point))
        run[:] = [None, None, None]

    for t, value in points:
        hit = breaches(value, cond)
        latest = run[2]
        if latest is not None and (not hit or t - latest > gap):
            close()
        if not hit:
            continue
        if run[0] is None:
            run[0] = t
        if run[1] is None and t - run[0] >= cond.for_seconds:
            run[1] = t
        run[2] = t
    close()
    return out


def _merged(intervals: list[tuple[float, float, bool]]) -> list[tuple[float, float, bool]]:
    """Intervals that overlap or touch, as one; in time order."""
    out: list[tuple[float, float, bool]] = []
    for start, end, ongoing in sorted(intervals):
        if out and start <= out[-1][1]:
            s, e, o = out[-1]
            out[-1] = (s, max(e, end), o or ongoing)
        else:
            out.append((start, end, ongoing))
    return out


def replay(
    series: Sequence[Series], cond: Condition, start: float, end: float
) -> tuple[list[Episode], list[tuple[float, float, bool]]]:
    """How the condition would have fired over `[start, end]`, checked at every point.

    Per series, consecutive breaching points make a run (a missing point or a value of None
    breaks it); the run fires from its first point at least `for` after its start for as long as
    it lasts. Returns each series' episodes, and the rule's periods: every series' firing merged
    where they overlap or touch, `ongoing` when one reaches the last point.
    """
    episodes: list[Episode] = []
    for s in series:
        points = sorted((p for p in s.points if start <= p[0] <= end), key=lambda p: p[0])
        for a, b, ongoing in _episodes(points, cond, end):
            episodes.append(Episode(start=a, end=b, ongoing=ongoing, labels=dict(s.labels)))
    episodes.sort(key=lambda e: (e.start, e.end, sorted(e.labels.items())))
    periods = _merged([(e.start, e.end, e.ongoing) for e in episodes])
    return episodes, periods


def _quantile(ordered: list[float], q: float) -> float:
    """The q-quantile of sorted values, by linear interpolation between neighbours."""
    at = (len(ordered) - 1) * q
    low = math.floor(at)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (at - low)


def _two_digits(value: float, rounding: str) -> float:
    """`value` rounded to 2 significant digits, up (ROUND_CEILING) or down (ROUND_FLOOR)."""
    if value == 0:
        return 0.0
    exact = Decimal(repr(value))
    step = Decimal(1).scaleb(exact.adjusted() - 1)
    return float(exact.quantize(step, rounding=rounding))


def candidate_thresholds(series: Sequence[Series], op: Op) -> list[float]:
    """Calmer thresholds read off the data. Above: the 0.9, 0.95 and 0.99 quantiles of every
    value and 10% past the largest, rounded up to 2 significant digits, distinct, ascending.
    Below: the mirror (0.1, 0.05, 0.01 and 10% under the smallest, rounded down, descending)."""
    values = sorted(v for s in series for _, v in s.points if v is not None and math.isfinite(v))
    if not values:
        return []
    if op == "above":
        top = values[-1]
        raw = [_quantile(values, q) for q in (0.9, 0.95, 0.99)] + [top + abs(top) * 0.1]
        return sorted({_two_digits(v, ROUND_CEILING) for v in raw})
    bottom = values[0]
    raw = [_quantile(values, q) for q in (0.1, 0.05, 0.01)] + [bottom - abs(bottom) * 0.1]
    return sorted({_two_digits(v, ROUND_FLOOR) for v in raw}, reverse=True)


# --- the request and the answer ---------------------------------------------------------------


class ScopeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ScopeKind
    id: str = Field(min_length=1)


class SourceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["prometheus", "loki"]
    id: str | None = None


class DryRunIn(BaseModel):
    """What `POST /alerts/dry-run` takes. `expr` is the query as the rule runs it (variables
    already placed; the built-ins `$__interval` and `$__rate_interval` are placed here)."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, populate_by_name=True)

    scope: ScopeIn
    source: SourceIn
    expr: str = Field(min_length=1, max_length=MAX_QUERY_CHARS)
    of: Of = "each"
    op: Op
    threshold: float
    for_: str = Field("5m", alias="for")
    every: Literal["30s", "1m", "5m"] = "1m"
    window_seconds: int = Field(21600, ge=600, le=86400)
    candidates: list[float] = Field([], max_length=MAX_CANDIDATES)
    suggest: bool = False


class PeriodOut(BaseModel):
    start: float
    end: float
    ongoing: bool


class DryRunError(BaseModel):
    code: QueryErrorCode
    message: str


class DryRunProjectOut(BaseModel):
    project_id: str
    project_name: str
    fired: int
    firing_now: bool
    periods: list[PeriodOut]
    series: int
    error: DryRunError | None


class CandidateOut(BaseModel):
    threshold: float
    fired: int


class DryRunOut(BaseModel):
    start: float
    end: float
    step: int
    fired: int  # rule-level periods, every project merged
    firing_now: bool
    periods: list[PeriodOut]
    projects: list[DryRunProjectOut]
    candidates: list[CandidateOut]
    took_ms: int


# --- running it -------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Planned:
    project: Project
    source_type: str
    source_id: str | None  # None: the project has no source of the type (its error says so)


@dataclass(frozen=True)
class _Read:
    project: Project
    series: list[Series] | None
    error: DryRunError | None


def _condition(body: DryRunIn, every: int) -> Condition:
    try:
        for_seconds = parse_duration(body.for_)
    except ValueError:
        for_seconds = -1
    if not 0 <= for_seconds <= MAX_FOR_SECONDS:
        raise DryRunRefused(422, "bad_request", FOR_DURATION)
    return Condition(body.of, body.op, body.threshold, for_seconds, every)


def _query_text(body: DryRunIn, every: int) -> str:
    """The text each project runs: built-ins placed, `total` summed. 400 `bad_query` when it
    can't run as an alert."""
    if body.source.type == "loki" and is_log_query(body.expr):
        raise DryRunRefused(400, "bad_query", LOG_QUERY_COPY)
    try:
        text = expr_without_document(body.expr, every)
    except RuleExprError as exc:
        raise DryRunRefused(400, "bad_query", str(exc)) from None
    text = eval_expr(text, body.of)
    if len(text) > MAX_QUERY_CHARS:
        raise DryRunRefused(400, "bad_request", QUERY_LENGTH)
    return text


async def _first_of_type(
    services: MonitoringServices, project: Project, source_type: str
) -> str | None:
    """The project's first linked source of the type, in link order; None when it has none."""
    for link in project.links:
        try:
            source = await services.sources.get(link.source_id)
        except KeyError:
            continue
        if source.type == source_type and source.type in QUERYABLE_TYPES:
            return source.id
    return None


async def _plan(services: MonitoringServices, body: DryRunIn) -> list[_Planned]:
    """Each project of the scope with the source it reads. Refuses what can't start."""
    kind, source_type = body.scope.kind, body.source.type
    if kind == "group":
        if body.source.id is not None:
            raise DryRunRefused(422, "bad_request", GROUP_SOURCE)
        try:
            group = await services.groups.get(body.scope.id)
        except UnknownGroup:
            raise DryRunRefused(404, "not_found", GROUP_GONE) from None
        projects: list[Project] = []
        for id in group.project_ids:
            try:
                projects.append(await services.projects.get(id))
            except UnknownProject:
                continue
        projects.sort(key=lambda p: (p.name.casefold(), p.id))
        return [
            _Planned(p, source_type, await _first_of_type(services, p, source_type))
            for p in projects
        ]

    try:
        project = await services.projects.get(body.scope.id)
    except UnknownProject:
        raise DryRunRefused(404, "not_found", PROJECT_GONE) from None
    if body.source.id is None:
        source_id = await _first_of_type(services, project, source_type)
        if source_id is None:
            message = f"{no_source_copy(project.name, source_type)} Link one on the project page."
            raise DryRunRefused(404, "not_linked", message)
        return [_Planned(project, source_type, source_id)]
    if not any(link.source_id == body.source.id for link in project.links):
        raise DryRunRefused(404, "not_linked", NOT_LINKED)
    try:
        source = await services.sources.get(body.source.id)
    except KeyError:
        raise DryRunRefused(404, "not_found", SOURCE_GONE) from None
    if source.type != source_type:
        raise DryRunRefused(400, "bad_request", wrong_type_copy(source_type))
    return [_Planned(project, source_type, source.id)]


async def _read(
    services: MonitoringServices,
    planned: _Planned,
    text: str,
    start: float,
    end: float,
    step: int,
    running: asyncio.Semaphore,
) -> _Read:
    project = planned.project
    if planned.source_id is None:
        message = no_source_copy(project.name, planned.source_type)
        return _Read(project, None, DryRunError(code="not_linked", message=message))
    req = QueryRequest(
        source_id=planned.source_id,
        project_id=project.id,
        kind="range",
        query=text,
        start=start,
        end=end,
        step=step,
    )
    try:
        async with running:
            answer = await run_query(services, req)
    except QueryError as exc:
        return _Read(project, None, DryRunError(code=exc.code, message=exc.message))
    except Exception:
        # A fault in OmniKrux, not in the source: this project fails alone. The log names where
        # it ran, never the query text.
        log.exception(
            "A dry run query failed unexpectedly (source %r, project %r).",
            planned.source_id,
            project.id,
        )
        return _Read(project, None, DryRunError(code="unreachable", message=DRY_RUN_FAILED))
    # A cut answer would count too few firings, and too many points would take too long: either
    # way this project says so instead of answering a number.
    if answer.truncated:
        message = too_many_points_copy(f"more than {MAX_SERIES}")
        return _Read(project, None, DryRunError(code="too_large", message=message))
    if sum(len(s.points) for s in answer.series) > MAX_PROJECT_POINTS:
        message = too_many_points_copy(len(answer.series))
        return _Read(project, None, DryRunError(code="too_large", message=message))
    return _Read(project, answer.series, None)


def _periods(periods: list[tuple[float, float, bool]]) -> list[PeriodOut]:
    return [PeriodOut(start=a, end=b, ongoing=o) for a, b, o in periods]


def _replay_all(
    reads: list[_Read], body: DryRunIn, cond: Condition, start: float, end: float
) -> tuple[list[DryRunProjectOut], list[tuple[float, float, bool]], list[CandidateOut]]:
    """The CPU part: every project's replay, the merged periods, and each candidate's count."""
    projects: list[DryRunProjectOut] = []
    every_period: list[tuple[float, float, bool]] = []
    data: list[Series] = []
    for read in reads:
        if read.series is None:
            projects.append(
                DryRunProjectOut(
                    project_id=read.project.id,
                    project_name=read.project.name,
                    fired=0,
                    firing_now=False,
                    periods=[],
                    series=0,
                    error=read.error,
                )
            )
            continue
        _, periods = replay(read.series, cond, start, end)
        every_period.extend(periods)
        data.extend(read.series)
        projects.append(
            DryRunProjectOut(
                project_id=read.project.id,
                project_name=read.project.name,
                fired=len(periods),
                firing_now=any(o for _, _, o in periods),
                periods=_periods(periods),
                series=len(read.series),
                error=None,
            )
        )
    merged = _merged(every_period)

    thresholds = list(body.candidates)
    if body.suggest:
        thresholds += candidate_thresholds(data, body.op)
    seen: set[float] = set()
    candidates: list[CandidateOut] = []
    for threshold in thresholds:
        if threshold in seen:
            continue
        seen.add(threshold)
        other = Condition(cond.of, cond.op, threshold, cond.for_seconds, cond.every_seconds)
        # Each project on its own, then merged, as the rule's own count is.
        found: list[tuple[float, float, bool]] = []
        for read in reads:
            if read.series is not None:
                found.extend(replay(read.series, other, start, end)[1])
        candidates.append(CandidateOut(threshold=threshold, fired=len(_merged(found))))
    return projects, merged, candidates


async def dry_run(services: MonitoringServices, body: DryRunIn, now: float) -> DryRunOut:
    """The dry run of `body` over the window ending at `now` (seconds). Raises DryRunRefused for
    a request that can't start, and when every project's query failed (502, with the first
    project's error)."""
    began = time.perf_counter()
    every = EVERY_CHOICES[body.every]
    cond = _condition(body, every)
    text = _query_text(body, every)
    planned = await _plan(services, body)

    end = math.floor(now / every) * every
    start = math.floor((now - body.window_seconds) / every) * every
    running = asyncio.Semaphore(MAX_RUNNING)
    reads = list(
        await asyncio.gather(
            *(_read(services, p, text, start, end, every, running) for p in planned)
        )
    )
    failed = [r for r in reads if r.error is not None]
    if reads and len(failed) == len(reads):
        first = failed[0].error
        assert first is not None
        raise DryRunRefused(502, first.code, first.message)

    projects, merged, candidates = await asyncio.to_thread(
        _replay_all, reads, body, cond, start, end
    )
    return DryRunOut(
        start=start,
        end=end,
        step=every,
        fired=len(merged),
        firing_now=any(o for _, _, o in merged),
        periods=_periods(merged),
        projects=projects,
        candidates=candidates,
        took_ms=int((time.perf_counter() - began) * 1000),
    )
