"""Contact points through the API and the store: write-only secrets, Send a test, delete
reviews, the copy of every refusal, and the one export of secrets (M5's interface)."""

import json
import logging
import socket
import ssl
from datetime import UTC, datetime

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select, update

from omnikrux.monitoring.alerts.contact_points.export import (
    ReceiverExport,
    SecretRuleRefused,
    export_receivers,
)
from omnikrux.monitoring.alerts.contact_points.senders import SenderSet, notice_for_test
from omnikrux.monitoring.alerts.contact_points.store import ContactPointStore
from omnikrux.monitoring.alerts.contact_points.types import (
    DeliveryFailed,
    SecretsUnreadable,
    UnknownContactPoint,
)
from omnikrux.monitoring.alerts.store import RuleSpec
from omnikrux.monitoring.alerts.types import Condition
from omnikrux.monitoring.models import AlertRuleRow, ContactPointRow, SourceRecord
from omnikrux.monitoring.projects.types import ReviewChanged
from omnikrux.security.secrets import SecretBox
from tests.monitoring.conftest import new_source

BASE = "/api/monitoring/alerts/contact-points"
ROUTING_KEY = "R0utingKeySECRET8abcdefghijklmno"


def closed_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def add(http, body: dict) -> dict:
    response = await http.post(BASE, json=body)
    assert response.status_code == 201, response.text
    return response.json()


async def monitoring_records(http) -> list[dict]:
    records = (await http.get("/api/audit")).json()["records"]
    return [r for r in reversed(records) if r["app"] == "monitoring"]


def rule(name: str, *contact_point_ids: str) -> RuleSpec:
    return RuleSpec(
        name=name,
        scope_kind="project",
        scope_id="project-1",
        source_type="prometheus",
        source_id=None,
        expr="up",
        condition=Condition(of="each", op="below", threshold=1, for_seconds=0, every_seconds=60),
        contact_point_ids=contact_point_ids,
    )


# --- write-only secrets ------------------------------------------------------------------------


async def test_contact_point_secrets_are_write_only(monitoring_app, fake_webhook, caplog):
    caplog.set_level(logging.DEBUG)
    http, app = monitoring_app
    url = "https://hooks.slack.com/services/T000/B000/XXXX-SECRET-1"
    out = (
        await http.post(
            BASE,
            json={
                "name": "Slack #ops",
                "type": "slack",
                "settings": {},
                "secrets": {"webhook_url": url},
            },
        )
    ).json()
    assert out["secrets_set"] == ["webhook_url"] and out["summary"] == "Slack webhook"
    assert out["settings"] == {} and out["used_by"] == [] and out["last_delivery"] is None
    listed = (await http.get(BASE)).text
    audit = (await http.get("/api/audit")).text
    for text in (str(out), listed, audit, caplog.text):
        assert "XXXX-SECRET-1" not in text

    [record] = [r for r in await monitoring_records(http) if r["action"] == "contact_point_add"]
    assert record["details"] == {"type": "slack", "settings": [], "secrets": ["webhook_url"]}
    assert record["outcome"] == "succeeded"

    # Encrypted at rest; the record's repr leaves the secrets out.
    async with app.state.sessionmaker() as session:
        row = await session.scalar(select(ContactPointRow))
    assert b"XXXX-SECRET-1" not in row.secret_encrypted
    assert "XXXX-SECRET-1" not in row.settings
    stored = await app.state.monitoring.contact_points.get(out["id"])
    assert stored.secrets["webhook_url"] == url
    assert "XXXX-SECRET-1" not in repr(stored)


async def test_send_a_test_reaches_the_receiver(monitoring_app, fake_webhook):
    http, _ = monitoring_app
    created = await add(
        http,
        {
            "name": "Teams #ops",
            "type": "teams",
            "secrets": {"webhook_url": f"{fake_webhook.url}/T000/B000/XXXX"},
        },
    )
    tested = await http.post(f"{BASE}/{created['id']}/test")
    assert tested.status_code == 200, tested.text
    assert tested.json() == {"ok": True, "message": "Sent. Check that the test message arrived."}
    [request] = fake_webhook.requests
    assert request.path == "/T000/B000/XXXX"
    card = request.json["attachments"][0]["content"]
    assert card["body"][0]["text"] == "OmniKrux test message"

    [listed] = (await http.get(BASE)).json()
    assert listed["last_delivery"]["ok"] is True and listed["last_delivery"]["message"] is None
    records = [r for r in await monitoring_records(http) if r["action"] == "contact_point_test"]
    assert [(r["name"], r["outcome"]) for r in records] == [("Teams #ops", "succeeded")]


