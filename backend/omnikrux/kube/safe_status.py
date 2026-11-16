"""A cloud cluster's Kubernetes Status body, reduced to what is safe to show, log and decide on.

A managed API server (or a proxy in front of it) may echo the caller's bearer token or its private
endpoint in a Status message. The callers still need the API server's reason: a drain tells a
uid-precondition 409 from a write conflict, metrics tell "no data for this pod" from "the API isn't
served", and admission or validation refusals name their cause. So the body keeps its code, reason
and causes, and every message loses credentials and addresses before anything can read it.
"""

import json
import re
from collections.abc import Iterable

MAX_STATUS_BYTES = 64 * 1024
MAX_MESSAGE = 500
MAX_CAUSES = 10
MAX_NAME = 253
REDACTED = "[redacted]"
ADDRESS = "[address]"

_REASON = re.compile(r"[A-Za-z]{1,64}")
_FIELD = re.compile(r"[A-Za-z0-9_.\[\]-]{1,253}")
_PATTERNS = (
    # Addresses first, so a credential inside a URL (userinfo, query) goes with it.
    (re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]*://[^\s\"'<>]+"), ADDRESS),
    (re.compile(r"(?i)\b(bearer|basic)\s+[^\s\"',;)]+"), rf"\1 {REDACTED}"),
    (re.compile(r"k8s-aws-v1\.[A-Za-z0-9_=-]+"), REDACTED),
    (re.compile(r"eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*"), REDACTED),
    (re.compile(r"\bya29\.[A-Za-z0-9_.-]+"), REDACTED),
    # Anything else long and opaque enough to be a credential.
    (re.compile(r"[A-Za-z0-9+/_=~.-]{64,}"), REDACTED),
)


def redact(text: str, *, secrets: Iterable[str] = (), hosts: Iterable[str] = ()) -> str:
    """`text` without credentials, URLs, the given secret values or the given host names."""
    for secret in secrets:
        if secret and len(secret) >= 4:  # real tokens are long; short ones are test fakes
            text = text.replace(secret, REDACTED)
    for host in hosts:
        if host:
            text = re.sub(re.escape(host), ADDRESS, text, flags=re.IGNORECASE)
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def _text(value: object, limit: int, secrets: tuple[str, ...], hosts: tuple[str, ...]):
    if not isinstance(value, str) or not value:
        return None
    return redact(value, secrets=secrets, hosts=hosts)[:limit]


def safe_status_body(
    raw: bytes, *, secrets: Iterable[str] = (), hosts: Iterable[str] = ()
) -> bytes:
    """A reduced Status for a non-2xx answer; b"" when the body isn't a Kubernetes Status."""
    secrets, hosts = tuple(secrets), tuple(hosts)
    try:
        data = json.loads(raw[:MAX_STATUS_BYTES])
    except (ValueError, RecursionError):
        return b""
    if not isinstance(data, dict) or data.get("kind") != "Status":
        return b""
    safe: dict = {"kind": "Status", "apiVersion": "v1", "status": "Failure"}
    if type(code := data.get("code")) is int and 100 <= code <= 599:
        safe["code"] = code
    if isinstance(reason := data.get("reason"), str) and _REASON.fullmatch(reason):
        safe["reason"] = reason
    if (message := _text(data.get("message"), MAX_MESSAGE, secrets, hosts)) is not None:
        safe["message"] = message
    if isinstance(details := data.get("details"), dict):
        kept: dict = {}
        for key in ("name", "group", "kind"):
            if (value := _text(details.get(key), MAX_NAME, secrets, hosts)) is not None:
                kept[key] = value
        causes = []
        listed = details.get("causes")
        for cause in listed[:MAX_CAUSES] if isinstance(listed, list) else ():
            if not isinstance(cause, dict):
                continue
            entry = {}
            if isinstance(reason := cause.get("reason"), str) and _REASON.fullmatch(reason):
                entry["reason"] = reason
            if isinstance(field := cause.get("field"), str) and _FIELD.fullmatch(field):
                entry["field"] = field
            if (text := _text(cause.get("message"), MAX_MESSAGE, secrets, hosts)) is not None:
                entry["message"] = text
            if entry:
                causes.append(entry)
        if causes:
            kept["causes"] = causes
        if kept:
            safe["details"] = kept
    return json.dumps(safe).encode()
