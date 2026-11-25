"""Contact points: where notifications go, the rules each type's settings and secrets follow,
and the notice a sender turns into a message.

Settings are plain JSON (shown to the user). Secrets (webhook addresses, a bearer token, an SMTP
password, a PagerDuty routing key) are write-only: they are encrypted at rest, never shown, never
logged and never put into an error message. Every check here answers with plain words that never
repeat what was entered."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, get_args
from urllib.parse import urlsplit

from omnikrux.monitoring.alerts.types import Severity

ContactPointType = Literal["slack", "email", "teams", "pagerduty", "webhook"]
CONTACT_POINT_TYPES: tuple[ContactPointType, ...] = get_args(ContactPointType)
NoticeKind = Literal["firing", "resolved", "cant_check", "checking_again", "test"]
EmailSecurity = Literal["starttls", "tls", "none"]

MAX_NAME = 80
MAX_URL = 2048
MAX_TOKEN = 1024
MAX_PASSWORD = 1024
MAX_RECIPIENTS = 20
MAX_HOST = 253
MAX_USERNAME = 256
DEFAULT_PORT = 587
DEFAULT_SECURITY: EmailSecurity = "starttls"
SECURITIES: tuple[EmailSecurity, ...] = get_args(EmailSecurity)
DEFAULT_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue"

# Settings and secrets each type takes. `url_host` is derived from a webhook's address on save;
# one sent back as it was read is ignored.
SETTING_KEYS: dict[str, tuple[str, ...]] = {
    "slack": (),
    "email": ("host", "port", "security", "username", "from_address", "to"),
    "teams": (),
    "pagerduty": ("events_url",),
    "webhook": ("url_host",),
}
SECRET_KEYS: dict[str, tuple[str, ...]] = {
    "slack": ("webhook_url",),
    "email": ("password",),
    "teams": ("webhook_url",),
    "pagerduty": ("routing_key",),
    "webhook": ("url", "bearer_token"),
}
# The secret a type can't work without (email works without a password).
REQUIRED_SECRET: dict[str, str] = {
    "slack": "webhook_url",
    "teams": "webhook_url",
    "pagerduty": "routing_key",
    "webhook": "url",
}
URL_SECRETS = frozenset({"webhook_url", "url"})
# The secret sent to an address that is a setting or another secret: it is never kept when
# that address changes (Slack and Teams hold their whole address as the secret).
DEPENDENT_SECRET: dict[str, str] = {
    "pagerduty": "routing_key",
    "email": "password",
    "webhook": "bearer_token",
}

# -- copy --------------------------------------------------------------------------------------

NAME_RULE = "Use 1 to 80 characters, without line breaks."
MISSING_SECRET = {
    "slack": "Slack needs its webhook address.",
    "teams": "Teams needs its webhook address.",
    "pagerduty": "PagerDuty needs the integration's routing key (32 letters and digits).",
    "webhook": "A webhook needs its address.",
}
URL_RULE = "Use an http or https address."
TO_NEEDED = "Add at least one address to send to."
ADDRESS_RULE = "Use addresses like ops@example.test."
PORT_RULE = "Use a port from 1 to 65535."
TYPE_FIXED = "A contact point's type can't change. Add a new one instead."
SECRET_UNREADABLE = "The saved secret of {name} can't be read. Enter it again."
SECRET_AGAIN = "{name} sends to a new address now. Enter its secret again."
UNKNOWN_FIELD = "Remove the unrecognized field and try again."
# Not in the plan's copy list; needed for values none of the above describes.
URL_CREDENTIALS = "Use an address without a user name or password in it."
TOO_MANY_TO = f"Send to at most {MAX_RECIPIENTS} addresses."
HOST_RULE = "Enter the mail server's host name, without spaces."
SECURITY_RULE = "Use one of: starttls, tls, none."
USERNAME_RULE = "Use a user name of up to 256 characters, without line breaks."
PASSWORD_NEEDS_USER = "Add the user name that goes with the password."
PASSWORD_NEEDS_TLS = "A password is sent only over an encrypted connection. Choose starttls or tls."
PASSWORD_RULE = "Use a password of up to 1024 characters, without line breaks."
TOKEN_RULE = "A token uses printable characters only, without line breaks."

TYPE_LABELS = {
    "slack": "Slack",
    "email": "Email",
    "teams": "Microsoft Teams",
    "pagerduty": "PagerDuty",
    "webhook": "Webhook",
}

_ROUTING_KEY = re.compile(r"[A-Za-z0-9]{32}")
_LABEL = r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"
# A plain address: no display name, comment or quoting, and a dotted domain.
_ADDRESS = re.compile(rf"[^@\s<>()\[\]\\,;:\"]+@{_LABEL}(?:\.{_LABEL})+")
_HOST = re.compile(r"[A-Za-z0-9._:\[\]-]+")


class ContactPointInvalid(ValueError):
    """A name, setting or secret OmniKrux can't use; the message is the copy (never a value)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class SecretNeeded(ContactPointInvalid):
    """A change moves the contact point to a new address while keeping a secret that would go
    there: the secret has to be entered again. `field` is the secret's key."""

    def __init__(self, name: str, field: str) -> None:
        super().__init__(SECRET_AGAIN.format(name=name))
        self.field = field


