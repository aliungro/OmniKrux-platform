"""The five senders, the retry rule and the scrubbing every receiver's answer goes through.

One `aiohttp` session for every HTTP contact point (no cookies, no proxy settings from the
environment, redirects never followed, TLS verified with the default trust store) and `smtplib`
in a thread for email. Every failure is mapped by its type to copy that names the contact point
and never carries an address, a path, a token or a password; a receiver's own words reach that
copy only after `scrub`. Nothing here logs a secret: logs carry the contact point's id, its type
and the copy."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import smtplib
import socket
import ssl
import time
import unicodedata
import uuid
from collections.abc import Awaitable, Callable, Iterable, Mapping
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from typing import Protocol
from urllib.parse import quote, quote_plus, unquote, urlsplit

import aiohttp
from aiohttp.http_exceptions import HttpProcessingError

from omnikrux.monitoring.alerts.contact_points.types import (
    REQUIRED_SECRET,
    SECRET_UNREADABLE,
    ContactPoint,
    ContactPointType,
    DeliveryFailed,
    Notice,
    NoticeInstance,
)
from omnikrux.monitoring.sources.transport import _ssl_cause, _tls_reason, scrub_text

log = logging.getLogger(__name__)

# Seconds to wait before each attempt of `deliver`: three attempts in all.
RETRY_DELAYS = (0, 5, 30)
# How long one attempt may take.
SEND_SECONDS = 10.0
# How much of a receiver's error answer is read, and how much of it is shown (after `scrub`).
READ_BYTES = 65536
DETAIL_CHARS = 200
MAX_LINES = 10
MASK = "•••"
# A URL part this long is treated as secret on its own (a webhook token in its path or query).
URL_PART_MIN = 8

# -- copy --------------------------------------------------------------------------------------

REFUSED = "Couldn't send to {name}: the connection was refused. Check the address."
NO_HOST = "Couldn't send to {name}: its host name doesn't resolve. Check the address."
TIMEOUT = "{name} didn't answer within {seconds} seconds."
HTTP_STATUS = "{name} answered HTTP {status}."
HTTP_STATUS_DETAIL = "{name} answered HTTP {status}: {detail}"
REDIRECT = "{name} answered with a redirect. Use the address it redirects to."
TLS = "Couldn't open a secure connection to {name}: {reason}."
SMTP_AUTH = "The mail server rejected the user name or password."
SMTP_REFUSED = "The mail server refused the message: {code} {text}."
SMTP_UNREACHABLE = "The mail server at {host} can't be reached. Check the host and port."
SMTP_REFUSED_ALL = (
    "The mail server refused every address to send to (SMTP {code}). Check the To addresses."
)
SMTP_REFUSED_SOME = (
    "The mail server refused {count} of {total} addresses (SMTP {code}); the others got the "
    "message. Check the To addresses."
)
SENT = "Sent. Check that the test message arrived."
# Not in the plan's copy list; needed for failures none of the above describes.
DROPPED = "Couldn't send to {name}: the connection broke before it answered. Check the address."
NO_STARTTLS = (
    "The mail server at {host} doesn't offer STARTTLS. Choose tls, or check the host and port."
)
NO_LOGIN = "The mail server at {host} doesn't accept a login. Remove the user name."

TEST_TITLE = "OmniKrux test message"
TEST_BODY = (
    'This is a test from OmniKrux for the contact point "{name}". '
    "If you can read it, alerts will reach you here."
)
TITLE_PREFIX = {
    "firing": "[Firing]",
    "resolved": "[Resolved]",
    "cant_check": "[Can't check]",
    "checking_again": "[Checking again]",
}
SENT_BY = "Sent by OmniKrux."
MORE = "And {count} more."
PRODUCT = "OmniKrux"
SOURCE = "OmniKrux"


# -- scrubbing ---------------------------------------------------------------------------------


def _url_parts(value: str) -> set[str]:
    """The path and query parts of an address that are long enough to be a secret alone."""
    try:
        parts = urlsplit(value)
    except ValueError:
        return set()
    if parts.scheme.lower() not in ("http", "https"):
        return set()
    pieces = {parts.path, parts.query, parts.fragment}
    pieces.update(parts.path.split("/"))
    for pair in parts.query.split("&"):
        pieces.add(pair)
        pieces.update(pair.split("=", 1))
    return {piece for piece in pieces if len(piece) >= URL_PART_MIN}


def scrub(text: str, secrets: Iterable[str]) -> str:
    """`text` with every secret value (and, for addresses, their path and query parts of at
    least 8 characters, also as they look percent-encoded, decoded or JSON-escaped) replaced
    with `•••`. Invisible format characters (zero-width spaces and joiners, Unicode `Cf`) are
    taken out first: one inside a secret must not hide it from the match."""
    text = _visible(text)
    for value in sorted(_scrub_values(_visible(s) for s in secrets), key=len, reverse=True):
        text = text.replace(value, MASK)
    return text


def _visible(text: str) -> str:
    return "".join(c for c in text if unicodedata.category(c) != "Cf")


def _scrub_values(secrets: Iterable[str]) -> set[str]:
    """Every text `scrub` replaces for these secrets."""
    values: set[str] = set()
    for secret in secrets:
        if not secret:
            continue
        values.add(secret)
        long = {secret, *_url_parts(secret)}
        for value in long:
            for variant in (
                value,
                quote(value, safe=""),
                quote(value, safe="/"),
                quote_plus(value),
                unquote(value),
                value.replace("/", "\\/"),
            ):
                if len(variant) >= URL_PART_MIN or variant == secret:
                    values.add(variant)
    return values


def _one_line(text: str) -> str:
    return " ".join("".join(c if c.isprintable() else " " for c in text).split())


def _detail(text: str, secrets: Iterable[str], *, cut: bool = False) -> str:
    """A receiver's answer as shown: control characters dropped (an echo can't split a secret
    with them), scrubbed (secret values, then anything that looks like an Authorization header),
    one line, then cut to 200 characters. `cut`: the answer was longer than what was read, so
    its tail, which could hold the start of a secret, is dropped before scrubbing."""
    secrets = list(secrets)
    text = "".join(c for c in text if c in "\t\n\r" or unicodedata.category(c) != "Cc")
    if cut:
        longest = max((len(v) for v in _scrub_values(secrets)), default=0)
        text = text[: max(len(text) - longest, 0)]
    return _one_line(scrub_text(scrub(text, secrets)))[:DETAIL_CHARS]


def _looks_like_html(text: str, content_type: str) -> bool:
    """A web page, not an answer meant for a person to read: never shown."""
    head = text.lstrip()[:15].casefold()
    return "html" in content_type.casefold() or head.startswith(("<!doctype", "<html"))


def _seconds() -> str:
    return f"{SEND_SECONDS:g}"


# -- what a message says -----------------------------------------------------------------------


def title_of(notice: Notice) -> str:
    if notice.kind == "test":
        return TEST_TITLE
    title = f"{TITLE_PREFIX[notice.kind]} {notice.rule_name}"
    return f"{title} · {notice.project_name}" if notice.project_name else title


def _number(value: float | None) -> float | None:
    """A value JSON can carry (NaN and infinities have no JSON form)."""
    return value if value is not None and math.isfinite(value) else None


# Labels OmniKrux adds for itself (the rule's id): kept in a webhook's JSON, never in the words.
HIDDEN_LABELS = frozenset({"omnikrux_rule"})


def instance_line(instance: NoticeInstance) -> str:
    if instance.message:
        return _one_line(instance.message)
    labels = ", ".join(
        f"{k}={v}" for k, v in sorted(instance.labels.items()) if k not in HIDDEN_LABELS
    )
    value = f"value {instance.value:g}" if instance.value is not None else ""
    return " · ".join(part for part in (labels, value) if part)


def instance_lines(notice: Notice) -> list[str]:
    """Up to 10 instance lines, then how many more there are."""
    lines = [instance_line(i) for i in notice.instances[:MAX_LINES]]
    if len(notice.instances) > MAX_LINES:
        lines.append(MORE.format(count=len(notice.instances) - MAX_LINES))
    return [line for line in lines if line]


def body_lines(notice: Notice) -> list[str]:
    """The summary, then the instance lines."""
    summary = [notice.summary] if notice.summary else []
    return summary + instance_lines(notice)


def _iso(moment: datetime | None) -> str | None:
    return moment.isoformat() if moment is not None else None


def _alerts(notice: Notice) -> list[dict]:
    return [
        {
            "labels": dict(i.labels),
            "value": _number(i.value),
            "starts_at": _iso(i.starts_at),
            "ends_at": _iso(i.ends_at),
            "message": i.message,
        }
        for i in notice.instances
    ]


def _slack_text(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def slack_payload(notice: Notice) -> dict:
    title = title_of(notice)
    head = f"*{_slack_text(title)}*"
    if notice.summary:
        head += "\n" + _slack_text(notice.summary)
    blocks: list[dict] = [{"type": "section", "text": {"type": "mrkdwn", "text": head[:3000]}}]
    lines = instance_lines(notice)
    if lines:
        text = "\n".join(_slack_text(line) for line in lines)[:3000]
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": text}})
    context = f"{PRODUCT} · {notice.project_name}" if notice.project_name else PRODUCT
    if notice.link_hint:
        context += f" · {notice.link_hint}"
    blocks.append(
        {"type": "context", "elements": [{"type": "mrkdwn", "text": _slack_text(context)}]}
    )
    return {"text": title, "blocks": blocks}


def teams_payload(notice: Notice) -> dict:
    body: list[dict] = [
        {
            "type": "TextBlock",
            "text": title_of(notice),
            "weight": "Bolder",
            "size": "Medium",
            "wrap": True,
        }
    ]
    lines = body_lines(notice)
    if notice.link_hint:
        lines.append(notice.link_hint)
    body += [{"type": "TextBlock", "text": line, "wrap": True} for line in lines]
    return {
        "type": "message",
        "attachments": [
            {
                "contentType": "application/vnd.microsoft.card.adaptive",
                "content": {
                    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                    "type": "AdaptiveCard",
                    "version": "1.4",
                    "body": body,
                },
            }
        ],
    }


def pagerduty_actions(notice: Notice) -> list[str]:
    """A test opens and closes one incident; a rule that resolves or can be checked again
    closes the one it opened."""
    if notice.kind == "test":
        return ["trigger", "resolve"]
    if notice.kind in ("resolved", "checking_again"):
        return ["resolve"]
    return ["trigger"]


def pagerduty_event(notice: Notice, routing_key: str, action: str) -> dict:
    severity = "error" if notice.kind == "cant_check" else (notice.severity or "info")
    summary = title_of(notice)
    if notice.summary:
        summary = f"{summary}: {notice.summary}"
    return {
        "routing_key": routing_key,
        "event_action": action,
        "dedup_key": notice.dedup_key,
        "payload": {
            "summary": summary[:1024],
            "source": SOURCE,
            "severity": severity,
            "custom_details": {"project": notice.project_name, "instances": _alerts(notice)},
        },
    }


def webhook_payload(notice: Notice, sent_at: datetime) -> dict:
    return {
        "version": "1",
        "status": notice.kind,
        "rule": notice.rule_name,
        "project": notice.project_name,
        "severity": notice.severity,
        "summary": notice.summary,
        "alerts": _alerts(notice),
        "sent_at": sent_at.isoformat(),
    }


def email_message(cp: ContactPoint, notice: Notice) -> EmailMessage:
    settings = cp.settings
    from_address = str(settings["from_address"])
    to = [str(a) for a in settings["to"]]  # type: ignore[attr-defined]
    message = EmailMessage()
    message["Subject"] = _one_line(title_of(notice))
    message["From"] = from_address
    message["To"] = ", ".join(to)
    message["Date"] = formatdate(usegmt=True)
    message["Message-ID"] = make_msgid(domain=from_address.rpartition("@")[2] or "omnikrux")
    lines = [title_of(notice), ""]
    if notice.summary:
        lines += [notice.summary, ""]
    instances = instance_lines(notice)
    if instances:
        lines += [f"- {line}" for line in instances] + [""]
    if notice.link_hint:
        lines += [notice.link_hint, ""]
    lines.append(SENT_BY)
    message.set_content("\n".join(lines) + "\n")
    return message


def notice_for_test(name: str) -> Notice:
    """What Send a test sends."""
    return Notice(
        kind="test",
        rule_name="",
        project_name=None,
        severity=None,
        summary=TEST_BODY.format(name=name),
        instances=(),
        link_hint=None,
        dedup_key=f"omnikrux-test-{uuid.uuid4().hex}",
    )


# -- HTTP --------------------------------------------------------------------------------------


def _http_failure(exc: BaseException, name: str) -> DeliveryFailed:
    """Map a transport error by its type to the copy; never uses the error's own text (an
    aiohttp error can carry the address)."""
    if isinstance(exc, TimeoutError):  # includes aiohttp's ServerTimeoutError
        return DeliveryFailed(TIMEOUT.format(name=name, seconds=_seconds()))
    if isinstance(exc, aiohttp.ClientConnectorCertificateError):
        return DeliveryFailed(TLS.format(name=name, reason=_tls_reason(exc.certificate_error)))
    if isinstance(exc, aiohttp.ClientSSLError) or _ssl_cause(exc) is not None:
        return DeliveryFailed(TLS.format(name=name, reason=_tls_reason(_ssl_cause(exc))))
    if isinstance(exc, aiohttp.ClientConnectorDNSError) or (
        isinstance(exc, aiohttp.ClientConnectorError) and isinstance(exc.os_error, socket.gaierror)
    ):
        return DeliveryFailed(NO_HOST.format(name=name))
    if isinstance(exc, aiohttp.ClientConnectorError):
        return DeliveryFailed(REFUSED.format(name=name))
    return DeliveryFailed(DROPPED.format(name=name))


class Sender(Protocol):
    type: ContactPointType

    async def send(self, cp: ContactPoint, notice: Notice) -> None:
        """Deliver once; DeliveryFailed (scrubbed copy) when it didn't arrive."""
        ...