async def test_send_a_test_of_an_unsaved_contact_point(monitoring_app, fake_webhook):
    http, _ = monitoring_app
    body = {
        "name": "Hook",
        "type": "webhook",
        "secrets": {"url": f"{fake_webhook.url}/in", "bearer_token": "tok-UNSAVED"},
    }
    tested = await http.post(f"{BASE}/test", json=body)
    assert tested.json() == {"ok": True, "message": "Sent. Check that the test message arrived."}
    [request] = fake_webhook.requests
    assert request.json["status"] == "test"
    assert request.headers["Authorization"] == "Bearer tok-UNSAVED"
    assert (await http.get(BASE)).json() == []
    records = [r for r in await monitoring_records(http) if r["action"] == "contact_point_test"]
    assert records[0]["details"] == {"type": "webhook", "saved": False}
    assert "tok-UNSAVED" not in (await http.get("/api/audit")).text

    fake_webhook.status_codes = [500]
    failed = await http.post(f"{BASE}/test", json=body)
    assert failed.json() == {"ok": False, "message": "Hook answered HTTP 500: scripted"}
    assert len(fake_webhook.requests) == 2  # one attempt: no retries


async def test_delivery_errors_never_carry_secrets(
    monitoring_app, fake_webhook, fake_smtp_tls, fake_tls, caplog
):
    caplog.set_level(logging.DEBUG)
    http, app = monitoring_app
    services = app.state.monitoring
    # Trust the fake server's CA, so the login is reached (a password only goes encrypted).
    context = ssl.create_default_context()
    context.load_verify_locations(cadata=fake_tls.ca_pem)
    default_senders, services.senders = services.senders, SenderSet(ssl_context=context)
    secrets = ("SECRET-PATH-2", "SECRET-Q-3", "tok-SECRET-4", "pw-SECRET-5", "SECRET-PATH-6")
    try:
        fake_webhook.mode = "echo"
        hook = await add(
            http,
            {
                "name": "Hook",
                "type": "webhook",
                "secrets": {
                    "url": f"{fake_webhook.url}/hook/SECRET-PATH-2?token=SECRET-Q-3",
                    "bearer_token": "tok-SECRET-4",
                },
            },
        )
        assert hook["summary"] == fake_webhook.url
        assert hook["settings"] == {"url_host": fake_webhook.url}

        fake_smtp_tls.reject_auth = True
        fake_smtp_tls.echo_password_on_auth_failure = True
        mail = await add(
            http,
            {
                "name": "Mail",
                "type": "email",
                "settings": {
                    "host": fake_smtp_tls.host,
                    "port": fake_smtp_tls.port,
                    "username": "ops",
                    "from_address": "omnikrux@example.test",
                    "to": ["ops@example.test"],
                },
                "secrets": {"password": "pw-SECRET-5"},
            },
        )
        assert mail["settings"]["security"] == "starttls"
        refused = await add(
            http,
            {
                "name": "Gone",
                "type": "webhook",
                "secrets": {"url": f"http://127.0.0.1:{closed_port()}/x/SECRET-PATH-6"},
            },
        )

        answers = {}
        for created in (hook, mail, refused):
            response = await http.post(f"{BASE}/{created['id']}/test")
            assert response.status_code == 200, response.text
            answers[created["name"]] = response.json()
        assert answers["Hook"]["ok"] is False
        assert answers["Hook"]["message"].startswith("Hook answered HTTP 400: bad request")
        assert answers["Mail"] == {
            "ok": False,
            "message": "The mail server rejected the user name or password.",
        }
        assert answers["Gone"] == {
            "ok": False,
            "message": "Couldn't send to Gone: the connection was refused. Check the address.",
        }

        store = services.contact_points
        stored = [await store.get(c["id"]) for c in (hook, mail, refused)]
        rows = await store.deliveries()
        texts = [
            json.dumps(answers),
            *(cp.last_delivery_message or "" for cp in stored),
            *(row.message or "" for row in rows),
            (await http.get(BASE)).text,
            (await http.get("/api/audit")).text,
            caplog.text,
        ]
        assert len(rows) == 3 and not any(row.ok for row in rows)
        for text in texts:
            for secret in secrets:
                assert secret not in text, (secret, text)
    finally:
        await services.senders.close()
        services.senders = default_senders


