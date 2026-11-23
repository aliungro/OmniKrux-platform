"""The senders against the fake webhook receiver and the fake SMTP server: payload shapes, TLS,
retries, and the copy of every failure (never carrying a secret)."""

import email
import email.policy
import logging
import socket
import ssl
from datetime import UTC, datetime

import pytest

from omnikrux.monitoring.alerts.contact_points import senders as senders_module
from omnikrux.monitoring.alerts.contact_points.senders import (
    RETRY_DELAYS,
    SenderSet,
    deliver,
    notice_for_test,
    scrub,
)
from omnikrux.monitoring.alerts.contact_points.types import (
    ContactPoint,
    DeliveryFailed,
    Notice,
    NoticeInstance,
)
from tests.monitoring.fake_receivers import serve_fake_webhook

ROUTING_KEY = "R0utingKeySECRET8abcdefghijklmno"
STARTS = datetime(2026, 11, 23, 9, 30, tzinfo=UTC)


def cp(type: str, *, name: str = "Ops", settings=None, secrets=None, **over) -> ContactPoint:
    moment = datetime.now(UTC)
    values = {
        "id": "cp-1",
        "name": name,
        "type": type,
        "settings": settings or {},
        "secrets": secrets or {},
        "last_delivery_at": None,
        "last_delivery_ok": None,
        "last_delivery_message": None,
        "created_at": moment,
        "updated_at": moment,
    }
    return ContactPoint(**(values | over))


def firing(**over) -> Notice:
    values = {
        "kind": "firing",
        "rule_name": "CPU high",
        "project_name": "Shop",
        "severity": "critical",
        "summary": "CPU above 90% for 5 minutes",
        "instances": (
            NoticeInstance(
                labels={"pod": "api-1"},
                value=97.5,
                starts_at=STARTS,
                ends_at=None,
                message="api-1 at 97.5%",
            ),
        ),
        "link_hint": None,
        "dedup_key": "rule-1:target-1",
    }
    return Notice(**(values | over))


def trusting(tls) -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.load_verify_locations(cadata=tls.ca_pem)
    return context


def closed_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
async def senders():
    made = SenderSet()
    yield made
    await made.close()


async def no_sleep(_seconds: float) -> None:
    return None


# --- payloads ----------------------------------------------------------------------------------