class _HttpSender:
    def __init__(self, senders: SenderSet) -> None:
        self._senders = senders


class SlackSender(_HttpSender):
    type: ContactPointType = "slack"

    async def send(self, cp: ContactPoint, notice: Notice) -> None:
        await self._senders.post_json(cp, cp.secrets["webhook_url"], slack_payload(notice))


class TeamsSender(_HttpSender):
    type: ContactPointType = "teams"

    async def send(self, cp: ContactPoint, notice: Notice) -> None:
        await self._senders.post_json(cp, cp.secrets["webhook_url"], teams_payload(notice))


class PagerDutySender(_HttpSender):
    type: ContactPointType = "pagerduty"

    async def send(self, cp: ContactPoint, notice: Notice) -> None:
        url = str(cp.settings.get("events_url") or "")
        for action in pagerduty_actions(notice):
            event = pagerduty_event(notice, cp.secrets["routing_key"], action)
            await self._senders.post_json(cp, url, event)


class WebhookSender(_HttpSender):
    type: ContactPointType = "webhook"

    async def send(self, cp: ContactPoint, notice: Notice) -> None:
        headers = {}
        if token := cp.secrets.get("bearer_token"):
            headers["Authorization"] = f"Bearer {token}"
        payload = webhook_payload(notice, datetime.now(UTC))
        await self._senders.post_json(cp, cp.secrets["url"], payload, headers=headers)


