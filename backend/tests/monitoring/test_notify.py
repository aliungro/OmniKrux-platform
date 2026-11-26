"""The notifier: one grouped message per rule and check, repeats, silences, failed and slow
deliveries, and incident keys that pair up."""

from omnikrux.monitoring.alerts.contact_points.senders import email_message
from omnikrux.monitoring.alerts.contact_points.types import ContactPoint, Notice
from omnikrux.monitoring.alerts.notify import REPEAT_SECONDS, Notifier, dedup_key
from omnikrux.monitoring.projects.types import Matcher
from tests.monitoring.alert_env import HOUR, MIN, NAME, SENT, T0, until, vector

ROUTING_KEY = "R0utingKeySECRET8abcdefghijklmno"


def statuses(env) -> list[str]:
    return [b["status"] for b in env.webhook.bodies()]


async def test_one_message_per_rule_and_check(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4), ({"route": "/b"}, 0.9))
    await env.add_rule(for_seconds=0, message="Latency on {{route}} is {{value}}")
    await env.tick(T0)
    [body] = env.webhook.bodies()
    assert body["status"] == "firing" and body["summary"] == "2 firing (above 0.3)."
    assert [a["labels"]["route"] for a in body["alerts"]] == ["/a", "/b"]
    assert [a["message"] for a in body["alerts"]] == [
        "Latency on /a is 0.4",
        "Latency on /b is 0.9",
    ]
    assert all(a["starts_at"] == T0.isoformat() for a in body["alerts"])


async def test_one_resolving_while_another_fires_keeps_the_incident_open(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4), ({"route": "/b"}, 0.9))
    await env.add_rule(for_seconds=0)
    await env.tick(T0)
    env.prom.results[SENT] = vector(({"route": "/b"}, 0.9))
    await env.tick(T0 + MIN)
    second = env.webhook.bodies()[1]
    # /b still fires: the group stays "firing" and carries /a as ended.
    assert second["status"] == "firing" and second["summary"] == "1 resolved."
    [ended] = second["alerts"]
    assert ended["labels"]["route"] == "/a" and ended["ends_at"] == (T0 + MIN).isoformat()


async def test_repeat_after_four_hours(engine_env):
    env = engine_env
    assert REPEAT_SECONDS == 14400
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0)
    await env.tick(T0)
    await env.tick(T0 + MIN)
    await env.tick(T0 + 4 * HOUR - MIN)
    assert statuses(env) == ["firing"]
    await env.tick(T0 + 4 * HOUR)
    assert statuses(env) == ["firing", "firing"]  # still firing 4 h later: told once more
    await env.tick(T0 + 4 * HOUR + MIN)
    assert statuses(env) == ["firing", "firing"]
    [instance] = await env.instances(rule)
    assert instance.last_notified_at == T0 + 4 * HOUR and instance.fired_at == T0


async def test_silence_mutes_then_end_releases_the_notification(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0)
    await env.services.silences.create(
        (Matcher("alertname", "=", NAME),), T0 - MIN, T0 + 10 * MIN, "Deploy", "local"
    )
    await env.tick(T0)
    await env.tick(T0 + 5 * MIN)
    assert env.webhook.requests == []
    target = await env.target(rule)
    assert target.state == "firing"  # a silence never changes what a check finds
    [instance] = await env.instances(rule)
    assert instance.silenced and instance.last_notified_at is None

    await env.tick(T0 + 11 * MIN)  # the silence ended: told at the next check
    assert statuses(env) == ["firing"]
    [instance] = await env.instances(rule)
    assert not instance.silenced and instance.last_notified_at == T0 + 11 * MIN


async def test_a_silenced_resolve_is_not_sent(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    await env.add_rule(for_seconds=0)
    await env.tick(T0)
    await env.services.silences.create(
        (Matcher("route", "=~", "/a|/b"),), T0, T0 + HOUR, "Known", "local"
    )
    del env.prom.results[SENT]
    await env.tick(T0 + MIN)
    assert statuses(env) == ["firing"]


async def test_a_slow_contact_point_does_not_delay_checks(engine_env):
    env = engine_env
    env.webhook.mode = "hang"  # the receiver never answers until released
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0)
    await env.engine.tick(T0)
    await env.engine.tick(T0 + MIN)
    # Both checks returned while the receiver still holds the first delivery: nothing answered
    # and nothing recorded (a check that waited would have seen it time out and be recorded).
    await until(lambda: len(env.webhook.requests) == 1)
    assert await env.services.contact_points.deliveries() == []
    assert (await env.target(rule)).last_eval_at == T0 + MIN
    assert len(env.webhook.requests) == 1  # in flight: the next check doesn't send it again
    env.webhook.release.set()
    assert await env.notifier.drain(10)
    assert statuses(env) == ["firing"]
    [instance] = await env.instances(rule)
    assert instance.last_notified_at == T0


