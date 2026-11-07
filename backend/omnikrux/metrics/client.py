"""Reading metrics.k8s.io (metrics-server) and turning its answers, and its absence, into words."""

import json
import re
from datetime import UTC, datetime
from urllib.parse import quote

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.kube.connections import kube_error_message
from omnikrux.kube.http import call_json
from omnikrux.metrics.models import State, Usage
from omnikrux.resources.quantity import parse_bytes, parse_cpu_m

STALE_SECONDS = 120
BASE = "/apis/metrics.k8s.io/v1beta1"

NOT_INSTALLED = "Metrics not available on this cluster: metrics-server isn't installed."
NOT_ANSWERING = (
    "Metrics not available on this cluster: metrics-server isn't answering. "
    "Check its pod in kube-system."
)
NO_DATA_YET = "No metrics yet: metrics-server hasn't measured it."

_DURATION = re.compile(r"(\d+(?:\.\d+)?)(ms|[hms])")
_UNITS = {"h": 3600, "m": 60, "s": 1, "ms": 0.001}


def parse_window(text: object) -> float:
    """Seconds in a Go duration such as `30s` or `1m0s`; 0 when it isn't one."""
    if not isinstance(text, str):
        return 0.0
    return sum(float(n) * _UNITS[u] for n, u in _DURATION.findall(text))


def parse_time(text: object) -> datetime | None:
    if not isinstance(text, str):
        return None
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def is_stale(timestamp: object, fetched: datetime) -> bool:
    """True when the measurement is older than STALE_SECONDS at `fetched`, or has no usable time."""
    moment = parse_time(timestamp)
    return moment is None or (fetched - moment).total_seconds() > STALE_SECONDS


def usage_of(item: dict, fetched: datetime) -> Usage:
    """One PodMetrics (its containers summed) or NodeMetrics as a Usage."""
    if "containers" in item:
        parts = [c.get("usage") or {} for c in item["containers"] or []]
    else:
        parts = [item.get("usage") or {}]
    return Usage(
        cpu_m=sum(parse_cpu_m(p.get("cpu", "0")) for p in parts),
        memory_b=sum(parse_bytes(p.get("memory", "0")) for p in parts),
        at=str(item.get("timestamp") or ""),
        window_s=parse_window(item.get("window")),
        stale=is_stale(item.get("timestamp"), fetched),
    )


async def fetch_usage(
    api: ApiClient, kind: str, *, timeout: float, fetched: datetime
) -> dict[str, Usage]:
    """Every pod's ("ns/name") or node's (name) current usage; a non-2xx answer raises."""
    body = await call_json(api, "GET", f"{BASE}/{kind}", timeout=timeout)
    items: dict[str, Usage] = {}
    for item in body.get("items") or []:
        meta = item.get("metadata") or {}
        key = f"{meta['namespace']}/{meta['name']}" if kind == "pods" else meta["name"]
        items[key] = usage_of(item, fetched)
    return items


async def fetch_one(
    api: ApiClient, kind: str, namespace: str | None, name: str, *, timeout: float
) -> dict:
    """One PodMetrics or NodeMetrics as the API returns it; a non-2xx answer raises."""
    where = f"/namespaces/{quote(namespace, safe='')}" if namespace is not None else ""
    return await call_json(
        api, "GET", f"{BASE}{where}/{kind}/{quote(name, safe='')}", timeout=timeout
    )


def _names_missing_metrics(exc: ApiException) -> bool:
    """A 404 that says one object has no metrics (`podmetrics.metrics.k8s.io "x" not found`), as
    opposed to the whole API not being served."""
    try:
        message = json.loads(exc.body or "").get("message", "")
    except (ValueError, AttributeError):
        return False
    return isinstance(message, str) and 'metrics.metrics.k8s.io "' in message


def failure_of(exc: Exception) -> tuple[State, str]:
    """The state and words for a failed metrics call."""
    if isinstance(exc, ApiException):
        if exc.status == 404:
            if _names_missing_metrics(exc):
                return "error", NO_DATA_YET
            return "unavailable", NOT_INSTALLED
        if exc.status == 503:
            return "unavailable", NOT_ANSWERING
    return "error", kube_error_message(exc, "read metrics")