# -- email -------------------------------------------------------------------------------------


class _NoStartTls(Exception):
    pass


class _NoLogin(Exception):
    pass


class _Bounded:
    """An SMTP client whose every step shares one deadline: before each command and each reply
    the socket's timeout is set to the time left, so the thread never outlives the attempt (a
    late send would otherwise go out after the attempt was reported failed, and be repeated by
    the retry)."""

    deadline: float
    sock: socket.socket | None

    def _arm(self) -> None:
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError
        if self.sock is not None:
            self.sock.settimeout(left)

    def send(self, s):  # type: ignore[no-untyped-def]
        self._arm()
        return super().send(s)  # type: ignore[misc]

    def getreply(self):  # type: ignore[no-untyped-def]
        self._arm()
        return super().getreply()  # type: ignore[misc]


class _BoundedSMTP(_Bounded, smtplib.SMTP):
    def __init__(self, host: str, port: int, *, deadline: float) -> None:
        self.deadline = deadline
        # A fixed EHLO name: the machine's own name stays private (and its lookup can be slow).
        super().__init__(host, port, local_hostname="localhost", timeout=SEND_SECONDS)


class _BoundedSMTPSSL(_Bounded, smtplib.SMTP_SSL):
    def __init__(self, host: str, port: int, *, deadline: float, context: ssl.SSLContext) -> None:
        self.deadline = deadline
        super().__init__(
            host, port, local_hostname="localhost", timeout=SEND_SECONDS, context=context
        )