# --- changes -----------------------------------------------------------------------------------


async def test_patch_keeps_unsent_secrets(monitoring_app, fake_webhook):
    http, _ = monitoring_app
    created = await add(
        http,
        {
            "name": "Hook",
            "type": "webhook",
            "secrets": {"url": f"{fake_webhook.url}/a/SECRET-A1", "bearer_token": "tok-A2"},
        },
    )
    path = f"{BASE}/{created['id']}"
    renamed = await http.patch(path, json={"name": "Hook 2", "settings": {"url_host": "x"}})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["secrets_set"] == ["bearer_token", "url"]
    assert renamed.json()["settings"] == {"url_host": fake_webhook.url}
    kept = await http.patch(path, json={"secrets": {"url": None, "bearer_token": None}})
    assert kept.json()["secrets_set"] == ["bearer_token", "url"]
    await http.post(f"{path}/test")
    assert fake_webhook.requests[-1].path == "/a/SECRET-A1"
    assert fake_webhook.requests[-1].headers["Authorization"] == "Bearer tok-A2"

    cleared = await http.patch(path, json={"secrets": {"bearer_token": ""}})
    assert cleared.json()["secrets_set"] == ["url"]
    await http.post(f"{path}/test")
    assert "Authorization" not in fake_webhook.requests[-1].headers

    # The required secret can't be cleared; the type can't change.
    no_url = await http.patch(path, json={"secrets": {"url": ""}})
    assert no_url.status_code == 422 and no_url.json()["detail"] == "A webhook needs its address."
    retype = await http.patch(path, json={"type": "slack"})
    assert retype.status_code == 422
    assert retype.json()["detail"] == "A contact point's type can't change. Add a new one instead."
    same_type = await http.patch(path, json={"type": "webhook"})
    assert same_type.status_code == 200

    moved = await http.patch(path, json={"secrets": {"url": "https://hooks.example.test:8443/b"}})
    assert moved.json()["summary"] == "https://hooks.example.test:8443"

    records = [r for r in await monitoring_records(http) if r["action"] == "contact_point_change"]
    assert records[0]["details"] == {"type": "webhook", "settings": ["url_host"], "secrets": []}
    assert {
        "type": "webhook",
        "settings": [],
        "secrets": [],
        "secrets_cleared": ["bearer_token"],
    } in [r["details"] for r in records]
    audit = (await http.get("/api/audit")).text
    assert "SECRET-A1" not in audit and "tok-A2" not in audit


async def test_email_settings_merge_and_summary(monitoring_app):
    http, _ = monitoring_app
    created = await add(
        http,
        {
            "name": "Mail",
            "type": "email",
            "settings": {
                "host": "mail.example.test",
                "from_address": "omnikrux@example.test",
                "to": ["ops@example.test", "oncall@example.test"],
            },
        },
    )
    assert created["settings"] == {
        "host": "mail.example.test",
        "port": 587,
        "security": "starttls",
        "username": None,
        "from_address": "omnikrux@example.test",
        "to": ["ops@example.test", "oncall@example.test"],
    }
    assert created["summary"] == "ops@example.test, oncall@example.test"
    assert created["secrets_set"] == []
    changed = await http.patch(
        f"{BASE}/{created['id']}", json={"settings": {"port": 465, "security": "tls"}}
    )
    assert changed.json()["settings"]["port"] == 465
    assert changed.json()["settings"]["to"] == ["ops@example.test", "oncall@example.test"]
    with_login = await http.patch(
        f"{BASE}/{created['id']}",
        json={"settings": {"username": "ops"}, "secrets": {"password": "pw-M1"}},
    )
    assert with_login.json()["secrets_set"] == ["password"]


async def test_names_are_unique(monitoring_app, fake_webhook):
    http, _ = monitoring_app
    body = {"name": "Ops", "type": "teams", "secrets": {"webhook_url": f"{fake_webhook.url}/s"}}
    await add(http, body)
    taken = await http.post(BASE, json=body)
    assert taken.status_code == 409
    assert (
        taken.json()["detail"] == 'A contact point named "Ops" already exists. Pick another name.'
    )
    other = await add(http, {**body, "name": "Other"})
    renamed = await http.patch(f"{BASE}/{other['id']}", json={"name": "Ops"})
    assert renamed.status_code == 409
    missing = await http.patch(f"{BASE}/nope", json={"name": "X"})
    assert missing.status_code == 404


