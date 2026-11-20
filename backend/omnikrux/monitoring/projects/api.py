"""Routes for projects, their links to sources, groups, the sidebar tree, project setup and the
review shown before a project is deleted.

Projects are never created automatically: only `POST /setup` creates one, together with its new
sources and its links, in one transaction. Every change is audited before it is made (no audit,
no change) without a review step; deleting a project asks first, through the review's token.
The rules a request must follow answer 422 with plain words from the handlers (pydantic only
checks the shape)."""

from collections.abc import Iterable, Sequence
from dataclasses import replace
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict

from omnikrux.clusters.registry import ClusterInfo, ClusterRegistry
from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.projects.store import SetupLink
from omnikrux.monitoring.projects.types import (
    REVIEW_CHANGED,
    Group,
    Link,
    Matcher,
    Project,
    ProjectDeleteReview,
    ReviewChanged,
    UnknownGroup,
    UnknownProject,
)
from omnikrux.monitoring.query.filters import FilterError, parse_matchers, render_matchers
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.api import NOT_LINKED, SOURCE_GONE
from omnikrux.monitoring.sources.rules import (
    ONE_SOURCE,
    SourceIn,
    checked_name,
    config_from_in,
    details_of,
    new_source_of,
    refuse,
)
from omnikrux.monitoring.sources.types import (
    FilterOrigin,
    NameTaken,
    ProjectKind,
    SourceConfig,
    SourceType,
)

router = APIRouter()

PROJECT_GONE = "That project doesn't exist anymore. It may have been removed."
GROUP_GONE = "That group doesn't exist anymore. It may have been removed."
CHOSEN_PROJECT_GONE = "One of the chosen projects no longer exists. Reload and pick again."
CHOSEN_SOURCE_GONE = "One of the chosen sources no longer exists. Reload and pick again."
CLUSTER_NEEDED = "Pick a cluster for a Kubernetes project."
SOURCE_TWICE = "Each source can be linked to a project only once."
PROJECT_NOT_SAVED = "The project couldn't be saved. Try again."
PROJECT_NOT_REMOVED = "The project couldn't be removed. Try again."
GROUP_NOT_SAVED = "The group couldn't be saved. Try again."

TreeColor = Literal["aks", "eks", "gke", "oke", "kind", "onprem", "custom"]


# --- Shapes ------------------------------------------------------------------------------------


class LinkOut(BaseModel):
    source_id: str
    source_name: str
    source_type: SourceType
    filter: str
    filter_origin: FilterOrigin
    created_by_project: bool


class ProjectOut(BaseModel):
    id: str
    name: str
    kind: ProjectKind
    cluster_id: str | None
    # None when OmniKrux no longer knows the cluster: the project still opens.
    cluster_name: str | None
    cluster_provider: str | None
    links: list[LinkOut]
    group_ids: list[str]
    created_at: datetime
    updated_at: datetime


class GroupOut(BaseModel):
    id: str
    name: str
    project_ids: list[str]  # in the projects' name order
    created_at: datetime
    updated_at: datetime


class TreeDashboard(BaseModel):
    """Empty in M1; dashboards arrive in M2."""

    id: str
    title: str


class TreeProject(BaseModel):
    id: str
    name: str
    kind: ProjectKind
    cluster_id: str | None
    color: TreeColor
    dashboards: list[TreeDashboard] = []


class TreeGroup(BaseModel):
    id: str
    name: str
    project_ids: list[str]
    dashboards: list[TreeDashboard] = []


class TreeOut(BaseModel):
    projects: list[TreeProject]
    groups: list[TreeGroup]
    source_count: int


class SourceRefOut(BaseModel):
    id: str
    name: str


class KeptSourceOut(BaseModel):
    id: str
    name: str
    used_by: list[str]


class GroupRefOut(BaseModel):
    id: str
    name: str


class ProjectDeleteReviewOut(BaseModel):
    project_id: str
    name: str
    sources_removed: list[SourceRefOut]
    sources_kept: list[KeptSourceOut]
    sources_unlinked: list[SourceRefOut]
    groups_left: list[GroupRefOut]
    token: str


class ProjectPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str


class LinkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filter: str
    origin: FilterOrigin = "user"


class GroupIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    project_ids: list[str]