def _smtp_send(
    settings: Mapping[str, object],
    password: str | None,
    message: EmailMessage,
    context: ssl.SSLContext,
) -> dict[str, tuple[int, bytes]]:
    """In a thread, within SEND_SECONDS in all: connect, secure, log in when there is a user
    name, send, quit. Returns the recipients the server refused (when it took the others)."""
    host, port = str(settings["host"]), int(settings["port"])  # type: ignore[call-overload]
    security, username = settings.get("security"), settings.get("username")
    deadline = time.monotonic() + SEND_SECONDS
    client: smtplib.SMTP
    if security == "tls":
        client = _BoundedSMTPSSL(host, port, deadline=deadline, context=context)
    else:
        client = _BoundedSMTP(host, port, deadline=deadline)
    try:
        if security == "starttls":
            client.ehlo()
            if not client.has_extn("starttls"):
                raise _NoStartTls
            client.starttls(context=context)
            client.ehlo()
        if username:
            try:
                client.login(str(username), password or "")
            except smtplib.SMTPNotSupportedError:
                raise _NoLogin from None
        to = [str(a) for a in settings["to"]]  # type: ignore[attr-defined]
        return client.send_message(message, str(settings["from_address"]), to)
    finally:
        try:
            client.quit()
        except (smtplib.SMTPException, OSError):
            client.close()