@pytest.mark.parametrize(
    ("body", "detail"),
    [
        ({"name": "", "type": "slack"}, "Use 1 to 80 characters, without line breaks."),
        ({"name": "a\nb", "type": "slack"}, "Use 1 to 80 characters, without line breaks."),
        ({"name": "x" * 81, "type": "slack"}, "Use 1 to 80 characters, without line breaks."),
        ({"name": "S", "type": "slack"}, "Slack needs its webhook address."),
        ({"name": "T", "type": "teams"}, "Teams needs its webhook address."),
        (
            {"name": "P", "type": "pagerduty"},
            "PagerDuty needs the integration's routing key (32 letters and digits).",
        ),
        (
            {"name": "P", "type": "pagerduty", "secrets": {"routing_key": "short-SECRET-K"}},
            "PagerDuty needs the integration's routing key (32 letters and digits).",
        ),
        ({"name": "W", "type": "webhook"}, "A webhook needs its address."),
        (
            {"name": "W", "type": "webhook", "secrets": {"url": "ftp://x.test/SECRET-U"}},
            "Use an http or https address.",
        ),
        (
            {"name": "S", "type": "slack", "secrets": {"webhook_url": "not a url SECRET-U"}},
            "Use a Slack webhook address that starts with https://hooks.slack.com/.",
        ),
        (
            {"name": "W", "type": "webhook", "secrets": {"url": "http://u:SECRET-U@x.test/"}},
            "Use an address without a user name or password in it.",
        ),
        (
            {"name": "S", "type": "slack", "settings": {"x": 1}, "secrets": {}},
            "Remove the unrecognized field and try again.",
        ),
        (
            {"name": "S", "type": "slack", "secrets": {"password": "SECRET-U"}},
            "Remove the unrecognized field and try again.",
        ),
        (
            {"name": "P", "type": "pagerduty", "settings": {"events_url": "x"}},
            "Use an http or https address.",
        ),
    ],
)
async def test_contact_point_validation_copy(monitoring_app, body, detail):
    http, _ = monitoring_app
    response = await http.post(BASE, json=body)
    assert response.status_code == 422
    assert response.json()["detail"] == detail
    assert "SECRET" not in response.text
    assert (await http.get(BASE)).json() == []


def email_body(**settings) -> dict:
    base = {
        "host": "mail.example.test",
        "from_address": "omnikrux@example.test",
        "to": ["ops@example.test"],
    }
    return {"name": "Mail", "type": "email", "settings": base | settings}


@pytest.mark.parametrize(
    ("body", "detail"),
    [
        (email_body(to=[]), "Add at least one address to send to."),
        (email_body(to=None), "Add at least one address to send to."),
        (email_body(to=["not-an-address"]), "Use addresses like ops@example.test."),
        (email_body(to=["Ops <ops@example.test>"]), "Use addresses like ops@example.test."),
        (email_body(from_address="nobody"), "Use addresses like ops@example.test."),
        (email_body(port=0), "Use a port from 1 to 65535."),
        (email_body(port=65536), "Use a port from 1 to 65535."),
        (email_body(port="25"), "Use a port from 1 to 65535."),
        (
            email_body(to=[f"u{i}@example.test" for i in range(21)]),
            "Send to at most 20 addresses.",
        ),
        (email_body(host=""), "Enter the mail server's host name, without spaces."),
        (email_body(security="ssl"), "Use one of: starttls, tls, none."),
        (
            {**email_body(), "secrets": {"password": "pw-SECRET"}},
            "Add the user name that goes with the password.",
        ),
        (
            {**email_body(username="ops", security="none"), "secrets": {"password": "pw-SECRET"}},
            "A password is sent only over an encrypted connection. Choose starttls or tls.",
        ),
    ],
)
async def test_email_validation_copy(monitoring_app, body, detail):
    http, _ = monitoring_app
    response = await http.post(BASE, json=body)
    assert response.status_code == 422
    assert response.json()["detail"] == detail
    assert "SECRET" not in response.text


# --- delete ------------------------------------------------------------------------------------


