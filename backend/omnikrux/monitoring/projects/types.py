"""Projects, their links to sources, groups, and the reviews shown before a delete."""

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from omnikrux.monitoring.sources.types import FilterOrigin, ProjectKind

REVIEW_CHANGED = "Something changed since the review. Review it again."


class ReviewChanged(Exception):
    """What a delete would do is no longer what the review showed; nothing was changed."""

    def __init__(self) -> None:
        super().__init__(REVIEW_CHANGED)


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
class ProjectDeleteReview:
    project_id: str
    name: str
    sources_removed: tuple[SourceRef, ...]  # created by the project, used by no other
    sources_kept: tuple[KeptSource, ...]  # created by the project, used by others
    sources_unlinked: tuple[SourceRef, ...]  # linked, not created by the project
    groups_left: tuple[GroupRef, ...]
    token: str


@dataclass(frozen=True)
class SourceDeleteReview:
    source_id: str
    name: str
    projects: tuple[ProjectRef, ...]
    token: str


def review_token(review_without_token: dict) -> str:
    """A fingerprint of what a review shows: it changes whenever the review would."""
    return hashlib.sha256(json.dumps(review_without_token, sort_keys=True).encode()).hexdigest()
