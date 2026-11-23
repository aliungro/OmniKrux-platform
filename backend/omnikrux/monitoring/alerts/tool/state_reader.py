"""The state of rules that run in a tool, read back from the tool itself.

A rule that runs in Prometheus (a PrometheusRule) or in a Loki ruler is checked by that tool, not
by OmniKrux. Every 30 s (in the alert engine's loop; nothing runs while the engine is turned
off), `refresh` reads each source that holds in-sync tool targets once: Prometheus at
`/api/v1/rules?type=alert`, Loki at `/prometheus/api/v1/rules`. Each target's own group
(`omnikrux-<target id>`) carries its state, and only the rule and alerts labelled with the
target's rule and project are taken (a group of another project or rule never leaks in):

- the rule's `state` `inactive`, `pending` or `firing` is the target's `ok`, `pending` or
  `firing`, and its alerts are the target's instances (labels, since, value); a rule whose
  `health` is `err` is `error` with the tool's `lastError`; one the tool loaded but never
  evaluated (`health` `unknown`) is still `waiting`;
- a group the tool doesn't hold is `waiting` for 10 minutes after the rule was applied (the tool
  loads rules on its own schedule), then `error`: the tool hasn't loaded it;
- a source that can't be read is `unreachable` with the transport's words (Can't check): the
  instances stay as they were and nothing is resolved by the failure.

When the target's project links an Alertmanager, its alerts for the rule mark the instances it
suppresses as `silenced` (left as they were when it can't be read). History records `firing` and
`resolved` for the moves it sees; nothing is notified: the tool's Alertmanager does that.

Every tool and every Alertmanager is read once per refresh, all at once (at most
CONCURRENT_READS together, each bounded by READ_SECONDS), before any target is stored: one tool
or Alertmanager that doesn't answer costs one timeout per refresh, never one per rule."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from collections.abc import Awaitable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from omnikrux.monitoring.alerts.evaluate import fingerprint
from omnikrux.monitoring.alerts.store import (
    LOADING,
    TOOL_WORDS,
    HistoryKind,
    HistoryRecord,
    InstanceRecord,
    RuleRecord,
    TargetRecord,
)
from omnikrux.monitoring.alerts.tool.prometheus_rule import group_name
from omnikrux.monitoring.alerts.types import TargetState
from omnikrux.monitoring.models import AlertTargetRow, lock_first, utc
from omnikrux.monitoring.projects.types import Matcher, UnknownProject
from omnikrux.monitoring.query.filters import render_matchers
from omnikrux.monitoring.sources.connector import NOT_LIKE, status_message
from omnikrux.monitoring.sources.transport import SourceUnreachable, scrub_text
from omnikrux.monitoring.sources.types import SourceConfig

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

# How often the engine's loop reads the tools.
REFRESH_SECONDS = 30
READ_SECONDS = 15.0
# Reads (tools and Alertmanagers) in flight at once in one refresh.
CONCURRENT_READS = 8
# An answer larger than this is parsed in a worker thread, not in the event loop.
THREAD_PARSE_BYTES = 256 * 1024
# How long after an apply a tool that doesn't hold the rule yet is still loading it.
LOADING_SECONDS = 600
MAX_ERROR = 300
RULES_PATHS = {"prometheus": "/api/v1/rules", "loki": "/prometheus/api/v1/rules"}

# -- copy --------------------------------------------------------------------------------------

NOT_LOADED = {
    "prometheus_rule": "Prometheus hasn't loaded this rule. Check that its ruleSelector matches.",
    "loki_ruler": "Loki hasn't loaded this rule. Check the ruler's configuration.",
}
RULES_API = "a rules API"
SOURCE_GONE = "The source this rule runs in no longer exists, so OmniKrux can't read its state."
RULE_ERROR = "{tool} couldn't check this rule."


@dataclass(frozen=True)
class _Unreadable:
    message: str


@dataclass
class _Judged:
    """What one read says about one target."""

    state: TargetState
    message: str | None
    instances: list[InstanceRecord] | None = None  # None: as they were
    history: list[HistoryRecord] = field(default_factory=list)
    failed: bool = False


_FRACTION = re.compile(r"(\.\d{6})\d+")


def parse_time(text: object) -> datetime | None:
    """An RFC 3339 time as the tools write it (nanoseconds allowed); None when it isn't one."""
    if not isinstance(text, str) or not text:
        return None
    cleaned = _FRACTION.sub(r"\1", text.strip()).replace("Z", "+00:00")
    try:
        moment = datetime.fromisoformat(cleaned)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    if moment.year < 1971:  # Go's zero time: never active
        return None
    return moment.astimezone(UTC)


