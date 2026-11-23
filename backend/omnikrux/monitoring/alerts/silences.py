"""OmniKrux's own silences: while one is active, the instances whose labels it matches stay quiet.

A silence only mutes notifications. It never changes what a check finds: a silenced instance is
pending, firing or resolved exactly as it would be without it, and is marked `silenced` so the
page can say why nobody was told.

A silence is active from `starts_at` until it ends: at `ends_at`, or earlier when it is expired
(`expired_at`). Every matcher must hold for a silence to match; a label the instance doesn't
have reads as "". Regular expressions are fully anchored, as in Alertmanager: `alertname=~"API"`
matches only the name `API`."""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.monitoring.models import SilenceRow, lock_first, now, utc
from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.filters import (
    FilterError,
    matchers_from_json,
    matchers_json,
    parse_matchers,
    render_matchers,
)
from omnikrux.monitoring.sources.connector import status_message
from omnikrux.monitoring.sources.transport import (
    Method,
    SourceTransport,
    SourceUnreachable,
    TransportResponse,
    scrub_text,
)

SilenceState = Literal["active", "pending", "expired"]

NO_MATCHERS = 'A silence needs at least one matcher, like alertname="API latency high".'
ENDS_BEFORE_START = "A silence has to end after it starts. Pick a later end."
BAD_PATTERN = "The pattern for {label} isn't a valid regular expression. Correct it and try again."
LONG_PATTERN = "The pattern for {label} is longer than 200 characters. Shorten it."
SLOW_PATTERN = "This pattern could take too long to match. Simplify it."

# Patterns run on every instance at every check, inside the event loop: they are kept short and
# without nested repetition (which can backtrack for ever), and run on bounded label values.
MAX_PATTERN = 200
MAX_MATCHED = 256
# Unbounded quantifiers (`*`, `+`, `{n,}`) one pattern may hold: side by side they backtrack
# polynomially (`.*.*.*.*x` on 1024 characters takes tens of seconds).
MAX_UNBOUNDED = 2


class UnknownSilence(KeyError):
    pass


