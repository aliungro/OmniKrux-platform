"""OmniKrux's silences: anchored matchers, when a silence is active, and expiring one."""

from datetime import UTC, datetime, timedelta

import pytest

from omnikrux.monitoring.alerts.silences import (
    BAD_PATTERN,
    ENDS_BEFORE_START,
    LONG_PATTERN,
    MAX_MATCHED,
    NO_MATCHERS,
    SLOW_PATTERN,
    Silence,
    SilenceInvalid,
    UnknownSilence,
    matches,
    nested_repetition,
    silenced_by,
)
from omnikrux.monitoring.models import now
from omnikrux.monitoring.projects.types import Matcher

T0 = datetime(2026, 11, 19, 10, 0, tzinfo=UTC)
MIN = timedelta(minutes=1)
DAY = timedelta(days=1)
LABELS = {"alertname": "API latency high", "route": "/a", "severity": "warning"}


def silence(*matchers: Matcher, id: str = "s1") -> Silence:
    return Silence(
        id=id,
        matchers=matchers,
        starts_at=T0,
        ends_at=T0 + MIN,
        comment="",
        created_by="local",
        created_at=T0,
        expired_at=None,
    )


def test_matchers_are_anchored():
    assert not matches(silence(Matcher("alertname", "=~", "API")), LABELS)
    assert matches(silence(Matcher("alertname", "=~", "API.*")), LABELS)
    assert matches(silence(Matcher("alertname", "!~", "API")), LABELS)
    assert not matches(silence(Matcher("alertname", "!~", "API latency.+")), LABELS)


@pytest.mark.parametrize(
    "matcher, expected",
    [
        (Matcher("alertname", "=", "API latency high"), True),
        (Matcher("alertname", "=", "api latency high"), False),
        (Matcher("route", "!=", "/b"), True),
        (Matcher("route", "!=", "/a"), False),
        (Matcher("missing", "=", ""), True),  # a label it doesn't have reads as ""
        (Matcher("missing", "=~", ".+"), False),
        (Matcher("route", "=~", "("), False),  # a pattern that can't be read never holds
    ],
)
def test_each_operator(matcher, expected):
    assert matches(silence(matcher), LABELS) is expected


def test_every_matcher_must_hold():
    both = silence(Matcher("alertname", "=", "API latency high"), Matcher("route", "=", "/b"))
    assert not matches(both, LABELS)
    assert not matches(silence(), LABELS)  # no matcher matches nothing
    many = [
        silence(Matcher("route", "=", "/a"), id="a"),
        silence(Matcher("route", "=", "/b"), id="b"),
        silence(Matcher("severity", "=~", "warning|critical"), id="c"),
    ]
    assert silenced_by(many, LABELS) == ["a", "c"]


async def test_expire_ends_a_silence(stores):
    store = _store(stores)
    start = now() - 10 * MIN
    s = await store.create(
        (Matcher("alertname", "=", "API latency high"),), start, start + 60 * MIN, "Deploy", "local"
    )
    assert s.comment == "Deploy" and s.created_by == "local" and s.expired_at is None
    moment = now()
    assert [x.id for x in await store.active(moment)] == [s.id]
    assert [x.id for x in await store.list()] == [s.id]

    expired = await store.expire(s.id, moment)
    assert expired.expired_at == moment and expired.ends_at == start + 60 * MIN
    assert await store.active(moment) == []
    assert await store.active(moment - MIN) != []  # it was active before
    assert await store.list() == []
    assert [x.id for x in await store.list(include_expired_since=start)] == [s.id]
    assert await store.list(include_expired_since=moment + MIN) == []
    # Expiring again changes nothing.
    assert (await store.expire(s.id, moment + 10 * MIN)).expired_at == moment
    with pytest.raises(UnknownSilence):
        await store.expire("nope", moment)