class GroupPatch(BaseModel):
    """`None` keeps what is stored."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    project_ids: list[str] | None = None


class SetupSourceIn(BaseModel):
    """Exactly one of `source_id` (a saved source) and `source` (a new one)."""

    model_config = ConfigDict(extra="forbid")

    source_id: str | None = None
    source: SourceIn | None = None
    filter: str = ""
    origin: FilterOrigin = "user"


class SetupIn(BaseModel):
    """`cluster_id` is the Kubernetes project's cluster; other kinds have none."""

    model_config = ConfigDict(extra="forbid")

    name: str
    kind: ProjectKind
    cluster_id: str | None = None
    sources: list[SetupSourceIn] = []


# --- Helpers -----------------------------------------------------------------------------------


def _services(request: Request) -> MonitoringServices:
    return request.app.state.monitoring


def _registry(request: Request) -> ClusterRegistry:
    return request.app.state.registry


def _gone(detail: str) -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def _taken(exc: NameTaken) -> HTTPException:
    return HTTPException(status_code=409, detail=str(exc))


def _matchers(text: str) -> tuple[Matcher, ...]:
    try:
        return parse_matchers(text)
    except FilterError as exc:
        raise refuse(str(exc)) from None


async def _project(services: MonitoringServices, id: str) -> Project:
    try:
        return await services.projects.get(id)
    except UnknownProject:
        raise _gone(PROJECT_GONE) from None


async def _group(services: MonitoringServices, id: str) -> Group:
    try:
        return await services.groups.get(id)
    except UnknownGroup:
        raise _gone(GROUP_GONE) from None


async def _source(services: MonitoringServices, id: str) -> SourceConfig:
    try:
        return await services.sources.get(id)
    except KeyError:
        raise _gone(SOURCE_GONE) from None


async def _finish_all(
    request: Request, records: Iterable[int], ok: bool, message: str | None = None
) -> None:
    for record in records:
        await finish_change(request, record, ok, message)


async def _project_names(services: MonitoringServices) -> dict[str, str]:
    return {p.id: p.name for p in await services.projects.list()}


def _chosen(names: dict[str, str], project_ids: Sequence[str]) -> list[str]:
    """The chosen projects' names (each once, in the order chosen); 422 when one is gone."""
    chosen = list(dict.fromkeys(project_ids))
    if any(id not in names for id in chosen):
        raise refuse(CHOSEN_PROJECT_GONE)
    return [names[id] for id in chosen]


def _in_name_order(project_ids: Iterable[str], names: dict[str, str]) -> list[str]:
    return sorted(project_ids, key=lambda id: (names.get(id, "").casefold(), id))


def _link_out(project_id: str, link: Link, source: SourceConfig) -> LinkOut:
    return LinkOut(
        source_id=link.source_id,
        source_name=source.name,
        source_type=source.type,
        filter=render_matchers(link.matchers),
        filter_origin=link.origin,
        created_by_project=source.created_by_project_id == project_id,
    )


async def _project_outs(
    services: MonitoringServices, registry: ClusterRegistry, projects: Sequence[Project]
) -> list[ProjectOut]:
    clusters = {c.id: c for c in await registry.list()}
    sources = {s.id: s for s in await services.sources.list()}
    outs = []
    for p in projects:
        cluster = clusters.get(p.cluster_id) if p.cluster_id else None
        outs.append(
            ProjectOut(
                id=p.id,
                name=p.name,
                kind=p.kind,
                cluster_id=p.cluster_id,
                cluster_name=cluster.name if cluster else None,
                cluster_provider=cluster.provider.value if cluster else None,
                links=[
                    _link_out(p.id, link, sources[link.source_id])
                    for link in p.links
                    if link.source_id in sources
                ],
                group_ids=list(p.group_ids),
                created_at=p.created_at,
                updated_at=p.updated_at,
            )
        )
    return outs


async def _project_out(request: Request, project: Project) -> ProjectOut:
    [out] = await _project_outs(_services(request), _registry(request), [project])
    return out


def _group_out(group: Group, names: dict[str, str]) -> GroupOut:
    return GroupOut(
        id=group.id,
        name=group.name,
        project_ids=_in_name_order(group.project_ids, names),
        created_at=group.created_at,
        updated_at=group.updated_at,
    )


