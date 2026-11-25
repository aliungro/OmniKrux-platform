"""Which of a project's Prometheus sources a ready-made view reads, and what its notes may say.

A project may link several Prometheus sources (an operator's next to a plain one, say), and the
exporters a view needs may report to only one of them. Each link is asked, under its filter and
over the whole retention, which of the three metrics in `NEED_METRIC` it holds; all links at
once. A view then reads the first link that holds everything it needs, else the readable link
that holds the most of it, else the first link.

A need no readable link holds is said in the view's notes (`NEED_NOTE`), or, when a link holds
it but its filter hides it, `NEED_FILTERED` names that link and filter. Nothing is said while a
link that might hold it couldn't be read."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

from omnikrux.monitoring.dashboards.ready_made import (
    NEED_FILTERED,
    NEED_METRIC,
    NEED_NOTE,
    NEED_WORDS,
    NEEDS,
    PROMETHEUS_VIEWS,
    Need,
    ReadyKey,
)
from omnikrux.monitoring.projects.types import Link, Matcher, Project
from omnikrux.monitoring.query.filters import FilterError, render_matchers
from omnikrux.monitoring.sources.connector import QueryRejected
from omnikrux.monitoring.sources.health import SECRETS_UNREADABLE
from omnikrux.monitoring.sources.transport import SourceUnreachable
from omnikrux.monitoring.sources.types import SourceConfig

if TYPE_CHECKING:
    # Under TYPE_CHECKING: the services import the dashboards' modules.
    from omnikrux.monitoring.services import MonitoringServices

# The three metrics that prove an exporter reports (`NEED_METRIC`), as one selector.
NEED_SELECTOR = (
    '{__name__=~"kube_pod_info|container_cpu_usage_seconds_total|node_cpu_seconds_total"}'
)
_NEED_OF = {metric: need for need, metric in NEED_METRIC.items()}
ALL_NEEDS: frozenset[Need] = frozenset(NEED_METRIC)


@dataclass(frozen=True)
class PromLink:
    """One Prometheus link of a project, as read. `has` is None when it couldn't be read, and
    `message` then says why; `hidden` holds the needs the source has without the link's filter
    but not with it (read only when the link has a filter that hides one; else empty)."""

    source_id: str
    source_name: str
    filter: str
    has: frozenset[Need] | None
    hidden: frozenset[Need]
    message: str | None


async def _held(
    services: MonitoringServices, source: SourceConfig, matchers: Sequence[Matcher]
) -> frozenset[Need]:
    connector = services.connectors.get(source.type)
    names = await connector.label_values(
        services.transports.for_source(source),
        "__name__",
        matchers=matchers,
        selector=NEED_SELECTOR,
        limit=10,
    )
    return frozenset(_NEED_OF[name] for name in names if name in _NEED_OF)


async def _read(services: MonitoringServices, source: SourceConfig, link: Link) -> PromLink:
    try:
        text = render_matchers(link.matchers)
    except FilterError as exc:  # a stored filter OmniKrux can't write into a query
        return PromLink(source.id, source.name, "", None, frozenset(), str(exc))
    if source.secrets_unreadable:
        return PromLink(source.id, source.name, text, None, frozenset(), SECRETS_UNREADABLE)
    try:
        has = await _held(services, source, link.matchers)
    except (SourceUnreachable, QueryRejected) as exc:
        return PromLink(source.id, source.name, text, None, frozenset(), exc.message)
    hidden: frozenset[Need] = frozenset()
    if link.matchers and has != ALL_NEEDS:
        # A project query without its filter (spec §2 adds the filter to every one): allowed here
        # as a lookup of three metric names whose answer only feeds NEED_FILTERED, never data.
        try:
            hidden = await _held(services, source, ()) - has
        except (SourceUnreachable, QueryRejected):
            hidden = frozenset()  # unknown: the notes then don't blame the filter
    return PromLink(source.id, source.name, text, has, hidden, None)


async def read_prometheus_links(
    services: MonitoringServices, project: Project, configs: list[SourceConfig]
) -> list[PromLink]:
    """One `PromLink` per Prometheus link of the project whose source still exists, in link
    order, all read at once."""
    by_id = {c.id: c for c in configs}
    reads = [
        _read(services, by_id[link.source_id], link)
        for link in project.links
        if link.source_id in by_id and by_id[link.source_id].type == "prometheus"
    ]
    return list(await asyncio.gather(*reads))


def pick_prometheus(key: ReadyKey, links: list[PromLink]) -> PromLink | None:
    """The link `key`'s view reads: the first whose `has` covers `NEEDS[key]`; else the readable
    link with the most of them (ties: link order); else the first link; None without links."""
    needs = set(NEEDS[key])
    readable = [link for link in links if link.has is not None]
    for link in readable:
        if needs <= link.has:  # type: ignore[operator]
            return link
    if readable:
        return max(readable, key=lambda link: len(needs & link.has))  # type: ignore[operator]
    return links[0] if links else None


@dataclass(frozen=True)
class PromCheck:
    """What a view's notes say about its exporters. `checked` False: it can't be told (`message`
    says why), and `missing` and `notes` are empty, never guessed."""

    checked: bool
    message: str | None
    missing: list[Need]
    notes: list[str]


def check_needs(key: ReadyKey, chosen: PromLink, links: list[PromLink]) -> PromCheck:
    """`missing` = the view's needs no readable link holds; each is said as `NEED_FILTERED` when a
    link's filter hides it (the first such link), else as `NEED_NOTE`. When the chosen link is
    unread, or a need is missing while another link is unread (that one might hold it), nothing
    is said but why."""
    if chosen.has is None:
        return PromCheck(False, chosen.message, [], [])
    readable = [link for link in links if link.has is not None]
    missing = [n for n in NEEDS[key] if not any(n in link.has for link in readable)]  # type: ignore[operator]
    unread = next((link for link in links if link.has is None), None)
    if missing and unread is not None:
        return PromCheck(False, unread.message, [], [])
    notes = []
    for need in missing:
        hiding = next((link for link in readable if need in link.hidden), None)
        if hiding is None:
            notes.append(NEED_NOTE[need])
            continue
        exporter, what = NEED_WORDS[need]
        notes.append(
            NEED_FILTERED.format(
                exporter=exporter, source=hiding.source_name, filter=hiding.filter, what=what
            )
        )
    return PromCheck(True, None, missing, notes)


async def chosen_prometheus_id(
    services: MonitoringServices, project: Project, configs: list[SourceConfig], key: ReadyKey
) -> str | None:
    """The id of the Prometheus `key`'s view reads (its links read now); None for a view that
    reads no Prometheus, or a project without one."""
    if key not in PROMETHEUS_VIEWS:
        return None
    chosen = pick_prometheus(key, await read_prometheus_links(services, project, configs))
    return chosen.source_id if chosen is not None else None