def _smtp_text(raw: bytes | str, secrets: Iterable[str]) -> str:
    text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    return _detail(text, secrets).rstrip(".")


def _smtp_failure(exc: BaseException, cp: ContactPoint) -> DeliveryFailed:
    """Map an `smtplib` error by its type to the copy; a server's own words only scrubbed."""
    name, host = cp.name, str(cp.settings.get("host") or "")
    # The server's words can repeat the addresses, which may be personal: hidden too.
    to = [str(a) for a in cp.settings.get("to") or []]  # type: ignore[attr-defined]
    secrets = [*cp.secrets.values(), str(cp.settings.get("from_address") or ""), *to]
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        return DeliveryFailed(SMTP_AUTH)
    if isinstance(exc, _NoStartTls):
        return DeliveryFailed(NO_STARTTLS.format(host=host))
    if isinstance(exc, _NoLogin):
        return DeliveryFailed(NO_LOGIN.format(host=host))
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        code, _ = next(iter(exc.recipients.values()), (0, b""))
        return DeliveryFailed(SMTP_REFUSED_ALL.format(code=code))
    if isinstance(exc, smtplib.SMTPServerDisconnected) and isinstance(
        exc.__context__, TimeoutError
    ):
        return DeliveryFailed(TIMEOUT.format(name=name, seconds=_seconds()))
    if isinstance(exc, smtplib.SMTPConnectError | smtplib.SMTPServerDisconnected):
        return DeliveryFailed(SMTP_UNREACHABLE.format(host=host))
    if isinstance(exc, smtplib.SMTPResponseException):
        text = _smtp_text(exc.smtp_error, secrets)
        return DeliveryFailed(SMTP_REFUSED.format(code=exc.smtp_code, text=text))
    if isinstance(exc, ssl.SSLError):  # certificate checks included
        return DeliveryFailed(TLS.format(name=name, reason=_tls_reason(exc)))
    if isinstance(exc, TimeoutError):
        return DeliveryFailed(TIMEOUT.format(name=name, seconds=_seconds()))
    return DeliveryFailed(SMTP_UNREACHABLE.format(host=host))


class EmailSender:
    type: ContactPointType = "email"

    def __init__(self, senders: SenderSet) -> None:
        self._senders = senders

    async def send(self, cp: ContactPoint, notice: Notice) -> None:
        message = email_message(cp, notice)
        context = self._senders.ssl_context()
        password = cp.secrets.get("password")
        # Not abandoned on a timer: the thread keeps its own deadline (`_Bounded`), so no
        # attempt is still running when this one is reported and the next one starts.
        try:
            refused = await asyncio.to_thread(_smtp_send, cp.settings, password, message, context)
        except (smtplib.SMTPException, OSError, TimeoutError, _NoStartTls, _NoLogin) as exc:
            raise _smtp_failure(exc, cp) from None
        if refused:
            code, _ = next(iter(refused.values()))
            total = len(cp.settings.get("to") or [])  # type: ignore[arg-type]
            raise DeliveryFailed(
                SMTP_REFUSED_SOME.format(count=len(refused), total=total, code=code), retry=False
            )


# -- the set -----------------------------------------------------------------------------------


