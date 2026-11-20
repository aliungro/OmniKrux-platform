"""Whether a Kubernetes project needs a label filter on a source, and which one.

A source can hold the data of several clusters (a central Prometheus, a Thanos, a shared Loki).
OmniKrux looks at the values of the labels that usually name a cluster: when one of them has
several values and one is this cluster's name, the filter keeps that value. The reason says, in
words, what was decided and why; the user can always change the filter."""

import asyncio
from dataclasses import dataclass

from omnikrux.clusters.registry import ClusterInfo
from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.sources.connector import Connector, QueryRejected
from omnikrux.monitoring.sources.health import SECRETS_UNREADABLE
from omnikrux.monitoring.sources.transport import SourceTransport, SourceUnreachable
from omnikrux.monitoring.sources.types import FilterOrigin, ProjectKind, SourceConfig

CANDIDATE_LABELS = ("cluster", "cluster_name", "k8s_cluster_name", "kubernetes_cluster")

KEEPS = "This source holds several clusters; the filter keeps {match}."
INSIDE = "This source runs inside the cluster, so it holds only its data."
NONE_NAMED = (
    "This source holds several clusters, and none is named {cluster}. Set the filter yourself."
)
CANT_TELL = "OmniKrux couldn't tell whether a filter is needed."
CANT_CHECK = "Couldn't check the source: {message}"


@dataclass(frozen=True)
class Suggestion:
    matchers: tuple[Matcher, ...]
    origin: FilterOrigin
    reason: str | None


async def suggest_filter(
    *,
    kind: ProjectKind,
    cluster: ClusterInfo | None,
    source: SourceConfig,
    connector: Connector,
    transport: SourceTransport,
) -> Suggestion:
    """The filter a project of `kind` on `cluster` should use on `source`."""
    if kind != "kubernetes" or cluster is None:
        return Suggestion((), "none", None)
    if source.secrets_unreadable:
        return Suggestion((), "none", CANT_CHECK.format(message=SECRETS_UNREADABLE))
    # Asked side by side, every answer awaited: a failed one never leaves the others running.
    values = await asyncio.gather(
        *(connector.label_values(transport, label, matchers=()) for label in CANDIDATE_LABELS),
        return_exceptions=True,
    )
    for answer in values:
        if isinstance(answer, SourceUnreachable | QueryRejected):
            return Suggestion((), "none", CANT_CHECK.format(message=answer.message))
        if isinstance(answer, BaseException):
            raise answer

    several = False
    for label, found in zip(CANDIDATE_LABELS, values, strict=True):
        if len(set(found)) < 2:
            continue
        several = True
        match = next((n for n in (cluster.name, cluster.context_name) if n in found), None)
        if match is not None:
            return Suggestion((Matcher(label, "=", match),), "auto", KEEPS.format(match=match))
    if source.reach == "cluster" and source.cluster and source.cluster.cluster_id == cluster.id:
        return Suggestion((), "auto", INSIDE)
    if several:
        return Suggestion((), "none", NONE_NAMED.format(cluster=cluster.name))
    return Suggestion((), "none", CANT_TELL)