async def test_each_sender_shapes_its_payload(senders, fake_webhook, fake_smtp):
    notice = firing()

    await senders.send(cp("slack", secrets={"webhook_url": f"{fake_webhook.url}/slack"}), notice)
    slack = fake_webhook.requests[-1].json
    assert slack["text"] == "[Firing] CPU high · Shop"
    assert slack["blocks"][0]["text"]["text"].startswith("*[Firing] CPU high · Shop*")
    assert slack["blocks"][1]["text"]["text"] == "api-1 at 97.5%"
    assert slack["blocks"][-1] == {
        "type": "context",
        "elements": [{"type": "mrkdwn", "text": "OmniKrux · Shop"}],
    }

    await senders.send(cp("teams", secrets={"webhook_url": f"{fake_webhook.url}/teams"}), notice)
    teams = fake_webhook.requests[-1].json
    assert teams["type"] == "message"
    [attachment] = teams["attachments"]
    assert attachment["contentType"] == "application/vnd.microsoft.card.adaptive"
    card = attachment["content"]
    assert card["type"] == "AdaptiveCard" and card["version"] == "1.4"
    assert [b["text"] for b in card["body"]] == [
        "[Firing] CPU high · Shop",
        "CPU above 90% for 5 minutes",
        "api-1 at 97.5%",
    ]

    pagerduty = cp(
        "pagerduty",
        settings={"events_url": f"{fake_webhook.url}/v2/enqueue"},
        secrets={"routing_key": ROUTING_KEY},
    )
    await senders.send(pagerduty, notice)
    event = fake_webhook.requests[-1]
    assert event.path == "/v2/enqueue"
    assert event.json["event_action"] == "trigger"
    assert event.json["dedup_key"] == "rule-1:target-1"
    assert event.json["routing_key"] == ROUTING_KEY
    assert event.json["payload"]["source"] == "OmniKrux"
    assert event.json["payload"]["severity"] == "critical"
    assert event.json["payload"]["custom_details"]["project"] == "Shop"
    await senders.send(pagerduty, firing(kind="resolved"))
    assert fake_webhook.requests[-1].json["event_action"] == "resolve"
    await senders.send(pagerduty, firing(kind="cant_check"))
    cant = fake_webhook.requests[-1].json
    assert cant["event_action"] == "trigger" and cant["payload"]["severity"] == "error"
    before = len(fake_webhook.requests)
    await senders.send(pagerduty, notice_for_test("Ops"))
    test_events = [r.json for r in fake_webhook.requests[before:]]
    assert [e["event_action"] for e in test_events] == ["trigger", "resolve"]
    assert test_events[0]["dedup_key"] == test_events[1]["dedup_key"]

    hook = cp(
        "webhook",
        settings={"url_host": fake_webhook.url},
        secrets={"url": f"{fake_webhook.url}/hook", "bearer_token": "tok-1"},
    )
    await senders.send(hook, notice)
    request = fake_webhook.requests[-1]
    assert request.headers["Content-Type"] == "application/json"
    assert request.headers["Authorization"] == "Bearer tok-1"
    body = request.json
    assert body["version"] == "1" and body["status"] == "firing"
    assert body["rule"] == "CPU high" and body["project"] == "Shop"
    assert body["severity"] == "critical" and body["summary"] == "CPU above 90% for 5 minutes"
    assert body["alerts"] == [
        {
            "labels": {"pod": "api-1"},
            "value": 97.5,
            "starts_at": STARTS.isoformat(),
            "ends_at": None,
            "message": "api-1 at 97.5%",
        }
    ]
    assert datetime.fromisoformat(body["sent_at"]).tzinfo is not None
    no_token = cp("webhook", secrets={"url": f"{fake_webhook.url}/hook"})
    await senders.send(no_token, firing(kind="checking_again"))
    assert "Authorization" not in fake_webhook.requests[-1].headers
    assert fake_webhook.requests[-1].json["status"] == "checking_again"

    mail = cp(
        "email",
        settings={
            "host": fake_smtp.host,
            "port": fake_smtp.port,
            "security": "none",
            "username": None,
            "from_address": "omnikrux@example.test",
            "to": ["ops@example.test", "oncall@example.test"],
        },
    )
    await senders.send(mail, notice)
    [received] = fake_smtp.messages
    assert received.sender == "omnikrux@example.test"
    assert received.recipients == ["ops@example.test", "oncall@example.test"]
    parsed = email.message_from_bytes(received.data, policy=email.policy.default)
    assert parsed["Subject"] == "[Firing] CPU high · Shop"
    assert parsed["To"] == "ops@example.test, oncall@example.test"
    text = parsed.get_content()
    assert "api-1 at 97.5%" in text and text.rstrip().endswith("Sent by OmniKrux.")


async def test_titles_and_the_test_message(senders, fake_webhook):
    assert senders_module.title_of(firing(kind="resolved")) == "[Resolved] CPU high · Shop"
    assert senders_module.title_of(firing(kind="cant_check")) == "[Can't check] CPU high · Shop"
    assert (
        senders_module.title_of(firing(kind="checking_again")) == "[Checking again] CPU high · Shop"
    )
    assert senders_module.title_of(firing(project_name=None)) == "[Firing] CPU high"
    test = notice_for_test("Slack #ops")
    assert senders_module.title_of(test) == "OmniKrux test message"
    assert test.summary == (
        'This is a test from OmniKrux for the contact point "Slack #ops". '
        "If you can read it, alerts will reach you here."
    )
    many = firing(
        instances=tuple(
            NoticeInstance({"pod": f"p{i}"}, float(i), None, None, "") for i in range(12)
        )
    )
    lines = senders_module.instance_lines(many)
    assert len(lines) == 11 and lines[0] == "pod=p0 · value 0" and lines[-1] == "And 2 more."


# --- email -------------------------------------------------------------------------------------


def mail_settings(server, security: str, username: str | None = "ops") -> dict:
    return {
        "host": server.host,
        "port": server.port,
        "security": security,
        "username": username,
        "from_address": "omnikrux@example.test",
        "to": ["ops@example.test"],
    }


async def test_email_over_starttls_with_login(fake_smtp_tls, fake_tls):
    fake_smtp_tls.user, fake_smtp_tls.password = "ops", "pw-1"
    fake_smtp_tls.require_auth = True
    mail = cp(
        "email", settings=mail_settings(fake_smtp_tls, "starttls"), secrets={"password": "pw-1"}
    )
    senders = SenderSet(ssl_context=trusting(fake_tls))
    try:
        await senders.send(mail, notice_for_test("Ops"))
    finally:
        await senders.close()
    [received] = fake_smtp_tls.messages
    assert received.recipients == ["ops@example.test"]
    assert b"OmniKrux test message" in received.data


