"""Notification channels, read from an Alertmanager's routes.

A channel is a receiver together with the labels an alert needs to reach it. OmniKrux can add
equality labels to an alert, so only routes matched by equality are usable."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import yaml

from omnikrux.monitoring.query.filters import FilterError, parse_matchers
from omnikrux.monitoring.sources.connector import json_object
from omnikrux.monitoring.sources.transport import SourceTransport

PATTERN_REASON = "Uses a pattern match, so OmniKrux can't add labels that reach it."
UNPARSED_REASON = "OmniKrux couldn't read this route's matchers."
SHADOWED_REASON = "An earlier route catches these alerts first, so they never reach this one."
CHILD_REASON = "A route under it catches these alerts first, so they never reach this one."
NOWHERE_REASON = "Sends nowhere: this receiver has no notifications set up."
CONTRADICTS_REASON = "Its labels contradict the routes above it, so no alert can reach it."
UNREADABLE = "{name}'s configuration couldn't be read, so its channels can't be listed."
PROBE_SECONDS = 10.0
MAX_DEPTH = 20


class ChannelsUnreadable(Exception):
    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class Channel:
    receiver: str
    labels: Mapping[str, str]
    usable: bool
    reason: str | None
    path: str  # "default" or the route's position, like "routes[1].routes[0]"


def _own(route: dict) -> tuple[dict[str, str], str | None]:
    """The equality labels a route's own matchers need, and why they can't all be added (None
    when they can)."""
    labels: dict[str, str] = {}
    reason: str | None = None
    for text in route.get("matchers") or []:
        try:
            parsed = parse_matchers(str(text))
        except FilterError:
            reason = reason or UNPARSED_REASON
            continue
        for m in parsed:
            if m.op == "=":
                labels[m.label] = m.value
            else:
                reason = reason or PATTERN_REASON
    match = route.get("match")
    if isinstance(match, dict):
        labels.update({str(k): str(v) for k, v in match.items()})
    if route.get("match_re"):
        reason = reason or PATTERN_REASON
    return labels, reason


def _walk(
    route: Any,
    receiver: str | None,
    inherited: Mapping[str, str],
    inherited_reason: str | None,
    path: str,
    depth: int,
    out: list[Channel],
    own: tuple[dict[str, str], str | None] | None = None,
    shadowed: bool = False,
) -> None:
    if not isinstance(route, dict) or depth > MAX_DEPTH:
        return
    own_labels, own_reason = own if own is not None else _own(route)
    named = route.get("receiver")
    receiver = named if isinstance(named, str) and named else receiver
    labels: dict[str, str] = dict(inherited)
    reason = inherited_reason or own_reason
    if reason is None and any(k in inherited and inherited[k] != v for k, v in own_labels.items()):
        reason = CONTRADICTS_REASON
    labels.update(own_labels)
    children = route.get("routes")
    children = children if isinstance(children, list) else []
    parts = [_own(c) if isinstance(c, dict) else ({}, None) for c in children]
    stops = [isinstance(c, dict) and not c.get("continue") for c in children]
    passed_down = reason or (SHADOWED_REASON if shadowed else None)
    # A route's own receiver gets an alert only when no child matches it, `continue` or not: a
    # child whose labels are all among this route's (a catch-all has none) takes every alert
    # this route's channel stands for. A child with a pattern or unreadable matcher can't be
    # proved to match everything, so it takes none.
    if shadowed and reason is None:
        reason = SHADOWED_REASON
    if reason is None and any(why is None and lab.items() <= labels.items() for lab, why in parts):
        reason = CHILD_REASON
    if receiver:
        out.append(
            Channel(
                receiver=receiver,
                labels=labels,
                usable=reason is None,
                reason=reason,
                path=path,
            )
        )
    prefix = "" if path == "default" else f"{path}."
    # The effective labels of earlier children that stop the walk. A later sibling is shadowed
    # only by one that matches everything it matches; a pattern or unreadable matcher proves
    # nothing, so such an earlier sibling never shadows.
    catching: list[dict[str, str]] = []
    for i, child in enumerate(children):
        own_child = parts[i]
        effective = labels | own_child[0]
        caught = any(e.items() <= effective.items() for e in catching)
        _walk(
            child,
            receiver,
            labels,
            passed_down,
            f"{prefix}routes[{i}]",
            depth + 1,
            out,
            own_child,
            caught,
        )
        if stops[i] and own_child[1] is None:
            catching.append(effective)


def parse_channels(config_yaml: str) -> list[Channel]:
    """The channels of a configuration: the root first, then each route in order. A nested route
    needs its parents' labels too, so it carries them; a route an earlier sibling (without
    `continue`) catches first, or whose labels contradict its parents', is unusable. Channels
    with the same receiver and labels are one, a usable one kept over an unusable one."""
    try:
        config = yaml.safe_load(config_yaml)
    except yaml.YAMLError:
        raise ChannelsUnreadable(UNREADABLE.format(name="The Alertmanager")) from None
    route = config.get("route") if isinstance(config, dict) else None
    if not isinstance(route, dict):
        raise ChannelsUnreadable(UNREADABLE.format(name="The Alertmanager"))
    found: list[Channel] = []
    _walk(route, None, {}, None, "default", 0, found)
    nowhere = _silent_receivers(config.get("receivers"))
    found = [
        Channel(c.receiver, c.labels, False, NOWHERE_REASON, c.path)
        if c.usable and c.receiver in nowhere
        else c
        for c in found
    ]
    at: dict[tuple[str, tuple[tuple[str, str], ...]], int] = {}
    channels: list[Channel] = []
    for c in found:
        key = (c.receiver, tuple(sorted(c.labels.items())))
        if key not in at:
            at[key] = len(channels)
            channels.append(c)
        elif not channels[at[key]].usable and c.usable:
            channels[at[key]] = c
    return channels


def _silent_receivers(receivers: Any) -> set[str]:
    """The receivers that send nowhere (no `*_configs` with an entry, like the usual "null"
    receiver); none when the list can't be read."""
    if not isinstance(receivers, list):
        return set()
    silent: set[str] = set()
    for r in receivers:
        if not isinstance(r, dict) or not isinstance(r.get("name"), str):
            continue
        sends = any(k.endswith("_configs") and isinstance(v, list) and v for k, v in r.items())
        if not sends:
            silent.add(r["name"])
    return silent


async def read_channels(transport: SourceTransport, name: str) -> list[Channel]:
    """The channels of the Alertmanager behind `transport`; `ChannelsUnreadable` when its
    configuration can't be read. `SourceUnreachable` is raised as the transport does."""
    got = await transport.request("GET", "/api/v2/status", timeout=PROBE_SECONDS)
    data = json_object(got.body) if got.status == 200 else None
    config = data.get("config") if data is not None else None
    original = config.get("original") if isinstance(config, dict) else None
    if not isinstance(original, str):
        raise ChannelsUnreadable(UNREADABLE.format(name=name))
    try:
        return parse_channels(original)
    except ChannelsUnreadable:
        raise ChannelsUnreadable(UNREADABLE.format(name=name)) from None
