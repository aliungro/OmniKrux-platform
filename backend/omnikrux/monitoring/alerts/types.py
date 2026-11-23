"""Shared names and limits for alerts."""

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Literal

Engine = Literal["omnikrux", "tool"]
ToolKind = Literal["prometheus_rule", "loki_ruler"]
Severity = Literal["critical", "warning", "info"]
Op = Literal["above", "below"]
Of = Literal["each", "total"]
ScopeKind = Literal["project", "group"]
TargetState = Literal[
    "ok", "pending", "firing", "no_data", "unreachable", "error", "paused", "waiting", "not_applied"
]
ToolState = Literal["in_sync", "needs_review", "failed"]

# The worst state first: what a group of targets shows as one.
STATE_ORDER: tuple[TargetState, ...] = (
    "firing",
    "error",
    "unreachable",
    "not_applied",
    "pending",
    "waiting",
    "no_data",
    "ok",
    "paused",
)

ALERT_PANEL_TYPES = ("timeseries", "stat", "gauge", "bar")
SEVERITIES = ("critical", "warning", "info")
EVERY_CHOICES = {"30s": 30, "1m": 60, "5m": 300}
MAX_FOR_SECONDS = 86400
MAX_NOTIFY = 10
MAX_CHANNEL_LABELS = 10


def worst(states: Iterable[TargetState]) -> TargetState:
    """The state that comes first in STATE_ORDER; "ok" for none."""
    found = set(states)
    for state in STATE_ORDER:
        if state in found:
            return state
    return "ok"


@dataclass(frozen=True)
class Condition:
    of: Of
    op: Op
    threshold: float
    for_seconds: int
    every_seconds: int


@dataclass(frozen=True)
class ChannelPick:
    receiver: str
    labels: Mapping[str, str]