class UnknownContactPoint(KeyError):
    pass


class SecretsUnreadable(Exception):
    """The contact point's stored secrets can't be decrypted (the key changed)."""

    def __init__(self, name: str) -> None:
        super().__init__(SECRET_UNREADABLE.format(name=name))
        self.message = SECRET_UNREADABLE.format(name=name)


@dataclass(frozen=True)
class ContactPoint:
    """A contact point as stored, its secrets decrypted. Internal only: it never leaves the
    backend (routes answer `ContactPointOut`), and its repr leaves the secrets out."""

    id: str
    name: str
    type: ContactPointType
    settings: Mapping[str, object]
    secrets: Mapping[str, str] = field(repr=False)
    last_delivery_at: datetime | None
    last_delivery_ok: bool | None
    last_delivery_message: str | None
    created_at: datetime
    updated_at: datetime
    secrets_unreadable: bool = False

    @property
    def secrets_set(self) -> list[str]:
        """The names of the secrets it holds; none when they can't be read."""
        if self.secrets_unreadable:
            return []
        return sorted(key for key, value in self.secrets.items() if value)


@dataclass(frozen=True)
class NoticeInstance:
    labels: Mapping[str, str]
    value: float | None
    starts_at: datetime | None
    ends_at: datetime | None
    message: str


@dataclass(frozen=True)
class Notice:
    """One message to send: what happened to a rule (or a test)."""

    kind: NoticeKind
    rule_name: str
    project_name: str | None
    severity: Severity | None
    summary: str
    instances: tuple[NoticeInstance, ...]
    link_hint: str | None
    dedup_key: str


class DeliveryFailed(Exception):
    """A sender couldn't deliver. `message` is the copy: it names the contact point and never
    carries an address, a path, a token or a password. `retry` False: another attempt can't
    help, or would send a message some recipients already got."""

    def __init__(self, message: str, *, retry: bool = True) -> None:
        super().__init__(message)
        self.message = message
        self.retry = retry

    def __repr__(self) -> str:
        return f"DeliveryFailed({self.message!r})"


# -- checks ------------------------------------------------------------------------------------


def _has_control(text: str) -> bool:
    return any(unicodedata.category(c) == "Cc" for c in text)


def checked_name(name: object) -> str:
    if not isinstance(name, str):
        raise ContactPointInvalid(NAME_RULE)
    name = name.strip()
    if not 1 <= len(name) <= MAX_NAME or _has_control(name):
        raise ContactPointInvalid(NAME_RULE)
    return name


def checked_url(url: object) -> str:
    """An http or https address with a host; never echoed back."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL:
        raise ContactPointInvalid(URL_RULE)
    if any(c.isspace() or _has_control(c) for c in url):
        raise ContactPointInvalid(URL_RULE)
    try:
        parts = urlsplit(url)
        parts.port  # noqa: B018 - raises ValueError for a port that isn't a number
    except ValueError:
        raise ContactPointInvalid(URL_RULE) from None
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        raise ContactPointInvalid(URL_RULE)
    if "@" in parts.netloc:
        raise ContactPointInvalid(URL_CREDENTIALS)
    return url


def url_host(url: str) -> str:
    """`scheme://host[:port]` of an address: what may be shown of a webhook's address."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if ":" in host:  # an IPv6 address
        host = f"[{host}]"
    port = f":{parts.port}" if parts.port is not None else ""
    return f"{parts.scheme.lower()}://{host}{port}"


