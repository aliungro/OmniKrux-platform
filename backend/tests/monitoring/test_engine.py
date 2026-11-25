"""OmniKrux's alert engine, driven by `tick(now)` at fixed times over the fake Prometheus: what it
reads, the states it stores, when it tells, and how it fails, overlaps, restarts and stops."""

import asyncio
import logging

from sqlalchemy import delete

from omnikrux.monitoring.alerts.engine import (
    NOTE_BEHIND,
    NOTE_DISABLED,
    NOTE_ON_TIME,
    TOO_MANY_SERIES,
    AlertEngine,
    engine_note,
)
from omnikrux.monitoring.alerts.rule_expr import LOG_QUERY_COPY
from omnikrux.monitoring.alerts.store import RuleSpec, TargetSpec
from omnikrux.monitoring.alerts.types import Condition
from omnikrux.monitoring.models import ProjectRecord
from omnikrux.monitoring.query.series import MAX_SERIES
from tests.monitoring.alert_env import (
    HOUR,
    MIN,
    NAME,
    SEC,
    SENT,
    T0,
    closed_port_url,
    until,
    vector,
)


def kinds(history) -> list[str]:
    return [h.kind for h in reversed(history)]


async def test_firing_reaches_the_webhook_once(engine_env):
    env = engine_env
    # "API latency high": each series above 0.3 for 5m, every 1m; the fake answers 0.4 for /a.
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule()

    await env.tick(T0)
    assert (await env.target(rule)).state == "pending"
    assert env.webhook.requests == []
    await env.tick(T0 + 5 * MIN)
    assert [b["status"] for b in env.webhook.bodies()] == ["firing"]
    await env.tick(T0 + 6 * MIN)
    assert len(env.webhook.requests) == 1  # still firing, not repeated within 4 h

    # Every query went through the project's filter, at the time of the check.
    sent = env.queries()
    assert [q.params["query"] for q in sent] == [[SENT]] * 3
    assert float(sent[1].params["time"][0]) == (T0 + 5 * MIN).timestamp()

    [body] = env.webhook.bodies()
    assert body["rule"] == NAME and body["project"] == "Shop" and body["severity"] == "warning"
    [alert] = body["alerts"]
    assert alert["labels"] == {
        "route": "/a",
        "alertname": NAME,
        "severity": "warning",
        "project": "Shop",
        "omnikrux_rule": rule.id,
    }
    assert alert["value"] == 0.4 and alert["ends_at"] is None

    target = await env.target(rule)
    assert target.state == "firing" and target.failures == 0 and target.message is None
    assert target.last_eval_at == T0 + 6 * MIN and target.next_eval_at == T0 + 7 * MIN
    [instance] = await env.instances(rule)
    assert instance.state == "firing" and instance.fired_at == T0 + 5 * MIN
    assert instance.last_notified_at == T0 + 5 * MIN and not instance.silenced
    assert kinds(await env.services.alerts.history(rule_id=rule.id)) == ["firing"]
    [delivery] = await env.services.contact_points.deliveries()
    assert (delivery.kind, delivery.ok, delivery.target_id) == ("firing", True, target.id)
    cp = await env.services.contact_points.get(env.cp_id)
    assert cp.last_delivery_ok is True


async def test_first_check_spreads_the_next_one(engine_env):
    env = engine_env
    rule, _ = await env.add_rule()
    await env.tick(T0)
    first = (await env.target(rule)).next_eval_at
    assert T0 < first <= T0 + MIN
    await env.tick(first)
    assert (await env.target(rule)).next_eval_at == first + MIN
    assert (await env.engine.tick(first + MIN - MIN / 2)).evaluated == 0  # not due yet


async def test_resolved_is_sent_once(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0)
    await env.tick(T0)
    del env.prom.results[SENT]  # the series is gone
    await env.tick(T0 + MIN)
    await env.tick(T0 + 2 * MIN)
    assert [b["status"] for b in env.webhook.bodies()] == ["firing", "resolved"]
    [alert] = env.webhook.bodies()[1]["alerts"]
    assert alert["ends_at"] == (T0 + MIN).isoformat()
    assert (await env.target(rule)).state == "no_data"
    assert await env.instances(rule) == []
    assert kinds(await env.services.alerts.history(rule_id=rule.id)) == ["firing", "resolved"]


async def test_unreachable_source_is_its_own_state(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0)
    await env.tick(T0)
    assert (await env.target(rule)).state == "firing"

    await env.move_source(closed_port_url())  # the fake stops answering: a closed port
    await env.tick(T0 + MIN)
    target = await env.target(rule)
    assert target.state == "unreachable" and target.message.startswith("Can't reach")
    assert target.failures == 1 and target.last_eval_at == T0 + MIN
    [instance] = await env.instances(rule)
    assert instance.state == "firing"  # never resolved by a failed check
    assert [b["status"] for b in env.webhook.bodies()] == ["firing"]
    assert kinds(await env.services.alerts.history(rule_id=rule.id)) == ["firing"]