class SenderSet:
    """One sender per type over one shared HTTP session. `ssl_context` is the trust store every
    sender verifies against (the default one unless a test passes its own CA)."""

    def __init__(self, *, ssl_context: ssl.SSLContext | None = None) -> None:
        self._context = ssl_context
        self._session: aiohttp.ClientSession | None = None
        self.senders: dict[str, Sender] = {
            sender.type: sender
            for sender in (
                SlackSender(self),
                EmailSender(self),
                TeamsSender(self),
                PagerDutySender(self),
                WebhookSender(self),
            )
        }

    def ssl_context(self) -> ssl.SSLContext:
        if self._context is None:
            self._context = ssl.create_default_context()
        return self._context

    def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                cookie_jar=aiohttp.DummyCookieJar(), trust_env=False
            )
        return self._session

    async def post_json(
        self,
        cp: ContactPoint,
        url: str,
        payload: dict,
        *,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        """POST `payload` as JSON to an address from the contact point's own settings or
        secrets; any 2xx is delivered. DeliveryFailed otherwise."""
        name = cp.name
        sent = {"Content-Type": "application/json", **(headers or {})}
        secrets = [*cp.secrets.values(), *sent.values()]
        status, raw, cut, kind = 0, b"", False, ""
        try:
            async with (
                asyncio.timeout(SEND_SECONDS),
                self.session().post(
                    url,
                    data=json.dumps(payload).encode(),
                    headers=sent,
                    ssl=self.ssl_context(),
                    allow_redirects=False,
                    timeout=aiohttp.ClientTimeout(total=SEND_SECONDS),
                ) as response,
            ):
                status = response.status
                kind = response.headers.get("Content-Type", "")
                if 200 <= status < 300:
                    return
                if 300 <= status < 400:
                    raise DeliveryFailed(REDIRECT.format(name=name))
                body = bytearray()
                async for chunk in response.content.iter_any():
                    body += chunk
                    if len(body) > READ_BYTES:
                        cut = True
                        break
                raw = bytes(body[:READ_BYTES])
        except DeliveryFailed:
            raise
        except (aiohttp.ClientError, HttpProcessingError, OSError, TimeoutError, ValueError) as exc:
            raise _http_failure(exc, name) from None
        text = raw.decode("utf-8", "replace")
        detail = "" if _looks_like_html(text, kind) else _detail(text, secrets, cut=cut)
        if detail:
            raise DeliveryFailed(HTTP_STATUS_DETAIL.format(name=name, status=status, detail=detail))
        raise DeliveryFailed(HTTP_STATUS.format(name=name, status=status))

    async def send(self, cp: ContactPoint, notice: Notice) -> None:
        """One attempt through the contact point's sender. DeliveryFailed with the copy; an
        error no sender expected still reads as copy, never as its own text."""
        if cp.secrets_unreadable or not _has_required(cp):
            raise DeliveryFailed(SECRET_UNREADABLE.format(name=cp.name), retry=False)
        try:
            await self.senders[cp.type].send(cp, notice)
        except DeliveryFailed:
            raise
        except Exception:  # noqa: BLE001 (said in words; its own text may hold the address)
            raise DeliveryFailed(DROPPED.format(name=cp.name)) from None

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None


def _has_required(cp: ContactPoint) -> bool:
    key = REQUIRED_SECRET.get(cp.type)
    return key is None or bool(cp.secrets.get(key))


async def deliver(
    senders: SenderSet,
    cp: ContactPoint,
    notice: Notice,
    *,
    sleep: Callable[[float], Awaitable[object]] = asyncio.sleep,
) -> None:
    """Send with retries: an attempt after each of RETRY_DELAYS (0, 5 and 30 s), each bounded
    by SEND_SECONDS. DeliveryFailed with the last attempt's copy when none arrived; at once for a
    failure that says not to retry (unreadable secrets: no attempt can work; a message some
    recipients already got: another attempt would send it to them again). Logs only id, type and
    copy."""
    failure: DeliveryFailed | None = None
    for delay in RETRY_DELAYS:
        if delay:
            await sleep(delay)
        try:
            await senders.send(cp, notice)
            return
        except DeliveryFailed as exc:
            failure = exc
            if not exc.retry:
                break
    assert failure is not None
    log.warning("Contact point %s (%s) wasn't reached: %s", cp.id, cp.type, failure.message)
    raise failure


__all__ = [
    "DETAIL_CHARS",
    "RETRY_DELAYS",
    "SEND_SECONDS",
    "SENT",
    "DeliveryFailed",
    "Sender",
    "SenderSet",
    "deliver",
    "notice_for_test",
    "scrub",
]
