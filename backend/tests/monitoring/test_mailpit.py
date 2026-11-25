"""Mail through the real SMTP path to a Mailpit on this machine (skipped when there is none).

Run Mailpit with `docker run -d --name omnikrux-mailpit -p 127.0.0.1:1025:1025 -p
127.0.0.1:8025:8025 axllent/mailpit` (see docs/guide/developer/monitoring.md). The test empties
that Mailpit's inbox first and leaves its own message there."""

import socket

import httpx
import pytest

pytestmark = pytest.mark.mailpit

SMTP = ("127.0.0.1", 1025)
MESSAGES = "http://127.0.0.1:8025/api/v1/messages"
NOT_RUNNING = "Mailpit isn't running on 127.0.0.1:1025 (see docs/guide/developer/monitoring.md)."
BASE = "/api/monitoring/alerts/contact-points"


@pytest.fixture
def mailpit():
    try:
        socket.create_connection(SMTP, timeout=1).close()
        httpx.get(MESSAGES, timeout=2).raise_for_status()
    except (OSError, httpx.HTTPError):
        pytest.skip(NOT_RUNNING)
    httpx.delete(MESSAGES, timeout=5).raise_for_status()
    return MESSAGES


async def test_email_reaches_mailpit(monitoring_app, mailpit):
    http, _ = monitoring_app
    created = await http.post(
        BASE,
        json={
            "name": "Mailpit",
            "type": "email",
            "settings": {
                "host": SMTP[0],
                "port": SMTP[1],
                "security": "none",
                "from_address": "omnikrux@example.test",
                "to": ["ops@example.test"],
            },
        },
    )
    assert created.status_code == 201, created.text
    sent = await http.post(f"{BASE}/{created.json()['id']}/test")
    assert sent.status_code == 200, sent.text
    assert sent.json()["ok"] is True, sent.json()

    async with httpx.AsyncClient(timeout=5) as mail:
        listed = (await mail.get(mailpit)).json()
    assert listed["total"] == 1, listed
    [message] = listed["messages"]
    assert message["Subject"] == "OmniKrux test message"
    assert [a["Address"] for a in message["To"]] == ["ops@example.test"]
