"""One check of an alert condition: breaches, the per-series state machine, and a restart."""

import math
from dataclasses import replace
from datetime import UTC, datetime, timedelta

from omnikrux.monitoring.alerts.evaluate import (
    Sample,
    breaches,
    fingerprint,
    restored,
    step,
)
from omnikrux.monitoring.alerts.store import InstanceRecord
from omnikrux.monitoring.alerts.types import Condition

C = Condition("each", "above", 0.3, 300, 60)
T0 = datetime(2026, 11, 19, 10, tzinfo=UTC)


def test_fingerprint_is_short_stable_and_order_free():
    a = fingerprint({"route": "/a", "code": "500"})
    assert a == fingerprint({"code": "500", "route": "/a"})
    assert len(a) == 16 and all(c in "0123456789abcdef" for c in a)
    assert a != fingerprint({"route": "/b", "code": "500"})
    # pairs, not joined text: these two would collide if the pairs were glued together
    assert fingerprint({"a": "b=c"}) != fingerprint({"a=b": "c"})
    assert fingerprint({}) == fingerprint({})


def test_breaches_follow_the_operator():
    assert breaches(0.31, C) and not breaches(0.3, C) and not breaches(0.2, C)
    below = Condition("each", "below", 0.3, 0, 60)
    assert breaches(0.29, below) and not breaches(0.3, below) and not breaches(0.4, below)


def test_pending_then_firing_then_resolved():
    r1 = step("t", [], [Sample({"route": "/a"}, 0.4)], C, T0)
    assert r1.state == "pending" and not r1.fired
    [pending] = r1.instances
    assert (pending.state, pending.active_since, pending.fired_at) == ("pending", T0, None)
    assert pending.target_id == "t" and pending.fingerprint == fingerprint({"route": "/a"})

    r2 = step("t", r1.instances, [Sample({"route": "/a"}, 0.5)], C, T0 + timedelta(minutes=5))
    assert r2.state == "firing" and [i.labels["route"] for i in r2.fired] == ["/a"]
    [firing] = r2.instances
    assert firing.fired_at == T0 + timedelta(minutes=5) and firing.active_since == T0
    assert firing.value == 0.5

    r3 = step("t", r2.instances, [Sample({"route": "/a"}, 0.1)], C, T0 + timedelta(minutes=6))
    assert r3.state == "ok" and len(r3.resolved) == 1 and not r3.instances
    assert r3.resolved[0].value == 0.1


def test_pending_waits_until_for_has_passed():
    r1 = step("t", [], [Sample({"route": "/a"}, 0.4)], C, T0)
    r2 = step("t", r1.instances, [Sample({"route": "/a"}, 0.6)], C, T0 + timedelta(minutes=4))
    assert r2.state == "pending" and not r2.fired
    assert r2.instances[0].value == 0.6 and r2.instances[0].active_since == T0


def test_firing_stays_firing_and_is_told_once():
    r1 = step("t", [], [Sample({"route": "/a"}, 0.4)], C, T0)
    r2 = step("t", r1.instances, [Sample({"route": "/a"}, 0.5)], C, T0 + timedelta(minutes=5))
    told = replace(r2.instances[0], last_notified_at=T0, silenced=True)
    r3 = step("t", [told], [Sample({"route": "/a"}, 0.7)], C, T0 + timedelta(minutes=6))
    assert r3.state == "firing" and not r3.fired and not r3.resolved
    [still] = r3.instances
    assert still.fired_at == T0 + timedelta(minutes=5) and still.value == 0.7
    assert still.last_notified_at == T0 and still.silenced is True


def test_pending_that_stops_breaching_drops_without_resolving():
    r1 = step("t", [], [Sample({"route": "/a"}, 0.4)], C, T0)
    r2 = step("t", r1.instances, [Sample({"route": "/a"}, 0.2)], C, T0 + timedelta(minutes=1))
    assert r2.state == "ok" and not r2.instances and not r2.resolved


def test_for_zero_fires_at_once():
    now0 = Condition("each", "above", 0.3, 0, 60)
    r = step("t", [], [Sample({"route": "/a"}, 0.4), Sample({"route": "/b"}, 0.1)], now0, T0)
    assert r.state == "firing"
    assert [i.labels["route"] for i in r.fired] == ["/a"]
    assert r.instances[0].fired_at == T0 and r.instances[0].active_since == T0