async def test_delete_review_lists_rules_and_stale_token(monitoring_app, fake_webhook):
    http, app = monitoring_app
    alerts = app.state.monitoring.alerts
    body = {"type": "teams", "secrets": {"webhook_url": f"{fake_webhook.url}/s"}}
    ops = await add(http, {"name": "Ops", **body})
    other = await add(http, {"name": "Other", **body})
    cpu = await alerts.create_rule(rule("CPU high", ops["id"], other["id"]))
    await alerts.create_rule(rule("Unrelated", other["id"]))

    [listed_ops, _] = (await http.get(BASE)).json()
    assert listed_ops["used_by"] == [{"id": cpu.id, "name": "CPU high"}]

    review = (await http.get(f"{BASE}/{ops['id']}/delete-review")).json()
    assert review["id"] == ops["id"] and review["name"] == "Ops"
    assert review["used_by"] == [{"id": cpu.id, "name": "CPU high"}]

    disk = await alerts.create_rule(rule("Disk full", ops["id"]))
    stale = await http.delete(f"{BASE}/{ops['id']}", params={"token": review["token"]})
    assert stale.status_code == 409
    assert stale.json()["detail"] == "Something changed since the review. Review it again."
    assert len((await http.get(BASE)).json()) == 2

    again = (await http.get(f"{BASE}/{ops['id']}/delete-review")).json()
    assert [r["name"] for r in again["used_by"]] == ["CPU high", "Disk full"]
    removed = await http.delete(f"{BASE}/{ops['id']}", params={"token": again["token"]})
    assert removed.status_code == 200
    assert removed.json() == {"alert_changes": []}
    assert [cp["name"] for cp in (await http.get(BASE)).json()] == ["Other"]

    after_cpu = await alerts.get_rule(cpu.id)
    assert after_cpu.contact_point_ids == (other["id"],)
    assert after_cpu.version == cpu.version + 1
    assert (await alerts.get_rule(disk.id)).contact_point_ids == ()

    records = [r for r in await monitoring_records(http) if r["action"] == "contact_point_remove"]
    assert [(r["outcome"], r["details"]) for r in records] == [
        ("failed", {"removed_from": ["CPU high", "Disk full"]}),
        ("succeeded", {"removed_from": ["CPU high", "Disk full"]}),
    ]
    assert (await http.get(f"{BASE}/{ops['id']}/delete-review")).status_code == 404
    assert (await http.delete(f"{BASE}/{ops['id']}", params={"token": "x"})).status_code == 404


async def test_contact_point_routes_refuse_cross_origin(monitoring_app):
    http, _ = monitoring_app
    evil = {"Origin": "http://evil.example"}
    for method, path in (
        ("GET", BASE),
        ("GET", f"{BASE}/x/delete-review"),
        ("POST", BASE),
        ("POST", f"{BASE}/test"),
        ("POST", f"{BASE}/x/test"),
        ("PATCH", f"{BASE}/x"),
        ("DELETE", f"{BASE}/x?token=t"),
    ):
        response = await http.request(method, path, headers=evil, json={})
        assert response.status_code == 403, (method, path)
        assert response.json() == {"detail": "Cross-origin request refused"}


# --- the store ---------------------------------------------------------------------------------


async def test_unreadable_secrets_are_kept_and_refused(stores, tmp_path):
    store = stores.contact_points
    saved = await store.create("Ops", "teams", {}, {"webhook_url": "http://x.test/SECRET-K"})
    other_key = ContactPointStore(stores.sessionmaker, SecretBox(Fernet.generate_key()))

    unreadable = await other_key.get(saved.id)
    assert unreadable.secrets_unreadable and unreadable.secrets_set == []
    with pytest.raises(DeliveryFailed) as failed:
        await SenderSet().send(unreadable, notice_for_test("Ops"))
    assert failed.value.message == "The saved secret of Ops can't be read. Enter it again."

    # A change that gives no secret keeps the stored (unreadable) one as it is.
    await other_key.update(saved.id, name="Ops 2")
    assert (await store.get(saved.id)).secrets["webhook_url"] == "http://x.test/SECRET-K"
    # Giving the secret again replaces it.
    await other_key.update(saved.id, secrets={"webhook_url": "http://y.test/new"})
    assert (await other_key.get(saved.id)).secrets_set == ["webhook_url"]
    assert (await store.get(saved.id)).secrets_unreadable