async def test_email_tls_is_verified_by_default(fake_smtp_tls, senders):
    mail = cp("email", settings=mail_settings(fake_smtp_tls, "starttls"), secrets={"password": "p"})
    with pytest.raises(DeliveryFailed) as failed:
        await senders.send(mail, notice_for_test("Ops"))
    assert failed.value.message.startswith("Couldn't open a secure connection to Ops: ")
    assert fake_smtp_tls.messages == []


async def test_email_failures_are_copy(fake_smtp, fake_smtp_tls, fake_tls, senders):
    trusted = SenderSet(ssl_context=trusting(fake_tls))
    try:
        fake_smtp_tls.reject_auth = True
        fake_smtp_tls.echo_password_on_auth_failure = True
        mail = cp(
            "email",
            settings=mail_settings(fake_smtp_tls, "starttls"),
            secrets={"password": "pw-SECRET-5"},
        )
        with pytest.raises(DeliveryFailed) as failed:
            await trusted.send(mail, notice_for_test("Ops"))
        assert failed.value.message == "The mail server rejected the user name or password."

        fake_smtp.reject_rcpt = "no mailbox here (pw-SECRET-5)"
        plain = cp("email", settings=mail_settings(fake_smtp, "none", username=None))
        plain_with_secret = cp(
            "email",
            settings=mail_settings(fake_smtp, "none", username=None),
            secrets={"password": "pw-SECRET-5"},
        )
        with pytest.raises(DeliveryFailed) as failed:
            await senders.send(plain_with_secret, notice_for_test("Ops"))
        assert failed.value.message.startswith("The mail server refused the message: 550 ")
        assert "pw-SECRET-5" not in failed.value.message and "•••" in failed.value.message

        # A plain server asked for STARTTLS.
        fake_smtp.reject_rcpt = None
        with pytest.raises(DeliveryFailed) as failed:
            await senders.send(
                cp("email", settings=mail_settings(fake_smtp, "starttls", username=None)),
                notice_for_test("Ops"),
            )
        assert failed.value.message == (
            "The mail server at 127.0.0.1 doesn't offer STARTTLS. Choose tls, or check the host "
            "and port."
        )

        nowhere = {**mail_settings(fake_smtp, "none", username=None), "port": closed_port()}
        with pytest.raises(DeliveryFailed) as failed:
            await senders.send(cp("email", settings=nowhere), notice_for_test("Ops"))
        assert failed.value.message == (
            "The mail server at 127.0.0.1 can't be reached. Check the host and port."
        )
        await senders.send(plain, notice_for_test("Ops"))
    finally:
        await trusted.close()


# --- HTTP failures -----------------------------------------------------------------------------


async def test_http_tls_is_verified_by_default(fake_tls, senders):
    async with serve_fake_webhook(fake_tls) as server:
        slack = cp("slack", secrets={"webhook_url": f"{server.url}/T0/B0/SECRET"})
        with pytest.raises(DeliveryFailed) as failed:
            await senders.send(slack, notice_for_test("Ops"))
        assert failed.value.message.startswith("Couldn't open a secure connection to Ops: ")
        assert "SECRET" not in failed.value.message
        assert server.requests == []
        trusted = SenderSet(ssl_context=trusting(fake_tls))
        try:
            await trusted.send(slack, notice_for_test("Ops"))
        finally:
            await trusted.close()
        assert len(server.requests) == 1


