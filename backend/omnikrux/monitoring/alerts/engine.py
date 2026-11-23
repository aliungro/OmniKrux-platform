"""OmniKrux's own alert engine: checks every rule target it runs, on time, and tells about it.

A background loop ticks once a second. Each tick starts a check of every due target (at most
`concurrency` at once; a target is never checked twice at once) and returns without waiting for
them, so a slow source never holds up the others. A check's query is bounded by `CHECK_SECONDS`.
The loop also prunes history and deliveries once an hour (first a minute after it starts), and
catches every exception (logged by its type): it never dies. Tests drive `tick(now)` directly and run no loop.

One check: an instant query of the target's `eval_expr` through M2's `run_query` with the
target's project (so the project's filter is on every selector); the samples, labelled with the
series' labels plus `alertname`, `severity`, `project` and `omnikrux_rule`; `step` (the same one
the dry run's replay matches); then the instances, the history, the target's state and next
check are written in one transaction, and the notifier is asked to tell.

A failed query never reads as OK: the target is `unreachable` (the source can't be read) or
`error` (the rule can't run as written), with the failure's words, and its instances stay as they
were (nothing resolves). After `CANT_CHECK_AFTER` failures in a row one "can't check" notice goes
out, repeated every `REPEAT_SECONDS` while it lasts; the first check that works after that sends
"checking again". A pending timer never counts time nobody checked: after a failure, or when the
last check was more than two intervals ago (a restart, a pause), pending instances start over.
An answer cut at MAX_SERIES series is an `error` too: the series it left out never resolve."""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import partial
from typing import TYPE_CHECKING, Literal

from pydantic import ValidationError

from omnikrux.monitoring.alerts.evaluate import Sample, StepResult, restored, step
from omnikrux.monitoring.alerts.notify import REPEAT_SECONDS
from omnikrux.monitoring.alerts.rule_expr import LOG_QUERY_COPY
from omnikrux.monitoring.alerts.store import (
    HistoryKind,
    HistoryRecord,
    RuleRecord,
    TargetRecord,
    UnknownRule,
    UnknownTarget,
)
from omnikrux.monitoring.models import AlertTargetRow, lock_first, utc
from omnikrux.monitoring.models import now as now_utc
from omnikrux.monitoring.projects.types import Project, UnknownProject
from omnikrux.monitoring.query.run import SOURCE_GONE, QueryError, field_words, run_query
from omnikrux.monitoring.query.series import MAX_SERIES, QueryRequest
from omnikrux.monitoring.sources import messages

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

TICK_SECONDS = 1.0
PRUNE_SECONDS = 3600
# The first prune runs this long after the loop starts (not in the busy first second).
FIRST_PRUNE_SECONDS = 60
# The longest one check's query may take (the transport's own limit is 30 s).
CHECK_SECONDS = 45.0
# A due target whose check should have started more than this long ago is running late.
LATE_SECONDS = 30
# How often the rule and target counts of `status` are read again.
COUNT_SECONDS = 30
# After a check that failed inside OmniKrux (not in the source), wait this long before the next.
HOLD_SECONDS = 60
# Failed checks in a row before "can't check" is told.
CANT_CHECK_AFTER = 3

UNREACHABLE_CODES = frozenset({"unreachable", "timeout", "unauthorized", "too_large", "tool_error"})
ERROR_CODES = frozenset({"bad_query", "bad_request", "not_found", "not_linked"})

# -- copy --------------------------------------------------------------------------------------

NO_SOURCE = "{project} has no {kind} source for this rule. Link one on the project page."
_SOURCE_WORDS = {"prometheus": "Prometheus-compatible", "loki": "Loki"}
TOO_MANY_SERIES = (
    f"This rule matches more than {MAX_SERIES} series, so OmniKrux can't check all of them. "
    "Narrow the query with a label, or alert on the total."
)
CHECK_FAILED = (
    "OmniKrux couldn't check this rule because of a fault of its own. "
    "It tries again at the next check."
)
# For the Alerts page (`EngineOut.note`, Task 14).
NOTE_ON_TIME = (
    "Rules checked by OmniKrux run only while OmniKrux is running. "
    "Rules that run in Prometheus or Loki keep firing when it's off."
)
NOTE_BEHIND = (
    "OmniKrux's alert checks are running late ({n} rules waiting). Results may be delayed."
)
NOTE_DISABLED = (
    "OmniKrux's alert checks are turned off (OMNIKRUX_ALERT_ENGINE=false), "
    "so rules checked by OmniKrux aren't running."
)