def _color(project: Project, clusters: dict[str, ClusterInfo]) -> TreeColor:
    """The cluster's provider for a Kubernetes project whose cluster is known; `onprem` for
    Docker hosts and servers; `custom` otherwise."""
    cluster = clusters.get(project.cluster_id) if project.cluster_id else None
    if project.kind == "kubernetes" and cluster is not None:
        return cluster.provider.value  # type: ignore[return-value]
    if project.kind in ("docker", "servers"):
        return "onprem"
    return "custom"


def _review_out(review: ProjectDeleteReview) -> ProjectDeleteReviewOut:
    return ProjectDeleteReviewOut(
        project_id=review.project_id,
        name=review.name,
        sources_removed=[SourceRefOut(id=s.id, name=s.name) for s in review.sources_removed],
        sources_kept=[
            KeptSourceOut(id=s.id, name=s.name, used_by=list(s.used_by))
            for s in review.sources_kept
        ],
        sources_unlinked=[SourceRefOut(id=s.id, name=s.name) for s in review.sources_unlinked],
        groups_left=[GroupRefOut(id=g.id, name=g.name) for g in review.groups_left],
        token=review.token,
    )


# --- Tree and projects -------------------------------------------------------------------------


@router.get("/tree")
async def tree(request: Request) -> TreeOut:
    """The sidebar: projects and groups by name (case-insensitive), and how many sources exist."""
    services = _services(request)
    clusters = {c.id: c for c in await _registry(request).list()}
    projects = await services.projects.list()
    names = {p.id: p.name for p in projects}
    return TreeOut(
        projects=[
            TreeProject(
                id=p.id,
                name=p.name,
                kind=p.kind,
                cluster_id=p.cluster_id,
                color=_color(p, clusters),
            )
            for p in projects
        ],
        groups=[
            TreeGroup(id=g.id, name=g.name, project_ids=_in_name_order(g.project_ids, names))
            for g in await services.groups.list()
        ],
        source_count=await services.sources.count(),
    )


@router.get("/projects")
async def list_projects(request: Request) -> list[ProjectOut]:
    services = _services(request)
    return await _project_outs(services, _registry(request), await services.projects.list())


@router.get("/projects/{id}")
async def get_project(id: str, request: Request) -> ProjectOut:
    return await _project_out(request, await _project(_services(request), id))


