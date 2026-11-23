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


def _walk(
    route: Any,
    receiver: str | None,
    inherited: Mapping[str, str],
    inherited_usable: bool,
    path: str,
    depth: int,
    out: list[Channel],
) -> None:
    if not isinstance(route, dict) or depth > MAX_DEPTH:
        return
    own = route.get("receiver")
    receiver = own if isinstance(own, str) and own else receiver
    labels: dict[str, str] = dict(inherited)
    usable = inherited_usable
    if receiver:
        for text in route.get("matchers") or []:
            try:
                parsed = parse_matchers(str(text))
            except FilterError:
                usable = False
                continue
            for m in parsed:
                if m.op == "=":
                    labels[m.label] = m.value
                else:
                    usable = False
        match = route.get("match")
        if isinstance(match, dict):
            labels.update({str(k): str(v) for k, v in match.items()})
        if route.get("match_re"):
            usable = False
        out.append(
            Channel(
                receiver=receiver,
                labels=labels,
                usable=usable,
                reason=None if usable else PATTERN_REASON,
                path=path,
            )
        )
    children = route.get("routes")
    if isinstance(children, list):
        for i, child in enumerate(children):
            prefix = "" if path == "default" else f"{path}."
            _walk(child, receiver, labels, usable, f"{prefix}routes[{i}]", depth + 1, out)


def parse_channels(config_yaml: str) -> list[Channel]:
    """The channels of a configuration: the root first, then each route in order. A nested route
    needs its parents' labels too, so it carries them; channels with the same receiver and
    labels are one."""
    try:
        config = yaml.safe_load(config_yaml)
    except yaml.YAMLError:
        raise ChannelsUnreadable(UNREADABLE.format(name="The Alertmanager")) from None
    route = config.get("route") if isinstance(config, dict) else None
    if not isinstance(route, dict):
        raise ChannelsUnreadable(UNREADABLE.format(name="The Alertmanager"))
    found: list[Channel] = []
    _walk(route, None, {}, True, "default", 0, found)
    seen: set[tuple[str, tuple[tuple[str, str], ...]]] = set()
    channels: list[Channel] = []
    for c in found:
        key = (c.receiver, tuple(sorted(c.labels.items())))
        if key not in seen:
            seen.add(key)
            channels.append(c)
    return channels


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