def checked_address(address: object) -> str:
    if not isinstance(address, str):
        raise ContactPointInvalid(ADDRESS_RULE)
    address = address.strip()
    if len(address) > 254 or not _ADDRESS.fullmatch(address):
        raise ContactPointInvalid(ADDRESS_RULE)
    return address


def _refuse_unknown(keys: object, allowed: tuple[str, ...]) -> None:
    if any(key not in allowed for key in keys):  # type: ignore[attr-defined]
        raise ContactPointInvalid(UNKNOWN_FIELD)


def _email_settings(given: Mapping[str, object]) -> dict[str, object]:
    host = given.get("host")
    if not isinstance(host, str) or not host.strip():
        raise ContactPointInvalid(HOST_RULE)
    host = host.strip()
    if len(host) > MAX_HOST or not _HOST.fullmatch(host):
        raise ContactPointInvalid(HOST_RULE)

    port = given.get("port")
    if port is None:
        port = DEFAULT_PORT
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise ContactPointInvalid(PORT_RULE)

    security = given.get("security") or DEFAULT_SECURITY
    if security not in SECURITIES:
        raise ContactPointInvalid(SECURITY_RULE)

    username = given.get("username")
    if username is not None and not isinstance(username, str):
        raise ContactPointInvalid(USERNAME_RULE)
    username = (username or "").strip() or None
    if username is not None and (len(username) > MAX_USERNAME or _has_control(username)):
        raise ContactPointInvalid(USERNAME_RULE)

    from_address = given.get("from_address")
    if from_address is None or from_address == "":
        raise ContactPointInvalid(ADDRESS_RULE)
    from_address = checked_address(from_address)

    to = given.get("to")
    if to is None or to == [] or to == "":
        raise ContactPointInvalid(TO_NEEDED)
    if not isinstance(to, list):
        raise ContactPointInvalid(ADDRESS_RULE)
    if len(to) > MAX_RECIPIENTS:
        raise ContactPointInvalid(TOO_MANY_TO)
    addresses: list[str] = []
    for each in to:
        address = checked_address(each)
        if address not in addresses:
            addresses.append(address)
    return {
        "host": host,
        "port": port,
        "security": security,
        "username": username,
        "from_address": from_address,
        "to": addresses,
    }


def checked_settings(type: ContactPointType, given: Mapping[str, object]) -> dict[str, object]:
    """The type's settings as stored (defaults filled in). A webhook's `url_host` is left out
    here: `resolve` derives it from the address."""
    _refuse_unknown(given.keys(), SETTING_KEYS[type])
    if type == "email":
        return _email_settings(given)
    if type == "pagerduty":
        events_url = given.get("events_url") or DEFAULT_EVENTS_URL
        return {"events_url": checked_url(events_url)}
    return {}


def _checked_secret(type: ContactPointType, key: str, value: str) -> str:
    if key in URL_SECRETS:
        return checked_url(value)
    if key == "routing_key":
        if not _ROUTING_KEY.fullmatch(value):
            raise ContactPointInvalid(MISSING_SECRET["pagerduty"])
        return value
    if key == "bearer_token":
        if len(value) > MAX_TOKEN or any(
            (ord(c) < 32 and c != "\t") or 127 <= ord(c) < 160 or ord(c) > 255 for c in value
        ):
            raise ContactPointInvalid(TOKEN_RULE)
        return value
    if key == "password":
        if len(value) > MAX_PASSWORD or any(_has_control(c) and c != "\t" for c in value):
            raise ContactPointInvalid(PASSWORD_RULE)
        return value
    raise ContactPointInvalid(UNKNOWN_FIELD)  # pragma: no cover - keys are checked first