async def parse_json(body: bytes) -> object:
    """The body as JSON (None when it isn't any); a large one in a worker thread, so a big rules
    answer never stalls the event loop."""

    def load() -> object:
        try:
            return json.loads(body)
        except ValueError:
            return None

    if len(body) > THREAD_PARSE_BYTES:
        return await asyncio.to_thread(load)
    return load()


def _value(text: object) -> float | None:
    try:
        value = float(text)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _labels(raw: object) -> dict[str, str]:
    if not isinstance(raw, Mapping):
        return {}
    return {str(k): str(v) for k, v in raw.items()}


def _ours(raw: Mapping, rule: RuleRecord, target: TargetRecord) -> bool:
    """Whether a rule or alert of the tool carries the target's own rule and project."""
    labels = _labels(raw.get("labels"))
    return labels.get("omnikrux_rule") == rule.id and labels.get("omnikrux_project") == (
        target.project_id
    )


def judge(
    target: TargetRecord,
    rule: RuleRecord,
    groups: Mapping[str, Sequence[Mapping]] | _Unreadable,
    previous: Sequence[InstanceRecord],
    applied_at: datetime | None,
    now: datetime,
    tool_name: str,
) -> _Judged:
    """The target's state from one read of its tool (`groups`: group name -> the groups of that
    name), its instances before, and when it was last applied."""
    tool = target.tool_kind or "prometheus_rule"
    loading = LOADING.format(tool=TOOL_WORDS[tool])
    if isinstance(groups, _Unreadable):
        return _Judged("unreachable", groups.message, failed=True)
    found = [
        entry
        for group in groups.get(group_name(target.id), ())
        for entry in (group.get("rules") or [])
        if isinstance(entry, Mapping)
        and entry.get("type", "alerting") == "alerting"
        and _ours(entry, rule, target)
    ]
    if not found:
        if applied_at is not None and (now - applied_at).total_seconds() < LOADING_SECONDS:
            return _Judged("waiting", loading)
        return _Judged("error", NOT_LOADED[tool])
    before = {i.fingerprint: i for i in previous}
    hold = timedelta(seconds=rule.condition.for_seconds)
    instances: dict[str, InstanceRecord] = {}
    states: set[str] = set()
    errors: list[str] = []
    for entry in found:
        states.add(str(entry.get("state") or ""))
        if entry.get("health") == "err":
            said = " ".join(scrub_text(str(entry.get("lastError") or "")).split())[:MAX_ERROR]
            errors.append(said or RULE_ERROR.format(tool=tool_name))
        for alert in entry.get("alerts") or []:
            if not isinstance(alert, Mapping) or not _ours(alert, rule, target):
                continue
            state = alert.get("state")
            if state not in ("pending", "firing"):
                continue
            labels = _labels(alert.get("labels"))
            fp = fingerprint(labels)
            old = before.get(fp)
            since = parse_time(alert.get("activeAt")) or (old.active_since if old else now)
            fired_at = None
            if state == "firing":
                if old is not None and old.state == "firing" and old.fired_at is not None:
                    fired_at = old.fired_at
                else:
                    fired_at = min(now, since + hold)
            instances[fp] = InstanceRecord(
                target_id=target.id,
                fingerprint=fp,
                labels=labels,
                state=state,
                active_since=since,
                fired_at=fired_at,
                value=_value(alert.get("value")),
                last_notified_at=old.last_notified_at if old is not None else None,
                silenced=old.silenced if old is not None else False,
            )
    current = sorted(instances.values(), key=lambda i: i.fingerprint)
    never_checked = all(entry.get("health") == "unknown" for entry in found)
    if errors:
        target_state: TargetState = "error"
    elif "firing" in states or any(i.state == "firing" for i in current):
        target_state = "firing"
    elif "pending" in states or current:
        target_state = "pending"
    elif never_checked:
        # Loaded but not evaluated yet (after the tool restarted, say): never "OK" before the
        # tool has checked it, and what was firing stays as it was (unknown, not resolved).
        return _Judged("waiting", loading)
    else:
        target_state = "ok"

    def entry(kind: HistoryKind, i: InstanceRecord) -> HistoryRecord:
        return HistoryRecord(
            id=None,
            target_id=target.id,
            rule_id=rule.id,
            project_id=target.project_id,
            at=now,
            kind=kind,
            labels=dict(i.labels),
            value=i.value,
        )

    history = [
        entry("firing", i)
        for i in current
        if i.state == "firing"
        and (before.get(i.fingerprint) is None or before[i.fingerprint].state != "firing")
    ]
    history += [
        entry("resolved", old)
        for fp, old in sorted(before.items())
        if old.state == "firing" and (fp not in instances or instances[fp].state != "firing")
    ]
    return _Judged(target_state, errors[0] if errors else None, current, history)