async def test_store_misses_are_unknown(stores):
    store = stores.contact_points
    with pytest.raises(UnknownContactPoint):
        await store.get("nope")
    with pytest.raises(UnknownContactPoint):
        await store.update("nope", name="x")
    with pytest.raises(UnknownContactPoint):
        await store.delete("nope")
    with pytest.raises(UnknownContactPoint):
        await store.record_delivery("nope", True, None, datetime.now(UTC))
    saved = await store.create("Ops", "teams", {}, {"webhook_url": "http://x.test/s"})
    with pytest.raises(ReviewChanged):
        await store.delete(saved.id, "stale")
    assert await store.delete(saved.id) == []
    async with stores.sessionmaker() as session:
        assert await session.scalar(select(ContactPointRow)) is None
        assert await session.scalar(select(AlertRuleRow)) is None


# --- export (M5's interface) -------------------------------------------------------------------


async def test_export_refuses_tools_omnikrux_did_not_install(stores):
    services = type("Services", (), {})()
    services.sources, services.contact_points = stores.sources, stores.contact_points
    manager = await stores.sources.create(new_source(type="alertmanager", name="Team AM"))
    saved = await stores.contact_points.create(
        "Pager", "pagerduty", {}, {"routing_key": ROUTING_KEY}
    )

    with pytest.raises(SecretRuleRefused) as refused:
        await export_receivers(
            services, alertmanager_source_id=manager.id, contact_point_ids=[saved.id]
        )
    assert str(refused.value) == (
        "Contact-point secrets go only into tools OmniKrux installed. "
        "Team AM wasn't installed by OmniKrux."
    )

    async with stores.sessionmaker.begin() as session:
        await session.execute(update(SourceRecord).values(installed_by_omnikrux=True))
    [exported] = await export_receivers(
        services, alertmanager_source_id=manager.id, contact_point_ids=[saved.id]
    )
    assert exported == ReceiverExport(
        contact_point_id=saved.id,
        name="Pager",
        type="pagerduty",
        settings={"events_url": "https://events.pagerduty.com/v2/enqueue"},
        secrets={"routing_key": ROUTING_KEY},
    )
    assert ROUTING_KEY not in repr(exported)
    with pytest.raises(UnknownContactPoint):
        await export_receivers(
            services, alertmanager_source_id=manager.id, contact_point_ids=["nope"]
        )

    # Installed by OmniKrux but not an Alertmanager: refused too.
    prometheus = await stores.sources.create(new_source(name="Prom"))
    async with stores.sessionmaker.begin() as session:
        await session.execute(update(SourceRecord).values(installed_by_omnikrux=True))
    with pytest.raises(SecretRuleRefused):
        await export_receivers(
            services, alertmanager_source_id=prometheus.id, contact_point_ids=[saved.id]
        )

    unreadable = type("Services", (), {})()
    unreadable.sources = stores.sources
    unreadable.contact_points = ContactPointStore(
        stores.sessionmaker, SecretBox(Fernet.generate_key())
    )
    with pytest.raises(SecretsUnreadable):
        await export_receivers(
            unreadable, alertmanager_source_id=manager.id, contact_point_ids=[saved.id]
        )


# --- fix round 1: a secret never follows a contact point to a new address ----------------------


def secret_again(name: str, field: str) -> dict:
    return {
        "detail": [
            {
                "type": "secret_needed",
                "loc": ["body", "secrets", field],
                "msg": f"{name} sends to a new address now. Enter its secret again.",
            }
        ]
    }


async def test_pagerduty_address_change_needs_the_routing_key(monitoring_app, fake_webhook):
    http, app = monitoring_app
    created = await add(
        http,
        {
            "name": "Pager",
            "type": "pagerduty",
            "settings": {"events_url": f"{fake_webhook.url}/v2/enqueue"},
            "secrets": {"routing_key": ROUTING_KEY},
        },
    )
    path = f"{BASE}/{created['id']}"
    moved = {"settings": {"events_url": "https://elsewhere.example.test/v2/enqueue"}}
    refused = await http.patch(path, json=moved)
    assert refused.status_code == 422 and refused.json() == secret_again("Pager", "routing_key")
    stored = await app.state.monitoring.contact_points.get(created["id"])
    assert stored.settings["events_url"] == f"{fake_webhook.url}/v2/enqueue"
    # The same address again, or another setting, keeps the key.
    same = await http.patch(path, json={"settings": {"events_url": stored.settings["events_url"]}})
    assert same.status_code == 200
    renamed = await http.patch(path, json={"name": "Pager 2"})
    assert renamed.status_code == 200
    other_key = "OtherKey0123456789abcdefghijklmn"
    accepted = await http.patch(path, json={**moved, "secrets": {"routing_key": other_key}})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["settings"]["events_url"] == moved["settings"]["events_url"]
    stored = await app.state.monitoring.contact_points.get(created["id"])
    assert stored.secrets["routing_key"] == other_key


