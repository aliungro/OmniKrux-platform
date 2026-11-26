"""Projects, their links to sources, groups, and the reviews shown before a delete."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Literal

from omnikrux.monitoring.sources.types import FilterOrigin, ProjectKind

if TYPE_CHECKING:
    from omnikrux.monitoring.alerts.store import RuleRef
    from omnikrux.monitoring.dashboards.store import DashboardRef

REVIEW_CHANGED = "Something changed since the review. Review it again."


class ReviewChanged(Exception):
    """What a delete would do is no longer what the review showed; nothing was changed."""

    def __init__(self) -> None:
        super().__init__(REVIEW_CHANGED)


class RulesInCluster(Exception):
    """The owner has alert rules applied in a cluster: each has to be removed from it first
    (through its own review); nothing was changed."""

    def __init__(self, rules: tuple[RuleRef, ...]) -> None:
        super().__init__(", ".join(r.name for r in rules))
        self.rules = rules


class UnknownProject(KeyError):
    pass


class UnknownGroup(KeyError):
    pass


@dataclass(frozen=True)
class Matcher:
    """One label matcher of a project's filter on a source, as in `{label op "value"}`."""

    label: str
    op: Literal["=", "!=", "=~", "!~"]
    value: str


@dataclass(frozen=True)
class Link:
    project_id: str
    source_id: str
    matchers: tuple[Matcher, ...]
    origin: FilterOrigin
    created_at: datetime


@dataclass(frozen=True)
class Project:
    id: str
    name: str
    kind: ProjectKind
    cluster_id: str | None
    links: tuple[Link, ...]
    group_ids: tuple[str, ...]
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class Group:
    id: str
    name: str
    project_ids: tuple[str, ...]
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class SourceRef:
    id: str
    name: str


@dataclass(frozen=True)
class KeptSource:
    """A source the project created that other projects still use (their names)."""

    id: str
    name: str
    used_by: tuple[str, ...]


@dataclass(frozen=True)
class ProjectRef:
    id: str
    name: str


@dataclass(frozen=True)
class GroupRef:
    id: str
    name: str


@dataclass(frozen=True)
class ToolsStayRef:
    """The monitoring tools OmniKrux installed in the project's cluster: deleting the project
    leaves them installed (uninstalling is its own action)."""

    cluster_id: str
    cluster_name: str
    namespace: str


@dataclass(frozen=True)
class SilenceRef:
    """An OmniKrux silence of the project (`project="{name}"`), by its matchers."""

    id: str
    matchers: str


@dataclass(frozen=True)
class ProjectDeleteReview:
    project_id: str
    name: str
    sources_removed: tuple[SourceRef, ...]  # created by the project, used by no other
    sources_kept: tuple[KeptSource, ...]  # created by the project, used by others
    sources_unlinked: tuple[SourceRef, ...]  # linked, not created by the project
    groups_left: tuple[GroupRef, ...]
    dashboards: tuple[DashboardRef, ...]  # deleted with the project, by title
    token: str
    # The rules of the project and its dashboards: they go with it (Loki ruler rules removed
    # first). By name.
    alert_rules: tuple[RuleRef, ...] = ()
    # Rules with a target of this project still applied in a cluster: they block the delete.
    cluster_rules: tuple[RuleRef, ...] = ()
    # The tools OmniKrux installed in the project's cluster, which stay (None: none there).
    tools_stay: ToolsStayRef | None = None
    # Its OmniKrux silences (equality matcher on its name): they go with it.
    silences: tuple[SilenceRef, ...] = ()


@dataclass(frozen=True)
class GroupDeleteReview:
    group_id: str
    name: str
    dashboards: tuple[DashboardRef, ...]  # deleted with the group, by title
    token: str
    alert_rules: tuple[RuleRef, ...] = ()  # the group's and its dashboards' rules, by name
    cluster_rules: tuple[RuleRef, ...] = ()  # of those, the ones applied in a cluster

    def accepts(self, token: str | None) -> bool:
        """Whether a delete may go ahead with `token`: one that matches, or none at all for a
        group without dashboards and alert rules (nothing to review)."""
        return token == self.token or (
            token is None and not self.dashboards and not self.alert_rules
        )


@dataclass(frozen=True)
class SourceDeleteReview:
    source_id: str
    name: str
    projects: tuple[ProjectRef, ...]
    token: str


def review_token(review_without_token: dict) -> str:
    """A fingerprint of what a review shows: it changes whenever the review would. An empty
    `dashboards`, `alert_rules`, `cluster_rules` or `silences` list, and no `tools_stay`, stay out
    of it, so a review without them keeps the fingerprint it had before owners had dashboards,
    alert rules, installed tools and silences."""
    fields = dict(review_without_token)
    for key in ("dashboards", "alert_rules", "cluster_rules", "tools_stay", "silences"):
        if key in fields and not fields[key]:
            del fields[key]
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()