def test_no_samples_is_no_data_and_resolves():
    now0 = Condition("each", "above", 0.3, 0, 60)
    r1 = step("t", [], [Sample({"route": "/a"}, 0.4)], now0, T0)
    r2 = step("t", r1.instances, [], now0, T0 + timedelta(minutes=1))
    assert r2.state == "no_data" and not r2.instances
    assert [i.labels["route"] for i in r2.resolved] == ["/a"]


def test_a_series_that_disappears_resolves_while_others_fire():
    now0 = Condition("each", "above", 0.3, 0, 60)
    both = [Sample({"route": "/a"}, 0.4), Sample({"route": "/b"}, 0.5)]
    r1 = step("t", [], both, now0, T0)
    r2 = step("t", r1.instances, [Sample({"route": "/b"}, 0.5)], now0, T0 + timedelta(minutes=1))
    assert r2.state == "firing"
    assert [i.labels["route"] for i in r2.resolved] == ["/a"]
    assert [i.labels["route"] for i in r2.instances] == ["/b"]


def test_nan_and_none_never_breach():
    assert not breaches(None, C) and not breaches(math.nan, C)
    below = Condition("each", "below", 0.3, 0, 60)
    assert not breaches(None, below) and not breaches(math.nan, below)
    r = step("t", [], [Sample({"route": "/a"}, None), Sample({"route": "/b"}, math.nan)], C, T0)
    assert not r.instances


def test_only_missing_values_is_no_data():
    nothing = [Sample({"route": "/a"}, None), Sample({"route": "/b"}, math.nan)]
    assert step("t", [], nothing, C, T0).state == "no_data"
    one = [Sample({"route": "/a"}, None), Sample({"route": "/b"}, 0.1)]
    assert step("t", [], one, C, T0).state == "ok"
    # a firing series whose value turns into NaN (0/0) resolves, and the target has no data
    now0 = Condition("each", "above", 0.3, 0, 60)
    r1 = step("t", [], [Sample({"route": "/a"}, 0.4)], now0, T0)
    r2 = step("t", r1.instances, [Sample({"route": "/a"}, math.nan)], now0, T0)
    assert r2.state == "no_data" and len(r2.resolved) == 1


def test_an_instance_never_keeps_a_value_that_isnt_a_number():
    now0 = Condition("each", "above", 0.3, 0, 60)
    r1 = step("t", [], [Sample({"route": "/a"}, math.inf)], now0, T0)
    assert r1.state == "firing" and r1.instances[0].value is None
    assert r1.fired[0].value is None
    r2 = step("t", r1.instances, [Sample({"route": "/a"}, math.nan)], now0, T0)
    assert r2.resolved[0].value is None
    below = Condition("each", "below", 0.3, 0, 60)
    r3 = step("t", [], [Sample({"route": "/a"}, -math.inf)], below, T0)
    assert r3.state == "firing" and r3.instances[0].value is None


def test_total_and_each_share_the_rules():
    total = Condition("total", "below", 5, 0, 60)
    r = step("t", [], [Sample({}, 3.0)], total, T0)
    assert r.state == "firing" and r.fired[0].labels == {}


def _instance(state: str, fp: str) -> InstanceRecord:
    return InstanceRecord(
        target_id="t",
        fingerprint=fp,
        labels={"fp": fp},
        state=state,  # type: ignore[arg-type]
        active_since=T0,
        fired_at=T0 if state == "firing" else None,
        value=1.0,
        last_notified_at=None,
    )


def test_restored_keeps_firing_and_recent_pending():
    previous = [_instance("firing", "f1"), _instance("pending", "p1")]
    now = T0 + timedelta(hours=1)
    stale = restored(previous, now - timedelta(seconds=150), 60, now)
    assert [r.fingerprint for r in stale] == ["f1"]
    recent = restored(previous, now - timedelta(seconds=100), 60, now)
    assert [r.fingerprint for r in recent] == ["f1", "p1"]
    exactly = restored(previous, now - timedelta(seconds=120), 60, now)
    assert [r.fingerprint for r in exactly] == ["f1", "p1"]
    never = restored(previous, None, 60, now)
    assert [r.fingerprint for r in never] == ["f1"]