def mark_silenced(
    instances: Sequence[InstanceRecord], alerts: Sequence[Mapping]
) -> list[InstanceRecord]:
    """Each instance is silenced when an Alertmanager alert holding all its labels is
    suppressed (Alertmanager adds labels of its own, like external ones)."""
    out: list[InstanceRecord] = []
    for instance in instances:
        wanted = dict(instance.labels).items()
        silenced = any(
            isinstance((a.get("status") or {}), Mapping)
            and (a.get("status") or {}).get("state") == "suppressed"
            and wanted <= _labels(a.get("labels")).items()
            for a in alerts
            if isinstance(a, Mapping)
        )
        out.append(replace(instance, silenced=silenced))
    return out


def _held_in(target: TargetRecord) -> str | None:
    """The source whose tool holds the target's rule."""
    if target.tool_object is not None:
        return target.tool_object.source_id
    return target.source_id


class ToolStateReader:
    def __init__(self, services: MonitoringServices) -> None:
        self._services = services

    async def refresh(self, now: datetime) -> None:
        """Read every tool that holds in-sync targets, and every Alertmanager their projects
        link, once each and at once; then store what each target's group says, with nothing left
        to wait for on the network. Never raises: a failure is logged by its type, and the next
        refresh tries again."""
        try:
            await self._refresh(now)
        except Exception as exc:  # noqa: BLE001 (the loop carries on; logged by type)
            log.warning("Reading alert state from the tools failed (%s)", type(exc).__name__)

    async def _refresh(self, now: datetime) -> None:
        alerts = self._services.alerts
        rules = {r.id: r for r in await alerts.list_rules()}
        targets = [
            t
            for t in await alerts.targets()
            if t.engine == "tool"
            and not t.leaving
            and t.tool_state == "in_sync"
            and t.tool_kind in TOOL_WORDS
            and t.rule_id in rules
        ]
        if not targets:
            return
        by_source: dict[str, list[TargetRecord]] = {}
        for target in targets:
            source_id = _held_in(target)
            if source_id is not None:
                by_source.setdefault(source_id, []).append(target)
        manager_of = await self._alertmanagers({t.project_id for t in targets})
        managers = {m.id: m for m in manager_of.values() if m is not None}
        projects_of: dict[str, list[str]] = {}
        for project_id, manager in sorted(manager_of.items()):
            if manager is not None:
                projects_of.setdefault(manager.id, []).append(project_id)

        slots = asyncio.Semaphore(CONCURRENT_READS)

        async def bounded[T](work: Awaitable[T]) -> T:
            async with slots:
                return await work

        sources = list(by_source)
        results = await asyncio.gather(
            *(bounded(self._read(source_id)) for source_id in sources),
            *(bounded(self._read_alertmanager(managers[m], projects_of[m])) for m in managers),
        )
        reads: list = results[: len(sources)]
        am_alerts: dict[str, list[Mapping] | None] = dict(
            zip(managers, results[len(sources) :], strict=True)
        )
        for source_id, (name, groups) in zip(sources, reads, strict=True):
            for target in by_source[source_id]:
                manager = manager_of.get(target.project_id)
                found = am_alerts.get(manager.id) if manager is not None else None
                try:
                    await self._store(target, rules[target.rule_id], groups, name, now, found)
                except Exception as exc:  # noqa: BLE001 (the others carry on)
                    log.warning(
                        "Storing the tool state of alert target %s failed (%s)",
                        target.id,
                        type(exc).__name__,
                    )

    async def _alertmanagers(self, project_ids: set[str]) -> dict[str, SourceConfig | None]:
        """Each project's first linked Alertmanager (None when it links none)."""
        found: dict[str, SourceConfig | None] = {}
        for project_id in project_ids:
            found[project_id] = None
            try:
                project = await self._services.projects.get(project_id)
            except UnknownProject:
                continue
            for link in project.links:
                try:
                    source = await self._services.sources.get(link.source_id)
                except KeyError:
                    continue
                if source.type == "alertmanager":
                    found[project_id] = source
                    break
        return found

    async def _read_alertmanager(
        self, source: SourceConfig, project_ids: Sequence[str]
    ) -> list[Mapping] | None:
        """The alerts of OmniKrux's rules in those projects that the Alertmanager holds, read
        once per refresh; None when it can't be read (the silenced marks then stay as they
        were). Each target takes only its own rule's and project's alerts from them."""
        projects = "|".join(re.escape(p) for p in project_ids)
        params = [
            ("filter", render_matchers([Matcher("omnikrux_rule", "=~", ".+")])),
            ("filter", render_matchers([Matcher("omnikrux_project", "=~", projects)])),
        ]
        try:
            got = await self._services.transports.for_source(source).request(
                "GET", "/api/v2/alerts", params=params, timeout=READ_SECONDS
            )
        except SourceUnreachable:
            return None
        except Exception as exc:  # noqa: BLE001 (silenced marks stay as they were)
            log.warning("Reading an Alertmanager's alerts failed (%s)", type(exc).__name__)
            return None
        if got.status != 200:
            return None
        data = await parse_json(got.body)
        if not isinstance(data, list):
            return None
        return [a for a in data if isinstance(a, Mapping)]

    async def _read(self, source_id: str) -> tuple[str, dict[str, list[Mapping]] | _Unreadable]:
        """The source's name and its alerting groups by name, or why they can't be read."""
        try:
            source = await self._services.sources.get(source_id)
        except KeyError:
            return "The source", _Unreadable(SOURCE_GONE)
        path = RULES_PATHS.get(source.type)
        if path is None:
            return source.name, _Unreadable(NOT_LIKE.format(name=source.name, what=RULES_API))
        params = [("type", "alert")] if source.type == "prometheus" else []
        try:
            transport = self._services.transports.for_source(source)
            got = await transport.request("GET", path, params=params, timeout=READ_SECONDS)
        except SourceUnreachable as exc:
            return source.name, _Unreadable(exc.message)
        except Exception as exc:  # noqa: BLE001 (a fault in OmniKrux; never read as OK)
            log.warning("Reading the rules of a source failed (%s)", type(exc).__name__)
            return source.name, _Unreadable(NOT_LIKE.format(name=source.name, what=RULES_API))
        if got.status != 200:
            return source.name, _Unreadable(status_message(source.name, got.status))
        data = await parse_json(got.body)
        payload = data.get("data") if isinstance(data, dict) else None
        raw = payload.get("groups") if isinstance(payload, Mapping) else None
        if not isinstance(raw, list):
            return source.name, _Unreadable(NOT_LIKE.format(name=source.name, what=RULES_API))
        groups: dict[str, list[Mapping]] = {}
        for group in raw:
            if isinstance(group, Mapping) and isinstance(group.get("name"), str):
                groups.setdefault(group["name"], []).append(group)
        return source.name, groups

    async def _applied_at(self, target: TargetRecord) -> datetime | None:
        entries = await self._services.alerts.history(
            rule_id=target.rule_id, project_id=target.project_id, limit=200
        )
        return next(
            (e.at for e in entries if e.target_id == target.id and e.kind == "applied"), None
        )

    async def _store(
        self,
        target: TargetRecord,
        rule: RuleRecord,
        groups: dict[str, list[Mapping]] | _Unreadable,
        tool_name: str,
        now: datetime,
        am_alerts: list[Mapping] | None,
    ) -> None:
        """Store one target's state from what was read (nothing in here waits on a network)."""
        services = self._services
        alerts = services.alerts
        async with services.notifier.instances_lock(target.id):
            previous = await alerts.instances(target.id)
            applied_at = await self._applied_at(target)
            judged = judge(target, rule, groups, previous, applied_at, now, tool_name)
            if judged.instances and am_alerts is not None:
                own = [a for a in am_alerts if _ours(a, rule, target)]
                judged.instances = mark_silenced(judged.instances, own)
            async with services.sessionmaker.begin() as session:
                await lock_first(session)
                row = await session.get(AlertTargetRow, target.id)
                if (
                    row is None
                    or utc(row.updated_at) != target.updated_at
                    or row.leaving
                    or row.engine != "tool"
                    or row.tool_state != "in_sync"
                ):
                    return  # changed while it was read: the next refresh reads it as it is
                await alerts.set_eval(
                    target.id,
                    state=judged.state,
                    message=judged.message,
                    at=now,
                    next_eval_at=None,
                    failures=target.failures + 1 if judged.failed else 0,
                    session=session,
                )
                if judged.instances is not None:
                    await alerts.replace_instances(target.id, judged.instances, session=session)
                await alerts.add_history(judged.history, session=session)