@router.patch("/projects/{id}")
async def rename_project(id: str, body: ProjectPatch, request: Request) -> ProjectOut:
    services = _services(request)
    project = await _project(services, id)
    name = checked_name(body.name)
    if name == project.name:
        return await _project_out(request, project)
    record = await begin_change(
        request, "project_change", "project", name, {"renamed_from": project.name}
    )
    try:
        renamed = await services.projects.rename(id, name)
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise _taken(exc) from None
    except UnknownProject:
        await finish_change(request, record, False, PROJECT_GONE)
        raise _gone(PROJECT_GONE) from None
    except Exception:
        await finish_change(request, record, False, PROJECT_NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return await _project_out(request, renamed)


@router.put("/projects/{id}/sources/{source_id}")
async def link_source(id: str, source_id: str, body: LinkIn, request: Request) -> LinkOut:
    """Link the source with that filter, or change the filter of an existing link."""
    services = _services(request)
    matchers = _matchers(body.filter)
    project = await _project(services, id)
    source = await _source(services, source_id)
    text = render_matchers(matchers)
    record = await begin_change(
        request, "project_change", "project", project.name, {"linked": source.name, "filter": text}
    )
    try:
        link = await services.projects.link(id, source_id, matchers, body.origin)
    except UnknownProject:
        await finish_change(request, record, False, PROJECT_GONE)
        raise _gone(PROJECT_GONE) from None
    except KeyError:
        await finish_change(request, record, False, SOURCE_GONE)
        raise _gone(SOURCE_GONE) from None
    except Exception:
        await finish_change(request, record, False, PROJECT_NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return _link_out(id, link, source)


@router.delete("/projects/{id}/sources/{source_id}", status_code=204)
async def unlink_source(id: str, source_id: str, request: Request) -> Response:
    """Take the source from the project; the source itself stays."""
    services = _services(request)
    project = await _project(services, id)
    if not any(link.source_id == source_id for link in project.links):
        raise _gone(NOT_LINKED)
    source = await _source(services, source_id)
    record = await begin_change(
        request, "project_change", "project", project.name, {"unlinked": source.name}
    )
    try:
        await services.projects.unlink(id, source_id)
    except KeyError:
        await finish_change(request, record, False, NOT_LINKED)
        raise _gone(NOT_LINKED) from None
    except Exception:
        await finish_change(request, record, False, PROJECT_NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return Response(status_code=204)


@router.get("/projects/{id}/delete-review")
async def project_delete_review(id: str, request: Request) -> ProjectDeleteReviewOut:
    try:
        review = await _services(request).projects.delete_review(id)
    except UnknownProject:
        raise _gone(PROJECT_GONE) from None
    return _review_out(review)


@router.delete("/projects/{id}", status_code=204)
async def remove_project(id: str, token: str, request: Request) -> Response:
    """Delete the project as its review showed: the sources only it created and used, its links
    and its group memberships. 409 (nothing changed) when the review no longer matches."""
    services, registry = _services(request), _registry(request)
    try:
        review = await services.projects.delete_review(id)
    except UnknownProject:
        raise _gone(PROJECT_GONE) from None
    details = {
        "sources_removed": [s.name for s in review.sources_removed],
        "groups_left": [g.name for g in review.groups_left],
    }
    records = [await begin_change(request, "project_remove", "project", review.name, details)]
    try:
        if review.token != token:
            raise ReviewChanged()
        removed = [await services.sources.get(s.id) for s in review.sources_removed]
    except (ReviewChanged, KeyError):
        await _finish_all(request, records, False, REVIEW_CHANGED)
        raise HTTPException(status_code=409, detail=REVIEW_CHANGED) from None
    try:
        # The store deletes exactly what a review with this token shows: these sources.
        for source in removed:
            records.append(
                await begin_change(
                    request,
                    "source_remove",
                    "source",
                    source.name,
                    await details_of(registry, source),
                )
            )
    except HTTPException as exc:
        await _finish_all(request, records, False, str(exc.detail))
        raise
    try:
        await services.projects.delete(id, token, services.sources)
    except ReviewChanged:
        await _finish_all(request, records, False, REVIEW_CHANGED)
        raise HTTPException(status_code=409, detail=REVIEW_CHANGED) from None
    except UnknownProject:
        await _finish_all(request, records, False, PROJECT_GONE)
        raise _gone(PROJECT_GONE) from None
    except Exception:
        await _finish_all(request, records, False, PROJECT_NOT_REMOVED)
        raise
    await _finish_all(request, records, True)
    for source in removed:
        services.health.forget(source.id)
        services.transports.forget(source.id)
    return Response(status_code=204)


# --- Groups ------------------------------------------------------------------------------------


@router.get("/groups")
async def list_groups(request: Request) -> list[GroupOut]:
    services = _services(request)
    names = await _project_names(services)
    return [_group_out(g, names) for g in await services.groups.list()]


@router.post("/groups", status_code=201)
async def add_group(body: GroupIn, request: Request) -> GroupOut:
    services = _services(request)
    name = checked_name(body.name)
    names = await _project_names(services)
    chosen = _chosen(names, body.project_ids)
    record = await begin_change(request, "group_add", "group", name, {"projects": chosen})
    try:
        group = await services.groups.create(name, body.project_ids)
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise _taken(exc) from None
    except UnknownProject:
        await finish_change(request, record, False, CHOSEN_PROJECT_GONE)
        raise refuse(CHOSEN_PROJECT_GONE) from None
    except Exception:
        await finish_change(request, record, False, GROUP_NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return _group_out(group, await _project_names(services))


@router.patch("/groups/{id}")
async def change_group(id: str, body: GroupPatch, request: Request) -> GroupOut:
    """Rename the group and/or replace its projects; the projects themselves never change."""
    services = _services(request)
    group = await _group(services, id)
    names = await _project_names(services)
    name = checked_name(body.name) if body.name is not None else None
    details: dict = {}
    if name is not None and name != group.name:
        details["renamed_from"] = group.name
    if body.project_ids is not None:
        details["projects"] = _chosen(names, body.project_ids)
    if not details:
        return _group_out(group, names)
    record = await begin_change(request, "group_change", "group", name or group.name, details)
    try:
        updated = await services.groups.update(id, name=name, project_ids=body.project_ids)
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise _taken(exc) from None
    except UnknownGroup:
        await finish_change(request, record, False, GROUP_GONE)
        raise _gone(GROUP_GONE) from None
    except UnknownProject:
        await finish_change(request, record, False, CHOSEN_PROJECT_GONE)
        raise refuse(CHOSEN_PROJECT_GONE) from None
    except Exception:
        await finish_change(request, record, False, GROUP_NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return _group_out(updated, await _project_names(services))


@router.delete("/groups/{id}", status_code=204)
async def remove_group(id: str, request: Request) -> Response:
    """Remove the group; its projects stay as they are."""
    services = _services(request)
    group = await _group(services, id)
    names = await _project_names(services)
    projects = [names[p] for p in _in_name_order(group.project_ids, names) if p in names]
    record = await begin_change(
        request, "group_remove", "group", group.name, {"projects": projects}
    )
    try:
        await services.groups.delete(id)
    except UnknownGroup:
        await finish_change(request, record, False, GROUP_GONE)
        raise _gone(GROUP_GONE) from None
    except Exception:
        await finish_change(request, record, False, "The group couldn't be removed. Try again.")
        raise
    await finish_change(request, record, True)
    return Response(status_code=204)


# --- Setup -------------------------------------------------------------------------------------


@router.post("/setup", status_code=201)
async def set_up_project(body: SetupIn, request: Request) -> ProjectOut:
    """Create the project with its new sources and its links, all at once or not at all."""
    services, registry = _services(request), _registry(request)
    name = checked_name(body.name)
    cluster_id = cluster_name = None
    if body.kind == "kubernetes":
        if not body.cluster_id:
            raise refuse(CLUSTER_NEEDED)
        try:
            cluster = await registry.get(body.cluster_id)
        except KeyError:
            raise refuse(CLUSTER_NEEDED) from None
        cluster_id, cluster_name = cluster.id, cluster.name

    # Check every source before anything is audited or stored.
    links: list[SetupLink] = []
    linked: list[str] = []  # every source's name, in the order given
    created: list[tuple[str, dict]] = []  # each new source's name and audit details
    saved_ids: set[str] = set()
    for entry in body.sources:
        if (entry.source_id is None) == (entry.source is None):
            raise refuse(ONE_SOURCE)
        matchers = _matchers(entry.filter)
        if entry.source_id is not None:
            if entry.source_id in saved_ids:
                raise refuse(SOURCE_TWICE)
            saved_ids.add(entry.source_id)
            try:
                saved = await services.sources.get(entry.source_id)
            except KeyError:
                raise refuse(CHOSEN_SOURCE_GONE) from None
            linked.append(saved.name)
            links.append(SetupLink(matchers, entry.origin, source_id=saved.id))
        elif entry.source is not None:
            config = await config_from_in(entry.source, registry)
            if entry.source.name is None:
                unique = await services.sources.unique_name(
                    config.name, also_taken=[n for n, _ in created]
                )
                config = replace(config, name=unique)
            linked.append(config.name)
            created.append((config.name, await details_of(registry, config)))
            links.append(SetupLink(matchers, entry.origin, new=new_source_of(config)))

    details = {
        "kind": body.kind,
        "cluster": cluster_name,
        "sources": linked,
        "created_sources": [n for n, _ in created],
    }
    records = [await begin_change(request, "project_add", "project", name, details)]
    try:
        for source_name, source_details in created:
            records.append(
                await begin_change(request, "source_add", "source", source_name, source_details)
            )
    except HTTPException as exc:
        await _finish_all(request, records, False, str(exc.detail))
        raise
    try:
        project = await services.projects.set_up(
            name, body.kind, cluster_id, links, services.sources
        )
    except NameTaken as exc:
        await _finish_all(request, records, False, str(exc))
        raise _taken(exc) from None
    except KeyError:  # a saved source removed meanwhile
        await _finish_all(request, records, False, CHOSEN_SOURCE_GONE)
        raise refuse(CHOSEN_SOURCE_GONE) from None
    except Exception:
        await _finish_all(request, records, False, PROJECT_NOT_SAVED)
        raise
    await _finish_all(request, records, True)
    return await _project_out(request, project)