class SilenceInvalid(ValueError):
    """The silence can't be stored as given; the text says why (and `field`, which value)."""

    def __init__(self, message: str, field: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.field = field


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


_COUNT = re.compile(r"\{(\d*)(,(\d*))?\}")


def _quantifier(text: str, i: int) -> tuple[bool, bool, int] | None:
    """When a quantifier starts at `i`: whether it repeats more than once, whether it has no
    upper bound, and where it ends."""
    c = text[i]
    if c in "*+":
        return True, True, i + 1
    if c == "?":
        return False, False, i + 1
    if c == "{" and (m := _COUNT.match(text, i)) and (m.group(1) or m.group(3)):
        low, comma, high = m.group(1), m.group(2), m.group(3)
        many = int(low) > 1 if comma is None else (not high or int(high) > 1)
        return many, comma is not None and not high, m.end()
    return None


def nested_repetition(text: str) -> bool:
    """Whether a group that repeats holds a repetition or an alternation, like `(a+)+` or
    `(a|a)*`: the nested shapes that can make a match backtrack for ever. A structural check on
    the text (escapes and character classes skipped); it may refuse a harmless pattern. Side by
    side repetitions are `unbounded_count`'s to bound."""
    return _scan(text)[0]


def unbounded_count(text: str) -> int:
    """How many quantifiers without an upper bound (`*`, `+`, `{n,}`) the pattern holds."""
    return _scan(text)[1]


def _scan(text: str) -> tuple[bool, int]:
    """(nested repetition found, unbounded quantifiers counted)."""
    unbounded = 0
    # [repeats inside, alternation inside] for the top level and each open group.
    stack = [[False, False]]
    closed: list[bool] | None = None  # the group that just closed, which a quantifier may follow
    n, i = len(text), 0
    while i < n:
        q = _quantifier(text, i) if i else None
        if q is not None:
            many, endless, i = q
            unbounded += endless
            if many and closed is not None and (closed[0] or closed[1]):
                return True, unbounded
            if many:
                stack[-1][0] = True
            if i < n and text[i] in "?+":  # lazy or possessive
                i += 1
            closed = None
            continue
        c, closed = text[i], None
        if c == "\\":
            i += 2
        elif c == "[":
            j = i + 1
            if j < n and text[j] == "^":
                j += 1
            if j < n and text[j] == "]":
                j += 1
            while j < n and text[j] != "]":
                j += 2 if text[j] == "\\" else 1
            i = j + 1
        elif c == "(":
            stack.append([False, False])
            i += 2 if i + 1 < n and text[i + 1] == "?" else 1  # `(?` opens an extension
        elif c == ")":
            if len(stack) > 1:
                group = stack.pop()
                stack[-1][0] = stack[-1][0] or group[0]
                stack[-1][1] = stack[-1][1] or group[1]
                closed = group
            i += 1
        else:
            if c == "|":
                stack[-1][1] = True
            i += 1
    return False, unbounded


def pattern_problem(label: str, value: str) -> str | None:
    """Why a pattern can't be used in a silence, or None."""
    if len(value) > MAX_PATTERN:
        return LONG_PATTERN.format(label=label)
    try:
        re.compile(value)
    except re.error:
        return BAD_PATTERN.format(label=label)
    if nested_repetition(value) or unbounded_count(value) > MAX_UNBOUNDED:
        return SLOW_PATTERN
    return None


@lru_cache(maxsize=1024)
def _pattern(value: str) -> re.Pattern[str] | None:
    """The compiled pattern; None for one a silence can't use (never stored: `create` refuses
    it)."""
    if pattern_problem("", value) is not None:
        return None
    return re.compile(value)


def _holds(matcher: Matcher, labels: Mapping[str, str]) -> bool:
    value = labels.get(matcher.label, "")
    if matcher.op == "=":
        return value == matcher.value
    if matcher.op == "!=":
        return value != matcher.value
    pattern = _pattern(matcher.value)
    if pattern is None:  # a matcher that can't be used never holds
        return False
    found = pattern.fullmatch(value[:MAX_MATCHED]) is not None
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
        if m.op in ("=~", "!~") and (problem := pattern_problem(m.label, m.value)):
            raise SilenceInvalid(problem)
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


# -- a new silence, as the routes take it ------------------------------------------------------

MAX_DAYS = 90
MAX_COMMENT = 500
MAX_MATCHERS_TEXT = 2000
NAMES_NOTHING = 'Add at least one matcher that names something, like alertname="HighErrorRate".'
END_FIRST = "The end has to be after the start."
TOO_LONG = "A silence lasts at most 90 days."
NO_COMMENT = "Say why, for whoever sees it later."
LONG_COMMENT = "Use at most 500 characters."
LONG_MATCHERS = "Use at most 2000 characters."


@dataclass(frozen=True)
class NewSilence:
    """A silence checked and ready to store, in OmniKrux or in an Alertmanager."""

    matchers: tuple[Matcher, ...]
    starts_at: datetime
    ends_at: datetime
    comment: str


def matches_empty(matcher: Matcher) -> bool:
    """Whether the matcher holds for a label the alert doesn't have (read as "")."""
    if matcher.op in ("=", "!="):
        hit = matcher.value == ""
    else:
        try:
            hit = re.fullmatch(matcher.value, "") is not None
        except re.error:
            return False
    return hit if matcher.op in ("=", "=~") else not hit


def _readable_problem(label: str, value: str) -> str | None:
    """A pattern for a tool that matches it itself (Alertmanager's regular expressions run in
    linear time): only its length, and that it can be read."""
    if len(value) > MAX_PATTERN:
        return LONG_PATTERN.format(label=label)
    try:
        re.compile(value)
    except re.error:
        return BAD_PATTERN.format(label=label)
    return None


def check_silence(
    text: str,
    starts_at: datetime | None,
    ends_at: datetime,
    comment: str,
    *,
    now: datetime,
    bound_patterns: bool = True,
) -> NewSilence:
    """The silence as given, checked: matchers that name something (each pattern short and
    readable; also quick to match when `bound_patterns`, for those OmniKrux runs itself), a start
    (now when none, or one already past), an end after it and at most 90 days later, and a
    comment of 1 to 500 characters. SilenceInvalid with the copy and the field."""
    if len(text) > MAX_MATCHERS_TEXT:
        raise SilenceInvalid(LONG_MATCHERS, "matchers")
    try:
        matchers = parse_matchers(text)
    except FilterError as exc:
        raise SilenceInvalid(str(exc), "matchers") from None
    if not matchers:
        raise SilenceInvalid(NAMES_NOTHING, "matchers")
    for m in matchers:
        if m.op not in ("=~", "!~"):
            continue
        check = pattern_problem if bound_patterns else _readable_problem
        if (problem := check(m.label, m.value)) is not None:
            raise SilenceInvalid(problem, "matchers")
    if all(matches_empty(m) for m in matchers):
        raise SilenceInvalid(NAMES_NOTHING, "matchers")
    moment = _aware(now)
    start = max(_aware(starts_at), moment) if starts_at is not None else moment
    end = _aware(ends_at)
    if end <= start:
        raise SilenceInvalid(END_FIRST, "ends_at")
    if end - start > timedelta(days=MAX_DAYS):
        raise SilenceInvalid(TOO_LONG, "ends_at")
    words = comment.strip()
    if not words:
        raise SilenceInvalid(NO_COMMENT, "comment")
    if len(words) > MAX_COMMENT:
        raise SilenceInvalid(LONG_COMMENT, "comment")
    return NewSilence(matchers=matchers, starts_at=start, ends_at=end, comment=words)


def silence_state(starts_at: datetime, ended_at: datetime, moment: datetime) -> SilenceState:
    if ended_at <= moment:
        return "expired"
    return "pending" if starts_at > moment else "active"


def matchers_text(matchers: Iterable[Matcher]) -> str:
    """The matchers as written (`alertname="X",team=~"a|b"`); a label name OmniKrux wouldn't
    write itself (an Alertmanager allows more) is shown as it is."""
    parts: list[str] = []
    for m in matchers:
        try:
            parts.append(render_matchers([m]))
        except FilterError:
            value = m.value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
            parts.append(f'{m.label}{m.op}"{value}"')
    return ",".join(parts)


# -- silences in an Alertmanager ---------------------------------------------------------------

AM_SECONDS = 15.0
AM_REFUSED = "{source} refused the silence: {message}"
AM_SILENCE_GONE = "That silence no longer exists in {source}."
AM_UNREADABLE = "{source} answered, but not with its silences. Check the source's address."
CREATED_BY = "OmniKrux"
MAX_SAID = 300
_AM_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_FRACTION = re.compile(r"(\.\d{6})\d+")


class AlertmanagerFailed(Exception):
    """An Alertmanager didn't do what was asked. `message` is words to show; `status` the HTTP
    status a route answers with (422 a refusal, 404 gone, 502 not reached or a fault there);
    `unknown` when the change may have been made anyway."""

    def __init__(self, message: str, status: int = 502, *, unknown: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.unknown = unknown


@dataclass(frozen=True)
class ToolSilence:
    """A silence as an Alertmanager holds it."""

    id: str
    matchers: tuple[Matcher, ...]
    starts_at: datetime
    ends_at: datetime
    comment: str
    created_by: str
    state: SilenceState


def _said(body: bytes) -> str:
    """What the Alertmanager said was wrong (a JSON string, or an object's message), bounded and
    without anything that looks like a credential."""
    text = body.decode("utf-8", "replace")
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    if isinstance(data, str):
        text = data
    elif isinstance(data, dict):
        found = data.get("message") or data.get("error")
        text = found if isinstance(found, str) else ""
    return " ".join(scrub_text(text).split())[:MAX_SAID]


def _am_matcher(m: Matcher) -> dict:
    return {
        "name": m.label,
        "value": m.value,
        "isRegex": m.op in ("=~", "!~"),
        "isEqual": m.op in ("=", "=~"),
    }


def _from_am_matcher(raw: object) -> Matcher | None:
    if not isinstance(raw, dict):
        return None
    name, value = raw.get("name"), raw.get("value")
    if not isinstance(name, str) or not isinstance(value, str):
        return None
    equal = raw.get("isEqual", True) is not False
    if raw.get("isRegex"):
        return Matcher(name, "=~" if equal else "!~", value)
    return Matcher(name, "=" if equal else "!=", value)


def _parse_time(text: object) -> datetime | None:
    if not isinstance(text, str) or not text:
        return None
    cleaned = _FRACTION.sub(r"\1", text.strip()).replace("Z", "+00:00")
    try:
        return _aware(datetime.fromisoformat(cleaned))
    except ValueError:
        return None


def _tool_silence(raw: object, moment: datetime) -> ToolSilence | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("id"), str):
        return None
    starts, ends = _parse_time(raw.get("startsAt")), _parse_time(raw.get("endsAt"))
    if starts is None or ends is None:
        return None
    matchers = tuple(m for raw_m in raw.get("matchers") or [] if (m := _from_am_matcher(raw_m)))
    status = raw.get("status")
    said = status.get("state") if isinstance(status, dict) else None
    state: SilenceState = (
        said if said in ("active", "pending", "expired") else silence_state(starts, ends, moment)
    )
    created_by, comment = raw.get("createdBy"), raw.get("comment")
    return ToolSilence(
        id=raw["id"],
        matchers=matchers,
        starts_at=starts,
        ends_at=ends,
        comment=comment if isinstance(comment, str) else "",
        created_by=created_by if isinstance(created_by, str) else "",
        state=state,
    )


def _json_list(got: TransportResponse) -> list | None:
    try:
        data = json.loads(got.body)
    except ValueError:
        return None
    return data if isinstance(data, list) else None


class AlertmanagerSilences:
    """An Alertmanager's silences through its v2 API, over the source's transport (its
    credentials never leave the transport, and no answer here repeats them)."""

    def __init__(self, transport: SourceTransport, name: str) -> None:
        self._transport = transport
        self._name = name

    async def _request(self, method: Method, path: str, **kwargs) -> TransportResponse:
        try:
            return await self._transport.request(method, path, timeout=AM_SECONDS, **kwargs)
        except SourceUnreachable as exc:
            unknown = exc.code in ("timeout", "unreachable")
            raise AlertmanagerFailed(exc.message, unknown=unknown) from None

    def _failed(self, got: TransportResponse) -> AlertmanagerFailed:
        if got.status in (400, 422):
            said = _said(got.body) or status_message(self._name, got.status)
            return AlertmanagerFailed(AM_REFUSED.format(source=self._name, message=said), 422)
        return AlertmanagerFailed(status_message(self._name, got.status), unknown=got.status >= 500)

    async def list(self, moment: datetime) -> list[ToolSilence]:
        """Every silence it holds. AlertmanagerFailed."""
        got = await self._request("GET", "/api/v2/silences")
        if got.status != 200:
            raise self._failed(got)
        data = _json_list(got)
        if data is None:
            raise AlertmanagerFailed(AM_UNREADABLE.format(source=self._name))
        return [s for raw in data if (s := _tool_silence(raw, _aware(moment))) is not None]

    async def alerts(self) -> list[dict]:
        """Its active alerts, silenced and inhibited ones included. AlertmanagerFailed."""
        got = await self._request("GET", "/api/v2/alerts", params=[("active", "true")])
        if got.status != 200:
            raise self._failed(got)
        data = _json_list(got)
        if data is None:
            raise AlertmanagerFailed(AM_UNREADABLE.format(source=self._name))
        return [a for a in data if isinstance(a, dict)]

    async def create(self, silence: NewSilence) -> str:
        """The new silence's id. AlertmanagerFailed (422 with its words when it refused)."""
        body = {
            "matchers": [_am_matcher(m) for m in silence.matchers],
            "startsAt": silence.starts_at.isoformat(),
            "endsAt": silence.ends_at.isoformat(),
            "createdBy": CREATED_BY,
            "comment": silence.comment,
        }
        got = await self._request(
            "POST",
            "/api/v2/silences",
            body=json.dumps(body).encode(),
            content_type="application/json",
        )
        if not 200 <= got.status < 300:
            raise self._failed(got)
        try:
            data = json.loads(got.body)
        except ValueError:
            data = None
        found = data.get("silenceID") if isinstance(data, dict) else None
        if not isinstance(found, str):
            raise AlertmanagerFailed(AM_UNREADABLE.format(source=self._name), unknown=True)
        return found

    async def expire(self, silence_id: str) -> None:
        """End it now. AlertmanagerFailed (404 when it isn't there)."""
        if _AM_ID.fullmatch(silence_id) is None:
            raise AlertmanagerFailed(AM_SILENCE_GONE.format(source=self._name), 404)
        got = await self._request("DELETE", f"/api/v2/silence/{silence_id}")
        if got.status == 404:
            raise AlertmanagerFailed(AM_SILENCE_GONE.format(source=self._name), 404)
        if not 200 <= got.status < 300:
            raise self._failed(got)