async def test_a_failed_delivery_is_recorded_and_sent_again(engine_env):
    env = engine_env
    env.webhook.mode = "error500"
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, target = await env.add_rule(for_seconds=0)
    await env.tick(T0)
    assert len(env.webhook.requests) == 3  # three attempts (no waits in tests)
    [delivery] = await env.services.contact_points.deliveries()
    assert (delivery.ok, delivery.kind, delivery.target_id) == (False, "firing", target.id)
    assert delivery.message == "Ops hook answered HTTP 500: internal error"
    [instance] = await env.instances(rule)
    assert instance.last_notified_at is None  # never reported as told

    env.webhook.mode = "ok"
    await env.tick(T0 + MIN)
    assert len(env.webhook.requests) == 4 and statuses(env)[-1] == "firing"
    [instance] = await env.instances(rule)
    assert instance.last_notified_at == T0 + MIN
    cp = await env.services.contact_points.get(env.cp_id)
    assert cp.last_delivery_ok is True and cp.last_delivery_message is None


async def test_one_contact_point_reached_is_enough(engine_env):
    env = engine_env
    # The fake Prometheus answers 404 to a webhook: that contact point always fails.
    broken = await env.add_contact_point(
        {"name": "Broken", "type": "webhook", "secrets": {"url": f"{env.prom.url}/hook"}}
    )
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0, contact_points=(broken, env.cp_id))
    await env.tick(T0)
    deliveries = await env.services.contact_points.deliveries()
    assert sorted(d.ok for d in deliveries) == [False, True]
    [instance] = await env.instances(rule)
    assert instance.last_notified_at == T0


async def test_nothing_to_tell_without_contact_points(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0, contact_points=())
    await env.tick(T0)
    assert env.webhook.requests == []
    assert (await env.target(rule)).state == "firing"
    assert await env.services.contact_points.deliveries() == []


async def test_a_deleted_contact_point_is_skipped(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    await env.add_rule(for_seconds=0, contact_points=("gone", env.cp_id))
    await env.tick(T0)
    assert statuses(env) == ["firing"]
    [delivery] = await env.services.contact_points.deliveries()
    assert delivery.contact_point_id == env.cp_id


async def test_incident_keys_pair_up(engine_env):
    env = engine_env
    pager = await env.add_contact_point(
        {
            "name": "Pager",
            "type": "pagerduty",
            "settings": {"events_url": f"{env.webhook.url}/v2/enqueue"},
            "secrets": {"routing_key": ROUTING_KEY},
        }
    )
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    _, target = await env.add_rule(for_seconds=0, contact_points=(pager,))
    await env.tick(T0)
    del env.prom.results[SENT]
    await env.tick(T0 + MIN)
    env.prom.mode = "error500"
    for minute in range(2, 5):
        await env.tick(T0 + minute * MIN)
    env.prom.mode = "ok"
    await env.tick(T0 + 5 * MIN)
    events = [(b["event_action"], b["dedup_key"]) for b in env.webhook.bodies()]
    firing, cant_check = dedup_key(target.id, "evaluation"), dedup_key(target.id, "cant_check")
    assert firing != cant_check
    assert events == [
        ("trigger", firing),
        ("resolve", firing),
        ("trigger", cant_check),
        ("resolve", cant_check),
    ]


async def test_silence_ends_while_it_still_fires(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4), ({"route": "/b"}, 0.9))
    rule, _ = await env.add_rule(for_seconds=0)
    await env.tick(T0)  # both told
    await env.services.silences.create(
        (Matcher("route", "=", "/a"),), T0 + MIN, T0 + 10 * MIN, "Known", "local"
    )
    await env.tick(T0 + MIN)
    a, b = sorted(await env.instances(rule), key=lambda i: i.labels["route"])
    assert a.silenced and a.last_notified_at is None  # to be told again when the silence ends
    assert not b.silenced and b.last_notified_at == T0
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))  # /b resolves under the silence
    await env.tick(T0 + 2 * MIN)
    assert statuses(env) == ["firing", "resolved"]
    await env.tick(T0 + 11 * MIN)  # the silence ended while /a still fires: told at once
    assert statuses(env) == ["firing", "resolved", "firing"]
    [alert] = env.webhook.bodies()[-1]["alerts"]
    assert alert["labels"]["route"] == "/a"


async def test_alert_email_leaves_out_the_rule_id(engine_env):
    env = engine_env
    env.prom.results[SENT] = vector(({"route": "/a"}, 0.4))
    rule, _ = await env.add_rule(for_seconds=0)
    await env.tick(T0)
    [instance] = await env.instances(rule)
    assert instance.labels["omnikrux_rule"] == rule.id
    notice = Notice(
        kind="firing",
        rule_name=rule.name,
        project_name="Shop",
        severity="warning",
        summary="1 firing (above 0.3).",
        instances=(Notifier._instance(rule, instance, None),),
        link_hint=None,
        dedup_key="k",
    )
    mail = ContactPoint(
        id="cp-mail",
        name="Mail",
        type="email",
        settings={"from_address": "alerts@example.test", "to": ["ops@example.test"]},
        secrets={},
        last_delivery_at=None,
        last_delivery_ok=None,
        last_delivery_message=None,
        created_at=T0,
        updated_at=T0,
    )
    text = email_message(mail, notice).get_content()
    assert "omnikrux_rule" not in text and rule.id not in text
    assert "route=/a" in text and "alertname=" in text
    # The webhook's JSON keeps every label: a receiver may route on the rule's id.
    [body] = env.webhook.bodies()
    assert body["alerts"][0]["labels"]["omnikrux_rule"] == rule.id