async def test_bad_query_is_an_error_not_unreachable(engine_env):
    env = engine_env
    env.prom.errors[SENT] = 'parse error: unexpected "}"'
    rule, _ = await env.add_rule()
    await env.tick(T0)
    target = await env.target(rule)
    assert target.state == "error" and target.failures == 1
    assert target.message and "parse error" in target.message


async def test_cant_check_is_notified_once_then_repeats(engine_env):
    env = engine_env
    rule, _ = await env.add_rule()
    env.prom.mode = "error500"  # answers HTTP 500: can't be read
    for minute in range(5):  # the 3rd failure tells; the 4th and 5th don't
        await env.tick(T0 + minute * MIN)
    assert [b["status"] for b in env.webhook.bodies()] == ["cant_check"]
    body = env.webhook.bodies()[0]
    assert body["summary"].startswith("OmniKrux couldn't check this rule 3 times in a row.")
    assert "answered HTTP 500" in body["summary"]
    assert (await env.target(rule)).failures == 5

    await env.tick(T0 + 2 * MIN + 4 * HOUR - MIN)  # not yet 4 hours since the notice
    await env.tick(T0 + 2 * MIN + 4 * HOUR)
    assert [b["status"] for b in env.webhook.bodies()] == ["cant_check", "cant_check"]

    env.prom.mode = "ok"
    await env.tick(T0 + 5 * HOUR)
    await env.tick(T0 + 5 * HOUR + MIN)
    statuses = [b["status"] for b in env.webhook.bodies()]
    assert statuses == ["cant_check", "cant_check", "checking_again"]
    target = await env.target(rule)
    assert target.state == "no_data" and target.failures == 0 and target.message is None
    history = kinds(await env.services.alerts.history(rule_id=rule.id))
    assert history == ["cant_check", "cant_check", "checking_again"]


async def test_cant_check_repeat_survives_a_restart(engine_env):
    env = engine_env
    _rule, _ = await env.add_rule()
    env.prom.mode = "error500"
    for minute in range(3):
        await env.tick(T0 + minute * MIN)
    restarted = AlertEngine(env.services, enabled=False)
    await restarted.tick(T0 + 3 * MIN)
    await restarted.tick(T0 + HOUR)
    assert await env.notifier.drain(10)
    assert [b["status"] for b in env.webhook.bodies()] == ["cant_check"]  # read from history