async def test_email_server_change_needs_the_password(monitoring_app):
    http, app = monitoring_app
    created = await add(
        http,
        {
            "name": "Mail",
            "type": "email",
            "settings": {
                "host": "mail.example.test",
                "username": "ops",
                "from_address": "omnikrux@example.test",
                "to": ["ops@example.test"],
            },
            "secrets": {"password": "pw-KEEP"},
        },
    )
    path = f"{BASE}/{created['id']}"
    for change in ({"host": "other.example.test"}, {"port": 2525}):
        refused = await http.patch(path, json={"settings": change})
        assert refused.status_code == 422, change
        assert refused.json() == secret_again("Mail", "password")
    # Other settings keep the password; a new server with the password given, or cleared, works.
    to = await http.patch(path, json={"settings": {"to": ["oncall@example.test"]}})
    assert to.status_code == 200 and to.json()["secrets_set"] == ["password"]
    moved = await http.patch(
        path, json={"settings": {"host": "other.example.test"}, "secrets": {"password": "pw-NEW"}}
    )
    assert moved.status_code == 200
    assert (await app.state.monitoring.contact_points.get(created["id"])).secrets == {
        "password": "pw-NEW"
    }
    cleared = await http.patch(
        path,
        json={
            "settings": {"host": "third.example.test", "username": None},
            "secrets": {"password": ""},
        },
    )
    assert cleared.status_code == 200 and cleared.json()["secrets_set"] == []
    # Without a stored password nothing follows: the server can change freely.
    free = await http.patch(path, json={"settings": {"host": "fourth.example.test"}})
    assert free.status_code == 200


async def test_webhook_address_change_needs_the_bearer_token(monitoring_app, fake_webhook):
    http, app = monitoring_app
    created = await add(
        http,
        {
            "name": "Hook",
            "type": "webhook",
            "secrets": {"url": f"{fake_webhook.url}/in", "bearer_token": "tok-KEEP"},
        },
    )
    path = f"{BASE}/{created['id']}"
    moved = {"url": "https://elsewhere.example.test/in"}
    refused = await http.patch(path, json={"secrets": moved})
    assert refused.status_code == 422 and refused.json() == secret_again("Hook", "bearer_token")
    assert "tok-KEEP" not in refused.text
    same = await http.patch(path, json={"secrets": {"url": f"{fake_webhook.url}/in"}})
    assert same.status_code == 200 and same.json()["secrets_set"] == ["bearer_token", "url"]
    path_only = await http.patch(path, json={"secrets": {"url": f"{fake_webhook.url}/other"}})
    assert path_only.status_code == 422
    accepted = await http.patch(path, json={"secrets": {**moved, "bearer_token": "tok-NEW"}})
    assert accepted.status_code == 200
    assert accepted.json()["summary"] == "https://elsewhere.example.test"
    stored = await app.state.monitoring.contact_points.get(created["id"])
    assert stored.secrets == {"url": moved["url"], "bearer_token": "tok-NEW"}
    # Without a token the address is the whole secret: it changes freely, like Slack's and Teams'.
    await http.patch(path, json={"secrets": {"bearer_token": ""}})
    free = await http.patch(path, json={"secrets": {"url": f"{fake_webhook.url}/in"}})
    assert free.status_code == 200


async def test_slack_and_teams_addresses_change_freely(monitoring_app, fake_webhook):
    http, _ = monitoring_app
    for type, first, second in (
        ("slack", "https://hooks.slack.com/services/a", "https://hooks.slack.com/services/b"),
        ("teams", f"{fake_webhook.url}/a", "https://elsewhere.example.test/b"),
    ):
        created = await add(
            http,
            {"name": type, "type": type, "secrets": {"webhook_url": first}},
        )
        changed = await http.patch(
            f"{BASE}/{created['id']}",
            json={"secrets": {"webhook_url": second}},
        )
        assert changed.status_code == 200, type