async def test_http_failures_are_copy(fake_webhook, senders, monkeypatch):
    url = f"{fake_webhook.url}/hook/SECRET-PATH-2?token=SECRET-Q-3"
    hook = cp("webhook", name="Hook", secrets={"url": url, "bearer_token": "tok-SECRET-4"})

    fake_webhook.mode = "echo"
    with pytest.raises(DeliveryFailed) as failed:
        await senders.send(hook, notice_for_test("Hook"))
    message = failed.value.message
    assert message.startswith("Hook answered HTTP 400: bad request")
    for secret in ("SECRET-PATH-2", "SECRET-Q-3", "tok-SECRET-4"):
        assert secret not in message
    assert len(message) <= len("Hook answered HTTP 400: ") + 200

    fake_webhook.mode = "ok"
    fake_webhook.status_codes = [302]
    with pytest.raises(DeliveryFailed) as failed:
        await senders.send(hook, notice_for_test("Hook"))
    assert failed.value.message == (
        "Hook answered with a redirect. Use the address it redirects to."
    )

    refused = cp("webhook", name="Hook", secrets={"url": f"http://127.0.0.1:{closed_port()}/x"})
    with pytest.raises(DeliveryFailed) as failed:
        await senders.send(refused, notice_for_test("Hook"))
    assert failed.value.message == (
        "Couldn't send to Hook: the connection was refused. Check the address."
    )

    monkeypatch.setattr(senders_module, "SEND_SECONDS", 0.5)
    fake_webhook.mode = "hang"
    with pytest.raises(DeliveryFailed) as failed:
        await senders.send(hook, notice_for_test("Hook"))
    assert failed.value.message == "Hook didn't answer within 0.5 seconds."
    fake_webhook.release.set()


async def test_unreadable_or_missing_secrets_never_send(fake_webhook, senders):
    unreadable = cp("slack", secrets={}, secrets_unreadable=True)
    with pytest.raises(DeliveryFailed) as failed:
        await deliver(senders, unreadable, firing(), sleep=no_sleep)
    assert failed.value.message == "The saved secret of Ops can't be read. Enter it again."
    assert fake_webhook.requests == []


# --- retries -----------------------------------------------------------------------------------


async def test_failed_delivery_is_retried_and_recorded(fake_webhook, senders, stores, caplog):
    caplog.set_level(logging.DEBUG, logger="omnikrux")
    assert RETRY_DELAYS == (0, 5, 30)
    url = f"{fake_webhook.url}/hook/SECRET-PATH-9"
    saved = await stores.contact_points.create("Hook", "webhook", {}, {"url": url})
    waited: list[float] = []

    async def sleep(seconds: float) -> None:
        waited.append(seconds)

    fake_webhook.status_codes = [500, 500, 200]
    await deliver(senders, saved, firing(), sleep=sleep)
    assert len(fake_webhook.requests) == 3 and waited == [5, 30]

    fake_webhook.status_codes = [500, 500, 500]
    with pytest.raises(DeliveryFailed) as failed:
        await deliver(senders, saved, firing(), sleep=no_sleep)
    assert failed.value.message.startswith("Hook answered HTTP 500")
    assert len(fake_webhook.requests) == 6
    at = datetime.now(UTC)
    await stores.contact_points.add_delivery(
        saved.id, "target-1", "firing", False, failed.value.message, at
    )
    await stores.contact_points.record_delivery(saved.id, False, failed.value.message, at)
    [row] = await stores.contact_points.deliveries(contact_point_id=saved.id)
    assert (row.ok, row.kind, row.target_id) == (False, "firing", "target-1")
    assert row.message.startswith("Hook answered HTTP 500")
    stored = await stores.contact_points.get(saved.id)
    assert stored.last_delivery_ok is False
    assert stored.last_delivery_message == failed.value.message
    assert f"Contact point {saved.id} (webhook) wasn't reached" in caplog.text
    assert "SECRET-PATH-9" not in caplog.text


# --- scrub -------------------------------------------------------------------------------------


def test_scrub_hides_secrets_and_their_url_parts():
    url = "https://hooks.example.test/services/T000/B000/XXXXSECRETXXXX?token=abcdefgh123"
    text = (
        f"posted to {url}; path /services/T000/B000/XXXXSECRETXXXX; "
        "escaped https:\\/\\/hooks.example.test\\/services\\/T000\\/B000\\/XXXXSECRETXXXX; "
        "encoded %2Fservices%2FT000%2FB000%2FXXXXSECRETXXXX; query token=abcdefgh123; "
        "password hunter2"
    )
    scrubbed = scrub(text, [url, "hunter2"])
    for secret in ("XXXXSECRETXXXX", "abcdefgh123", "hunter2"):
        assert secret not in scrubbed
    assert "hooks.example.test" in scrubbed and "•••" in scrubbed
    assert scrub("nothing here", ["", "zzz"]) == "nothing here"


def test_contact_point_repr_leaves_secrets_out():
    point = cp("webhook", secrets={"url": "http://x.test/SECRET-R", "bearer_token": "tok-R"})
    assert "SECRET-R" not in repr(point) and "tok-R" not in repr(point)
    assert "SECRET" not in repr(DeliveryFailed("Hook answered HTTP 500."))