async def test_a_failure_never_lets_a_pending_timer_run(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule()  # 5 minutes
    await env.tick(T0)
    env.prom.mode = "error500"
    for minute in range(1, 6):
        await env.tick(T0 + minute * MIN)
    [held] = await env.instances(rule)
    assert held.state == "pending" and held.active_since == T0  # kept as it was
    env.prom.mode = "ok"
    await env.tick(T0 + 6 * MIN)
    [instance] = await env.instances(rule)
    assert instance.state == "pending" and instance.active_since == T0 + 6 * MIN
    assert [b["status"] for b in env.webhook.bodies()] == ["cant_check", "checking_again"]


async def test_restart_while_firing_sends_nothing_new(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0)
    await env.tick(T0)
    assert len(env.webhook.requests) == 1

    restarted = AlertEngine(env.services, enabled=False)  # a new engine over the same store
    await restarted.tick(T0 + MIN)
    assert await env.notifier.drain(10)
    assert len(env.webhook.requests) == 1
    assert (await env.target(rule)).state == "firing"
    [instance] = await env.instances(rule)
    assert instance.fired_at == T0 and instance.last_notified_at == T0


async def test_restart_after_a_long_pause_restarts_pending(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule()
    await env.tick(T0)
    restarted = AlertEngine(env.services, enabled=False)
    await restarted.tick(T0 + HOUR)  # nobody checked for an hour: the 5 minutes start over
    [instance] = await env.instances(rule)
    assert instance.state == "pending" and instance.active_since == T0 + HOUR


async def test_paused_and_tool_targets_are_not_evaluated(engine_env):
    env = engine_env
    paused, _ = await env.add_rule(name="Paused")
    await env.services.alerts.set_paused(paused.id, True)
    await env.add_rule(name="In the cluster", engine="tool")
    report = await env.tick(T0)
    assert report.evaluated == 0
    assert env.queries() == []


async def test_a_target_without_a_source_is_an_error(engine_env):
    env = engine_env
    rule, _ = await env.add_rule(source_id=None)
    await env.tick(T0)
    target = await env.target(rule)
    assert target.state == "error"
    assert target.message == (
        "Shop has no Prometheus-compatible source for this rule. Link one on the project page."
    )
    await env.services.sources.delete(env.source_id)
    other, _ = await env.add_rule(name="Gone source", source_id=env.source_id)
    await env.tick(T0 + MIN)
    gone = await env.target(other)
    assert gone.state == "error" and gone.message == target.message


async def test_loki_streams_are_an_error(monitoring_app, linked_project_with_loki):
    _, app = monitoring_app
    services = app.state.monitoring
    shop = linked_project_with_loki
    rule = await services.alerts.create_rule(
        RuleSpec(
            name="Errors",
            scope_kind="project",
            scope_id=shop.project_id,
            source_type="loki",
            source_id=None,
            expr='{app="api"} |= "error"',
            condition=Condition("each", "above", 1, 0, 60),
        )
    )
    await services.alerts.put_targets(
        rule.id,
        [
            TargetSpec(
                project_id=shop.project_id,
                engine="omnikrux",
                engine_note=None,
                source_id=shop.loki_source_id,
                eval_expr='{app="api"} |= "error"',
                rule_text="",
            )
        ],
    )
    engine = AlertEngine(services, enabled=False)
    await engine.tick(T0)
    [target] = await services.alerts.targets(rule_id=rule.id)
    assert (target.state, target.message) == ("error", LOG_QUERY_COPY)


async def test_targets_never_overlap(engine_env):
    env = engine_env
    rule, _ = await env.add_rule()
    env.prom.mode = "hang"
    first = asyncio.create_task(env.engine.tick(T0))
    await until(lambda: len(env.queries()) == 1)
    report = await env.engine.tick(T0 + MIN)
    assert (report.evaluated, report.skipped_running) == (0, 1)
    assert len(env.queries()) == 1

    env.prom.mode = "ok"
    env.prom.release.set()
    assert (await first).evaluated == 1
    assert (await env.target(rule)).last_eval_at == T0


async def test_a_slow_rule_does_not_hold_up_the_others(engine_env):
    env = engine_env
    slow, _ = await env.add_rule(name="Slow", expr="slow_metric")
    env.prom.mode = "hang"
    first = asyncio.create_task(env.engine.tick(T0))
    await until(lambda: len(env.queries()) == 1)
    # The hanging request stays blocked; new ones answer at once.
    gate, env.prom.release, env.prom.mode = env.prom.release, asyncio.Event(), "ok"
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    quick, _ = await env.add_rule(for_seconds=0)
    report = await env.engine.tick(T0 + MIN)
    assert (report.evaluated, report.skipped_running) == (1, 1)
    assert (await env.target(quick)).state == "firing"
    assert (await env.target(slow)).last_eval_at is None  # still being checked
    gate.set()
    await first
    assert (await env.target(slow)).state == "no_data"


async def test_checks_run_at_most_concurrency_at_once(engine_env):
    env = engine_env
    engine = AlertEngine(env.services, enabled=False, concurrency=1)
    await env.add_rule(name="One")
    await env.add_rule(name="Two", expr="other_metric")
    env.prom.mode = "hang"
    ticking = asyncio.create_task(engine.tick(T0))
    await until(lambda: len(env.queries()) == 1)
    await asyncio.sleep(0.05)
    assert len(env.queries()) == 1  # the second waits for the slot
    env.prom.mode = "ok"
    env.prom.release.set()
    assert (await ticking).evaluated == 2
    assert len(env.queries()) == 2


async def test_status_reports_behind(engine_env):
    env = engine_env
    engine = AlertEngine(env.services, enabled=True)  # never started: driven by ticks
    await env.add_rule()
    await env.add_rule(name="Other", for_seconds=0)
    report = await engine.tick(T0)
    assert report.behind == 0
    status = engine.status(T0)
    assert (status.enabled, status.running, status.last_tick_at) == (True, False, T0)
    assert (status.rules, status.targets, status.behind) == (2, 2, 0)
    assert engine_note(status) == NOTE_ON_TIME

    report = await engine.tick(T0 + 10 * MIN)  # both were due minutes ago
    assert report.behind == 2 and report.evaluated == 2
    status = engine.status(T0 + 10 * MIN)
    assert status.behind == 2
    assert engine_note(status) == NOTE_BEHIND.format(n=2)
    assert engine_note(status) == (
        "OmniKrux's alert checks are running late (2 rules waiting). Results may be delayed."
    )
    assert (await engine.tick(T0 + 11 * MIN)).behind == 0

    off = AlertEngine(env.services, enabled=False)
    assert engine_note(off.status(T0)) == NOTE_DISABLED


async def test_disabled_engine_starts_nothing(monitoring_app):
    _, app = monitoring_app
    engine = app.state.monitoring.engine  # the app's (OMNIKRUX_ALERT_ENGINE=false in tests)
    engine.start()
    status = engine.status(T0)
    assert (status.enabled, status.running, status.last_tick_at) == (False, False, None)
    await engine.stop()


async def test_the_loop_survives_exceptions_and_stops_cleanly(engine_env, caplog, monkeypatch):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0)
    alerts = env.services.alerts
    real = alerts.due_targets
    calls = []

    async def flaky(now):
        calls.append(now)
        if len(calls) == 1:
            raise RuntimeError("database went away")
        return await real(now)

    monkeypatch.setattr(alerts, "due_targets", flaky)
    engine = AlertEngine(env.services, enabled=True)
    engine._tick_seconds = 0.01
    env.services.engine = engine
    with caplog.at_level(logging.WARNING):
        engine.start()
        engine.start()  # a second start changes nothing
        assert engine.status(T0).running
        await until(lambda: len(calls) >= 3)
        await until(lambda: len(env.webhook.requests) == 1)
        await engine.stop()
    assert not engine.status(T0).running
    assert "An alert engine tick failed (RuntimeError)" in caplog.text
    assert "database went away" not in caplog.text
    assert (await env.target(rule)).state == "firing"
    seen = len(calls)
    await asyncio.sleep(0.05)
    assert len(calls) == seen  # stopped: no more ticks


async def test_a_resumed_rule_starts_its_pending_timer_over(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule()  # 5 minutes
    await env.tick(T0)
    await env.services.alerts.set_paused(rule.id, True)
    assert (await env.tick(T0 + 30 * MIN)).evaluated == 0  # paused: not checked
    await env.services.alerts.set_paused(rule.id, False)
    await env.tick(T0 + HOUR)
    [instance] = await env.instances(rule)
    assert instance.state == "pending" and instance.active_since == T0 + HOUR
    assert (await env.target(rule)).state == "pending"
    assert env.webhook.requests == []  # nobody checked while it was paused: nothing fired


async def test_a_cut_off_answer_is_an_error(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0)
    await env.tick(T0)
    # More series than a query keeps: the first ones come back, /a is cut off.
    many = [({"route": f"/r{i:04d}"}, 0.1) for i in range(MAX_SERIES)] + [({"route": "/a"}, 0.4)]
    env.prom.results[SENT] = vector(*many)
    await env.tick(T0 + MIN)
    await env.tick(T0 + 2 * MIN)
    target = await env.target(rule)
    assert (target.state, target.message, target.failures) == ("error", TOO_MANY_SERIES, 2)
    assert target.message == (
        "This rule matches more than 2000 series, so OmniKrux can't check all of them. "
        "Narrow the query with a label, or alert on the total."
    )
    [instance] = await env.instances(rule)
    assert instance.state == "firing" and instance.labels["route"] == "/a"
    assert [b["status"] for b in env.webhook.bodies()] == ["firing"]  # nothing resolved
    assert kinds(await env.services.alerts.history(rule_id=rule.id)) == ["firing"]


async def test_an_orphaned_target_is_held_and_not_behind(engine_env):
    env = engine_env
    rule, _ = await env.add_rule()
    await env.tick(T0)
    # The project goes without its targets (until the fan-out removes them).
    async with env.services.sessionmaker.begin() as session:
        await session.execute(delete(ProjectRecord).where(ProjectRecord.id == env.project_id))
    asked = len(env.queries())
    await env.engine.tick(T0 + 10 * MIN)  # it can't be checked and is held
    report = await env.engine.tick(T0 + 10 * MIN + 30 * SEC)
    assert (report.evaluated, report.behind) == (0, 0)
    assert env.engine.status(T0).behind == 0
    report = await env.engine.tick(T0 + 12 * MIN)  # tried again after the hold, held again
    assert (report.evaluated, report.behind) == (1, 0)
    assert len(env.queries()) == asked  # it never reached the source
    assert (await env.target(rule)).last_eval_at == T0


async def test_late_checks_keep_the_pending_timer(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=120, every=30)
    late = 70 * SEC  # every 30 s, each check 40 s late (a busy engine)
    await env.tick(T0)
    await env.tick(T0 + late)
    [instance] = await env.instances(rule)
    assert instance.state == "pending" and instance.active_since == T0
    await env.tick(T0 + 2 * late)  # 140 s since it started: past `for`, on time
    [instance] = await env.instances(rule)
    assert instance.state == "firing" and instance.fired_at == T0 + 2 * late
    assert [b["status"] for b in env.webhook.bodies()] == ["firing"]