def no_source_copy(project: str, source_type: str) -> str:
    return NO_SOURCE.format(project=project, kind=_SOURCE_WORDS.get(source_type, source_type))


@dataclass(frozen=True)
class TickReport:
    evaluated: int  # checks this tick started (and, for `tick`, finished)
    skipped_running: int  # due targets whose previous check was still running
    behind: int  # due targets that should have been checked more than LATE_SECONDS ago


@dataclass(frozen=True)
class EngineStatus:
    enabled: bool
    running: bool
    last_tick_at: datetime | None
    rules: int
    targets: int
    behind: int


def engine_note(status: EngineStatus) -> str:
    """What the Alerts page says about the engine."""
    if not status.enabled:
        return NOTE_DISABLED
    if status.behind:
        return NOTE_BEHIND.format(n=status.behind)
    return NOTE_ON_TIME


@dataclass(frozen=True)
class _Failure:
    state: Literal["unreachable", "error"]
    message: str


def first_offset(target_id: str, every_seconds: int) -> int:
    """Seconds from a target's first check to its second: spread by its id over the interval, so
    targets made together don't all run in the same second."""
    digest = int(hashlib.sha256(target_id.encode()).hexdigest(), 16)
    return digest % every_seconds or every_seconds


def _moved(now: TargetRecord, then: TargetRecord) -> bool:
    """Whether the target no longer is what the check read for."""
    return (
        now.engine != then.engine
        or now.source_id != then.source_id
        or now.eval_expr != then.eval_expr
        or now.leaving
    )