async def test_a_silence_is_active_only_between_start_and_end(stores):
    store = _store(stores)
    s = await store.create((Matcher("route", "=", "/a"),), T0, T0 + MIN, "", "local")
    assert await store.active(T0 - timedelta(seconds=1)) == []
    assert [x.id for x in await store.active(T0)] == [s.id]
    assert await store.active(T0 + MIN) == []
    assert (await store.get(s.id)).matchers == (Matcher("route", "=", "/a"),)


async def test_create_refuses_what_cant_work(stores):
    store = _store(stores)
    with pytest.raises(SilenceInvalid) as no_matchers:
        await store.create((), T0, T0 + MIN, "", "local")
    assert no_matchers.value.message == NO_MATCHERS
    with pytest.raises(SilenceInvalid) as backwards:
        await store.create((Matcher("a", "=", "b"),), T0, T0, "", "local")
    assert backwards.value.message == ENDS_BEFORE_START
    with pytest.raises(SilenceInvalid) as pattern:
        await store.create((Matcher("route", "=~", "("),), T0, T0 + MIN, "", "local")
    assert pattern.value.message == BAD_PATTERN.format(label="route")


def _store(stores):
    from omnikrux.monitoring.alerts.silences import SilenceStore

    return SilenceStore(stores.sessionmaker)


@pytest.mark.parametrize(
    "pattern, slow",
    [
        ("(a|a)*", True),
        ("(a+)+", True),
        ("(?:a*)*", True),
        ("((a+))+", True),
        ("(a|b){2,}", True),
        ("(x(a|b))+", True),
        ("(a{2})+", True),
        ("API.*", False),
        ("[a-z]+", False),
        ("(foo|bar)", False),
        ("foo|bar", False),
        ("(ab)*", False),
        ("(a+)?", False),
        ("[(a+)]+", False),
        (r"\(a+\)+", False),
        ("(a{1})+", False),
    ],
)
def test_nested_repetition_is_found(pattern, slow):
    assert nested_repetition(pattern) is slow


async def test_create_refuses_patterns_that_could_stall(stores):
    store = _store(stores)
    for value, copy in (
        ("(a|a)*", SLOW_PATTERN),
        ("(a+)+b", SLOW_PATTERN),
        ("a" * 201, LONG_PATTERN.format(label="route")),
        ("(", BAD_PATTERN.format(label="route")),
    ):
        with pytest.raises(SilenceInvalid) as refused:
            await store.create((Matcher("route", "!~", value),), T0, T0 + MIN, "", "local")
        assert refused.value.message == copy
    assert SLOW_PATTERN == "This pattern could take too long to match. Simplify it."
    assert LONG_PATTERN.format(label="route") == (
        "The pattern for route is longer than 200 characters. Shorten it."
    )
    kept = await store.create((Matcher("route", "=~", "a" * 200),), T0, T0 + MIN, "", "local")
    assert kept.matchers[0].value == "a" * 200


def test_patterns_run_on_bounded_values_and_unusable_ones_never_hold():
    long_value = "x" * (MAX_MATCHED + 500)
    assert matches(silence(Matcher("route", "=~", "x+")), {"route": long_value})
    assert not matches(silence(Matcher("route", "=~", "(a+)+")), {"route": "aaaa"})
    assert not matches(silence(Matcher("route", "!~", "(a|a)*")), {"route": "b"})


async def test_prune_drops_silences_ended_a_week_ago(stores):
    store = _store(stores)
    moment = now()
    old = await store.create((Matcher("a", "=", "1"),), moment - 9 * DAY, moment - 8 * DAY, "", "x")
    recent = await store.create((Matcher("a", "=", "2"),), moment - 3 * DAY, moment - DAY, "", "x")
    expired = await store.create((Matcher("a", "=", "3"),), moment - 9 * DAY, moment + DAY, "", "x")
    await store.expire(expired.id, moment - 8 * DAY)
    live = await store.create((Matcher("a", "=", "4"),), moment - DAY, moment + DAY, "", "x")
    assert await stores.alerts.prune(moment) == 2
    left = await store.list(include_expired_since=moment - 30 * DAY)
    assert sorted(s.id for s in left) == sorted([recent.id, live.id])
    assert old.id not in {s.id for s in left}
