"""OmniKrux's own silences: while one is active, the instances whose labels it matches stay quiet.

A silence only mutes notifications. It never changes what a check finds: a silenced instance is
pending, firing or resolved exactly as it would be without it, and is marked `silenced` so the
page can say why nobody was told.

A silence is active from `starts_at` until it ends: at `ends_at`, or earlier when it is expired
(`expired_at`). Every matcher must hold for a silence to match; a label the instance doesn't
have reads as "". Regular expressions are fully anchored, as in Alertmanager: `alertname=~"API"`
matches only the name `API`."""

from __future__ import annotations

import re
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.monitoring.models import SilenceRow, lock_first, now, utc
from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.filters import matchers_from_json, matchers_json

NO_MATCHERS = 'A silence needs at least one matcher, like alertname="API latency high".'
ENDS_BEFORE_START = "A silence has to end after it starts. Pick a later end."
BAD_PATTERN = "The pattern for {label} isn't a valid regular expression. Correct it and try again."


class UnknownSilence(KeyError):
    pass


class SilenceInvalid(ValueError):
    """The silence can't be stored as given; the text says why."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class Silence:
    id: str
    matchers: tuple[Matcher, ...]
    starts_at: datetime
    ends_at: datetime
    comment: str
    created_by: str
    created_at: datetime
    expired_at: datetime | None

    @property
    def ended_at(self) -> datetime:
        """When it stops (or stopped) muting: when it was expired, else its end."""
        return self.expired_at if self.expired_at is not None else self.ends_at

    def active_at(self, moment: datetime) -> bool:
        return self.starts_at <= moment < self.ended_at


@lru_cache(maxsize=1024)
def _pattern(value: str) -> re.Pattern[str] | None:
    try:
        return re.compile(value)
    except re.error:
        return None


def _holds(matcher: Matcher, labels: Mapping[str, str]) -> bool:
    value = labels.get(matcher.label, "")
    if matcher.op == "=":
        return value == matcher.value
    if matcher.op == "!=":
        return value != matcher.value
    pattern = _pattern(matcher.value)
    if (
        pattern is None
    ):  # never stored (create refuses it); a matcher that can't be read never holds
        return False
    found = pattern.fullmatch(value) is not None
    return found if matcher.op == "=~" else not found


def matches(silence: Silence, labels: Mapping[str, str]) -> bool:
    """Whether every matcher of the silence holds for these labels (regexes fully anchored)."""
    return bool(silence.matchers) and all(_holds(m, labels) for m in silence.matchers)


def silenced_by(silences: Iterable[Silence], labels: Mapping[str, str]) -> list[str]:
    """The ids of the silences that match these labels."""
    return [s.id for s in silences if matches(s, labels)]


def _aware(moment: datetime) -> datetime:
    return moment.replace(tzinfo=UTC) if moment.tzinfo is None else moment.astimezone(UTC)


def _record(row: SilenceRow) -> Silence:
    return Silence(
        id=row.id,
        matchers=matchers_from_json(row.matchers),
        starts_at=utc(row.starts_at),  # type: ignore[arg-type]
        ends_at=utc(row.ends_at),  # type: ignore[arg-type]
        comment=row.comment,
        created_by=row.created_by,
        created_at=utc(row.created_at),  # type: ignore[arg-type]
        expired_at=utc(row.expired_at),
    )


def _check(matchers: Sequence[Matcher], starts_at: datetime, ends_at: datetime) -> None:
    if not matchers:
        raise SilenceInvalid(NO_MATCHERS)
    for m in matchers:
        if m.op in ("=~", "!~") and _pattern(m.value) is None:
            raise SilenceInvalid(BAD_PATTERN.format(label=m.label))
    if ends_at <= starts_at:
        raise SilenceInvalid(ENDS_BEFORE_START)


class SilenceStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    async def _all(self) -> list[Silence]:
        async with self._sessionmaker() as session:
            rows = await session.scalars(select(SilenceRow))
            records = [_record(row) for row in rows]
        return sorted(records, key=lambda s: (s.starts_at, s.created_at, s.id))

    async def list(self, *, include_expired_since: datetime | None = None) -> list[Silence]:
        """The silences that haven't ended (active or still to start), by start; with
        `include_expired_since`, also those that ended at or after that time."""
        moment = now()
        since = _aware(include_expired_since) if include_expired_since is not None else None
        return [
            s
            for s in await self._all()
            if s.ended_at > moment or (since is not None and s.ended_at >= since)
        ]

    async def get(self, id: str) -> Silence:
        """UnknownSilence."""
        async with self._sessionmaker() as session:
            row = await session.get(SilenceRow, id)
            if row is None:
                raise UnknownSilence(id)
            return _record(row)

    async def active(self, now: datetime) -> list[Silence]:
        """The silences muting at `now`."""
        moment = _aware(now)
        return [s for s in await self._all() if s.active_at(moment)]

    async def create(
        self,
        matchers: Sequence[Matcher],
        starts_at: datetime,
        ends_at: datetime,
        comment: str,
        created_by: str,
    ) -> Silence:
        """SilenceInvalid (no matcher, a pattern that can't be read, an end not after the
        start)."""
        starts_at, ends_at = _aware(starts_at), _aware(ends_at)
        _check(matchers, starts_at, ends_at)
        row = SilenceRow(
            id=uuid.uuid4().hex,
            matchers=matchers_json(matchers),
            starts_at=starts_at,
            ends_at=ends_at,
            comment=comment,
            created_by=created_by,
            created_at=now(),
            expired_at=None,
        )
        async with self._sessionmaker.begin() as session:
            session.add(row)
            await session.flush()
            return _record(row)

    async def expire(self, id: str, at: datetime) -> Silence:
        """End the silence at `at` (one not started yet ends before it starts). A silence that
        has already ended stays as it is. UnknownSilence."""
        moment = _aware(at)
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            row = await session.get(SilenceRow, id)
            if row is None:
                raise UnknownSilence(id)
            if _record(row).ended_at > moment:
                row.expired_at = moment
            await session.flush()
            return _record(row)