class AlertEngine:
    def __init__(
        self,
        services: MonitoringServices,
        *,
        enabled: bool,
        clock: Callable[[], datetime] = now_utc,
        concurrency: int = 8,
    ) -> None:
        self._services = services
        self.enabled = enabled
        self._clock = clock
        self._slots = asyncio.Semaphore(concurrency)
        self._tick_seconds = TICK_SECONDS
        self._loop_task: asyncio.Task | None = None
        self._running: dict[str, asyncio.Task] = {}
        self._writes: set[asyncio.Task] = set()
        self._cant_check_at: dict[str, datetime] = {}
        self._hold: dict[str, datetime] = {}
        self._last_tick_at: datetime | None = None
        self._behind = 0
        self._rules = 0
        self._targets = 0
        self._counted_at: datetime | None = None
        self._pruned_at: datetime | None = None

    # -- the loop ------------------------------------------------------------------------------

    def start(self) -> None:
        """Start the loop; nothing when the engine is turned off or already running."""
        if not self.enabled or (self._loop_task is not None and not self._loop_task.done()):
            return
        first = PRUNE_SECONDS - FIRST_PRUNE_SECONDS
        self._pruned_at = self._clock() - timedelta(seconds=first)
        self._loop_task = asyncio.create_task(self._loop(), name="omnikrux-alert-engine")

    async def stop(self) -> None:
        """Stop the loop and every check in flight; a check that is writing its result finishes
        writing first. Returns once nothing of the engine runs."""
        loop_task, self._loop_task = self._loop_task, None
        if loop_task is not None:
            loop_task.cancel()
            await asyncio.gather(loop_task, return_exceptions=True)
        running = list(self._running.values())
        for task in running:
            task.cancel()
        if running:
            await asyncio.gather(*running, return_exceptions=True)
        if self._writes:
            await asyncio.gather(*list(self._writes), return_exceptions=True)

    async def _loop(self) -> None:
        while True:
            try:
                now = self._clock()
                await self._launch(now, None)
                await self._prune(now)
            except Exception as exc:  # noqa: BLE001 (the loop carries on; the next tick tries again)
                log.warning("An alert engine tick failed (%s); trying again.", type(exc).__name__)
            await asyncio.sleep(self._tick_seconds)

    async def _prune(self, now: datetime) -> None:
        if self._pruned_at is not None and 0 <= (now - self._pruned_at).total_seconds() < (
            PRUNE_SECONDS
        ):
            return
        self._pruned_at = now
        await self._services.alerts.prune(now)

    # -- ticks ---------------------------------------------------------------------------------

    async def tick(self, now: datetime | None = None) -> TickReport:
        """Check every due target and wait for those checks (each bounded by CHECK_SECONDS).
        With `now`, every check runs at that time."""
        moment = now if now is not None else self._clock()
        started, skipped, behind = await self._launch(moment, now)
        if started:
            await asyncio.wait(started)
        return TickReport(evaluated=len(started), skipped_running=skipped, behind=behind)

    async def _launch(
        self, now: datetime, fixed: datetime | None
    ) -> tuple[list[asyncio.Task], int, int]:
        """Start a check of every due target not already being checked; (started, skipped,
        behind)."""
        due = await self._services.alerts.due_targets(now)
        await self._count(now)
        # A held target (its check failed inside OmniKrux, or its project is gone) waits on
        # purpose: it isn't running late.
        behind = sum(
            1
            for t in due
            if t.id not in self._hold
            and t.next_eval_at is not None
            and (now - t.next_eval_at).total_seconds() > LATE_SECONDS
        )
        self._last_tick_at, self._behind = now, behind
        started: list[asyncio.Task] = []
        skipped = 0
        for target in due:
            if target.id in self._running:
                skipped += 1
                continue
            held = self._hold.get(target.id)
            if held is not None and held > now:
                continue
            task = asyncio.create_task(self._run_one(target.id, fixed))
            self._track(target.id, task)
            started.append(task)
        return started, skipped, behind

    def _track(self, target_id: str, task: asyncio.Task) -> None:
        self._running[target_id] = task
        task.add_done_callback(partial(self._untrack, target_id))

    def _untrack(self, target_id: str, task: asyncio.Task) -> None:
        if self._running.get(target_id) is task:
            del self._running[target_id]
        if not task.cancelled():
            task.exception()  # retrieved here; `_run_one` logged it, or `evaluate` raised it

    async def _run_one(self, target_id: str, fixed: datetime | None) -> None:
        """One check from the loop or a tick; never raises (but for cancellation)."""
        try:
            async with self._slots:
                now = fixed if fixed is not None else self._clock()
                await self._evaluate(target_id, now)
            self._hold.pop(target_id, None)
        except (UnknownTarget, UnknownRule):
            pass  # removed since it was due; nothing to check
        except UnknownProject:
            # Its project is gone and the target not yet removed: wait instead of asking again
            # every second.
            moment = fixed if fixed is not None else self._clock()
            self._hold[target_id] = moment + timedelta(seconds=HOLD_SECONDS)
        except Exception as exc:  # noqa: BLE001 (logged; the target waits HOLD_SECONDS)
            log.warning("Checking alert target %s failed (%s)", target_id, type(exc).__name__)
            moment = fixed if fixed is not None else self._clock()
            self._hold[target_id] = moment + timedelta(seconds=HOLD_SECONDS)

    async def _count(self, now: datetime) -> None:
        """Refresh the counts `status` reports (every COUNT_SECONDS), and forget what is kept in
        memory for targets that are gone."""
        if self._counted_at is not None and 0 <= (now - self._counted_at).total_seconds() < (
            COUNT_SECONDS
        ):
            return
        alerts = self._services.alerts
        targets = await alerts.targets()
        rules = {r.id: r for r in await alerts.list_rules()}
        live = [
            t
            for t in targets
            if t.engine == "omnikrux"
            and not t.leaving
            and t.rule_id in rules
            and not rules[t.rule_id].paused
        ]
        self._targets, self._rules = len(live), len({t.rule_id for t in live})
        self._counted_at = now
        ids = {t.id for t in targets}
        for kept in (self._cant_check_at, self._hold):
            for gone in [id for id in kept if id not in ids]:
                del kept[gone]

    def status(self, now: datetime) -> EngineStatus:
        """Whether the engine runs, when it last ticked, how many rules and targets it checks and
        how many were running late at that tick."""
        running = self._loop_task is not None and not self._loop_task.done()
        return EngineStatus(
            enabled=self.enabled,
            running=running,
            last_tick_at=self._last_tick_at,
            rules=self._rules,
            targets=self._targets,
            behind=self._behind,
        )

    # -- one check -----------------------------------------------------------------------------

    async def evaluate(self, target_id: str, now: datetime) -> TargetRecord:
        """Check one target now and return it as stored after. When a check of it is already
        running, wait for that one instead of starting another. UnknownTarget."""
        running = self._running.get(target_id)
        if running is None:
            running = asyncio.create_task(self._evaluate_slot(target_id, now))
            self._track(target_id, running)
            await running
        else:
            await asyncio.wait({running})
        return await self._services.alerts.get_target(target_id)

    async def _evaluate_slot(self, target_id: str, now: datetime) -> None:
        async with self._slots:
            await self._evaluate(target_id, now)

    async def _evaluate(self, target_id: str, now: datetime) -> None:
        alerts = self._services.alerts
        target = await alerts.get_target(target_id)
        if target.engine != "omnikrux" or target.leaving:
            return
        rule = await alerts.get_rule(target.rule_id)
        if rule.paused or rule.deleted_at is not None:
            return
        project = await self._services.projects.get(target.project_id)
        outcome = await self._read(target, rule, project, now)
        # What was read is written whatever happens to this task: `stop` waits for writes.
        write = asyncio.ensure_future(self._write(target, rule, project, outcome, now))
        self._writes.add(write)
        write.add_done_callback(self._write_done)
        await asyncio.shield(write)

    def _write_done(self, task: asyncio.Task) -> None:
        self._writes.discard(task)
        if not task.cancelled() and (exc := task.exception()) is not None:
            log.debug("An alert check's write failed (%s)", type(exc).__name__)

    async def _read(
        self, target: TargetRecord, rule: RuleRecord, project: Project, now: datetime
    ) -> list[Sample] | _Failure:
        """The samples of one check, or why there are none."""
        if target.source_id is None:
            return _Failure("error", no_source_copy(project.name, rule.source_type))
        try:
            request = QueryRequest(
                source_id=target.source_id,
                project_id=target.project_id,
                kind="instant",
                query=target.eval_expr,
                time=now.timestamp(),
            )
        except ValidationError as exc:
            return _Failure("error", field_words(exc))
        try:
            async with asyncio.timeout(CHECK_SECONDS):
                answer = await run_query(self._services, request)
        except QueryError as exc:
            if exc.code == "not_found" and exc.message == SOURCE_GONE:
                return _Failure("error", no_source_copy(project.name, rule.source_type))
            state = "unreachable" if exc.code in UNREACHABLE_CODES else "error"
            return _Failure(state, exc.message)
        except TimeoutError:
            name = await self._source_name(target.source_id)
            seconds = f"{CHECK_SECONDS:g}"
            return _Failure("unreachable", messages.TIMEOUT.format(name=name, seconds=seconds))
        except Exception as exc:  # noqa: BLE001 (a fault in OmniKrux, never read as OK)
            log.warning("An alert query failed unexpectedly (%s)", type(exc).__name__)
            return _Failure("error", CHECK_FAILED)
        if answer.result_type == "streams":
            return _Failure("error", LOG_QUERY_COPY)
        if answer.truncated:
            # Only part of the series came back: what is missing must not read as resolved.
            return _Failure("error", TOO_MANY_SERIES)
        ours = {
            "alertname": rule.name,
            "severity": rule.severity,
            "project": project.name,
            "omnikrux_rule": rule.id,
        }
        return [
            Sample(labels={**s.labels, **ours}, value=s.points[-1][1] if s.points else None)
            for s in answer.series
        ]

    async def _source_name(self, source_id: str) -> str:
        try:
            return (await self._services.sources.get(source_id)).name
        except Exception:  # noqa: BLE001 (only for the words)
            return "The source"

    async def _cant_check_due(self, target: TargetRecord, now: datetime) -> bool:
        """Whether "can't check" is to be told again: the last time was REPEAT_SECONDS ago (read
        from the history after a restart)."""
        last = self._cant_check_at.get(target.id)
        if last is None:
            entries = await self._services.alerts.history(
                rule_id=target.rule_id, project_id=target.project_id, limit=200
            )
            last = next(
                (e.at for e in entries if e.target_id == target.id and e.kind == "cant_check"),
                None,
            )
        return last is None or (now - last).total_seconds() >= REPEAT_SECONDS

    async def _write(
        self,
        target: TargetRecord,
        rule: RuleRecord,
        project: Project,
        outcome: list[Sample] | _Failure,
        now: datetime,
    ) -> None:
        """Store what one check found and ask the notifier to tell."""
        services = self._services
        alerts, notifier = services.alerts, services.notifier
        every = rule.condition.every_seconds
        result: StepResult | None = None
        cant_check = checking_again = False
        async with notifier.instances_lock(target.id):
            fresh = await alerts.get_target(target.id)
            if _moved(fresh, target):
                return  # changed while it was read: the next check reads it as it is now
            history: list[HistoryRecord] = []

            def entry(
                kind: HistoryKind,
                labels: Mapping[str, str] | None = None,
                value: float | None = None,
                message: str | None = None,
            ) -> HistoryRecord:
                return HistoryRecord(
                    id=None,
                    target_id=target.id,
                    rule_id=rule.id,
                    project_id=target.project_id,
                    at=now,
                    kind=kind,
                    labels=labels,
                    value=value,
                    message=message,
                )

            if isinstance(outcome, _Failure):
                failures = fresh.failures + 1
                cant_check = failures == CANT_CHECK_AFTER or (
                    failures > CANT_CHECK_AFTER and await self._cant_check_due(fresh, now)
                )
                if cant_check:
                    history.append(entry("cant_check", message=outcome.message))
                state, message = outcome.state, outcome.message
            else:
                # A pending timer never counts time nobody checked (a restart, a pause, a
                # long-running check): pending is kept only after a recent check.
                previous = restored(
                    await alerts.instances(target.id), fresh.last_eval_at, every, now
                )
                if fresh.failures:
                    # Nobody checked during the failures: pending timers start over.
                    previous = [p for p in previous if p.state == "firing"]
                result = step(target.id, previous, outcome, rule.condition, now)
                history += [entry("firing", r.labels, r.value) for r in result.fired]
                history += [entry("resolved", r.labels, r.value) for r in result.resolved]
                checking_again = fresh.failures >= CANT_CHECK_AFTER
                if checking_again:
                    history.append(entry("checking_again"))
                failures, state, message = 0, result.state, None
            if fresh.last_eval_at is None:
                next_eval_at = now + timedelta(seconds=first_offset(target.id, every))
            else:
                next_eval_at = now + timedelta(seconds=every)
            async with services.sessionmaker.begin() as session:
                await lock_first(session)
                row = await session.get(AlertTargetRow, target.id)
                if row is None or utc(row.updated_at) != fresh.updated_at:
                    return  # removed or changed meanwhile
                await alerts.set_eval(
                    target.id,
                    state=state,
                    message=message,
                    at=now,
                    next_eval_at=next_eval_at,
                    failures=failures,
                    session=session,
                )
                if result is not None:
                    await alerts.replace_instances(target.id, result.instances, session=session)
                await alerts.add_history(history, session=session)
        if result is not None:
            self._cant_check_at.pop(target.id, None)
        if cant_check:
            self._cant_check_at[target.id] = now
        stored = await alerts.get_target(target.id)
        try:
            if checking_again:
                await notifier.notify(stored, rule, project.name, None, "checking_again", now)
            if result is not None:
                await notifier.notify(stored, rule, project.name, result, "evaluation", now)
            if cant_check:
                await notifier.notify(stored, rule, project.name, None, "cant_check", now)
        except Exception as exc:  # noqa: BLE001 (the check is stored; the next one tells again)
            log.warning("Telling about alert target %s failed (%s)", target.id, type(exc).__name__)