def merged_secrets(
    type: ContactPointType,
    stored: Mapping[str, str] | None,
    given: Mapping[str, str | None],
) -> dict[str, str] | None:
    """The secrets to store: `stored` with `given` applied (a value sets it, `None` keeps the
    stored one, `""` clears it). `stored` None means the stored secrets can't be read: then None
    when nothing is given (keep them as they are), else only what is given counts.
    ContactPointInvalid when a value can't be used or the type's required secret is missing."""
    _refuse_unknown(given.keys(), SECRET_KEYS[type])
    if stored is None and all(value is None for value in given.values()):
        return None
    secrets = dict(stored or {})
    for key, value in given.items():
        if value is None:
            continue
        if value == "":
            secrets.pop(key, None)
        else:
            secrets[key] = _checked_secret(type, key, value)
    required = REQUIRED_SECRET.get(type)
    if required is not None and not secrets.get(required):
        raise ContactPointInvalid(MISSING_SECRET[type])
    return secrets


def check_together(
    type: ContactPointType, settings: Mapping[str, object], secrets: Mapping[str, str] | None
) -> None:
    """Rules that span settings and secrets (email: a password needs a user name, and is only
    sent encrypted). `secrets` None (unreadable, kept as they are) passes."""
    if type != "email" or not secrets or not secrets.get("password"):
        return
    if not settings.get("username"):
        raise ContactPointInvalid(PASSWORD_NEEDS_USER)
    if settings.get("security") == "none":
        raise ContactPointInvalid(PASSWORD_NEEDS_TLS)


@dataclass(frozen=True)
class Resolved:
    """A contact point's checked name, settings and secrets (None: unreadable, kept as stored)."""

    name: str
    settings: dict[str, object]
    secrets: dict[str, str] | None = field(repr=False)


def resolve(
    type: ContactPointType,
    *,
    name: object,
    settings: Mapping[str, object],
    secrets: Mapping[str, str | None],
    stored_settings: Mapping[str, object] | None = None,
    stored_secrets: Mapping[str, str] | None = None,
    secrets_unreadable: bool = False,
) -> Resolved:
    """Check a new contact point (nothing stored) or a change (settings merged onto
    `stored_settings`, secrets onto `stored_secrets`). ContactPointInvalid with the copy."""
    clean = checked_name(name)
    _refuse_unknown(settings.keys(), SETTING_KEYS[type])
    base = {k: v for k, v in (stored_settings or {}).items() if k != "url_host"}
    given = {k: v for k, v in settings.items() if k != "url_host"}
    checked = checked_settings(type, {**base, **given})
    stored = None if secrets_unreadable else dict(stored_secrets or {})
    merged = merged_secrets(type, stored, secrets)
    if type == "webhook":
        if merged is not None:
            checked["url_host"] = url_host(merged["url"])
        elif stored_settings and stored_settings.get("url_host"):
            checked["url_host"] = stored_settings["url_host"]
    check_together(type, checked, merged)
    if stored_settings is not None and stored:
        _secret_follows(type, clean, base, checked, stored, secrets)
    return Resolved(name=clean, settings=checked, secrets=merged)


def _destination(type: ContactPointType, settings: Mapping[str, object], secrets: Mapping) -> tuple:
    """Where the contact point's dependent secret is sent."""
    if type == "pagerduty":
        return (settings.get("events_url"),)
    if type == "email":
        return (settings.get("host"), settings.get("port"))
    if type == "webhook":
        return (secrets.get("url"),)
    return ()


def _secret_follows(
    type: ContactPointType,
    name: str,
    stored_settings: Mapping[str, object],
    settings: Mapping[str, object],
    stored: Mapping[str, str],
    given: Mapping[str, str | None],
) -> None:
    """A stored secret never follows a contact point to a new address: when the address it is
    sent to changes, the change must carry that secret too (a value, or `""` to clear it).
    SecretNeeded otherwise."""
    key = DEPENDENT_SECRET.get(type)
    if key is None or not stored.get(key) or given.get(key) is not None:
        return
    new_secrets = {**stored, **{k: v for k, v in given.items() if v is not None}}
    before = _destination(type, stored_settings, stored)
    if before != _destination(type, settings, new_secrets):
        raise SecretNeeded(name, key)


def summary_of(cp: ContactPoint) -> str:
    """One line that tells contact points apart without showing a secret."""
    if cp.type == "slack":
        return "Slack webhook"
    if cp.type == "teams":
        return "Teams webhook"
    if cp.type == "pagerduty":
        return "PagerDuty Events v2"
    if cp.type == "email":
        return ", ".join(str(a) for a in cp.settings.get("to") or [])  # type: ignore[union-attr]
    return str(cp.settings.get("url_host") or "")
