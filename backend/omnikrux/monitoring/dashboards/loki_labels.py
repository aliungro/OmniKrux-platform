"""Which labels a project's Loki puts on its streams, for the ready-made log panels.

Logs shipped by an OpenTelemetry Collector carry `k8s_namespace_name`, `k8s_pod_name`,
`k8s_container_name` and `service_name`; promtail and Alloy carry `namespace`, `pod`,
`container` and `app`. A Loki may hold both (old lines with one set, new lines with the other):
the OpenTelemetry set wins when both its namespace and pod labels exist, and the classic set is
used only when both of *its* labels exist. Neither is never guessed: the view's notes say so.

The labels are read once per request, under the project's filter, over the last 7 days
(`LOKI_LABEL_WINDOW`), never from the browser."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, cast

from omnikrux.monitoring.projects.types import Matcher, Project
from omnikrux.monitoring.sources.connector import LOKI_LABEL_WINDOW, QueryRejected
from omnikrux.monitoring.sources.health import SECRETS_UNREADABLE
from omnikrux.monitoring.sources.transport import SourceUnreachable
from omnikrux.monitoring.sources.types import SourceConfig

if TYPE_CHECKING:
    # Under TYPE_CHECKING: the services import the dashboards' modules.
    from omnikrux.monitoring.services import MonitoringServices
    from omnikrux.monitoring.sources.loki import LokiConnector


@dataclass(frozen=True)
class LokiLabelSet:
    """The labels one style of log shipper names a stream's namespace, Pod, container and app
    with."""

    style: Literal["otel", "classic"]
    namespace: str
    pod: str
    container: str
    app: str


OTEL = LokiLabelSet(
    "otel", "k8s_namespace_name", "k8s_pod_name", "k8s_container_name", "service_name"
)
CLASSIC = LokiLabelSet("classic", "namespace", "pod", "container", "app")

# The labels that may hold a line's level, in the order they are preferred.
LEVEL_LABELS = ("level", "detected_level", "severity")
# The labels streams are grouped by when there are no Pod labels, in the order they are preferred.
GROUP_FALLBACK = ("service_name", "app", "job", "container", "k8s_container_name")


def pick_label_set(labels: frozenset[str]) -> LokiLabelSet | None:
    """OTEL when both its namespace and Pod labels exist, else CLASSIC when both of its exist,
    else None."""
    for found in (OTEL, CLASSIC):
        if found.namespace in labels and found.pod in labels:
            return found
    return None


def level_label(labels: frozenset[str]) -> str | None:
    """The first of `LEVEL_LABELS` the streams carry; None when none."""
    return next((name for name in LEVEL_LABELS if name in labels), None)


def group_label(labels: frozenset[str]) -> str | None:
    """The first of `GROUP_FALLBACK` the streams carry, else the first label by name that isn't
    Loki's own (`__…`); None when there is none."""
    found = next((name for name in GROUP_FALLBACK if name in labels), None)
    if found is not None:
        return found
    return next((name for name in sorted(labels) if not name.startswith("__")), None)


@dataclass(frozen=True)
class LokiFacts:
    """What a project's Loki holds. `labels` is None when they couldn't be read, and `message`
    then says why (in the tool's or OmniKrux's words); otherwise `message` is None."""

    labels: frozenset[str] | None
    message: str | None


def _first_loki(
    project: Project, configs: list[SourceConfig]
) -> tuple[SourceConfig, Sequence[Matcher]] | None:
    """The project's first linked Loki that still exists, and that link's matchers."""
    by_id = {c.id: c for c in configs}
    for link in project.links:
        source = by_id.get(link.source_id)
        if source is not None and source.type == "loki":
            return source, link.matchers
    return None


async def read_loki_facts(
    services: MonitoringServices, project: Project, configs: list[SourceConfig], now: float
) -> LokiFacts | None:
    """The label names of the project's first Loki link, under that link's filter, over
    `[now - LOKI_LABEL_WINDOW, now]` (seconds); None when the project has no Loki. A Loki that
    can't be reached or refuses, or whose credentials can't be read, gives `LokiFacts(None, why)`."""
    found = _first_loki(project, configs)
    if found is None:
        return None
    source, matchers = found
    if source.secrets_unreadable:
        return LokiFacts(None, SECRETS_UNREADABLE)
    connector = cast("LokiConnector", services.connectors.get(source.type))
    try:
        names = await connector.label_names(
            services.transports.for_source(source),
            matchers=matchers,
            start=now - LOKI_LABEL_WINDOW,
            end=now,
        )
    except (SourceUnreachable, QueryRejected) as exc:
        return LokiFacts(None, exc.message)
    return LokiFacts(frozenset(names), None)
