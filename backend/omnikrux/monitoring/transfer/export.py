"""Exporting a dashboard, a project or a group as an OmniKrux export file.

The file names sources by keys (`src-1`, `src-2`…), never by this instance's ids: every source id
inside an exported document becomes its key, or null when the export doesn't carry that source.
A source is described by its type, name, address or cluster service, path prefix, auth type and
custom header names only: never a password, token, API key, client key, certificate, header
value, user name or internal cluster id. A panel alert names its contact points by name only.

An API-key source's header name is left out too (the reader has no place for it): an import
asks for the header with the key."""

import copy
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.monitoring.dashboards.ready_made import (
    build_ready_made,
    parse_ready_id,
    project_ready_keys,
)
from omnikrux.monitoring.dashboards.schema import OwnerKind
from omnikrux.monitoring.dashboards.store import DashboardRecord, UnknownDashboard
from omnikrux.monitoring.projects.types import Project, UnknownGroup, UnknownProject
from omnikrux.monitoring.query.filters import render_matchers
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.types import SourceConfig
from omnikrux.monitoring.transfer.alerts import count_alerts, export_alert
from omnikrux.monitoring.transfer.envelope import (
    MAX_EXPORT_DASHBOARDS,
    ExportKind,
    envelope,
    source_entry,
)
from omnikrux.monitoring.transfer.types import TransferError

EXPORT_GONE = "That dashboard, project or group no longer exists."
NOTHING_TO_EXPORT = "{name} has no dashboards to export. Add a dashboard first."
TOO_MANY_TO_EXPORT = (
    "An export holds at most 200 dashboards, and {name} has {count}. "
    "Export its dashboards one at a time."
)

_SLUG_LENGTH = 60
_SUFFIX = {
    "dashboard": ".omnikrux.json",
    "project": "-project.omnikrux.json",
    "group": "-group.omnikrux.json",
}


@dataclass(frozen=True)
class ExportCounts:
    dashboards: int
    sources: int
    alerts: int


def export_file_name(kind: ExportKind, name: str) -> str:
    """The file's name: the name in lower case with every run of other characters than a-z and
    0-9 as one `-`, trimmed of `-`, at most 60 characters (`dashboard` when nothing is left),
    then the kind; a name that already ends with the kind doesn't take it twice."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:_SLUG_LENGTH].strip("-")
    slug = slug or "dashboard"
    if kind != "dashboard" and (slug == kind or slug.endswith(f"-{kind}")):
        return f"{slug}{_SUFFIX['dashboard']}"
    return f"{slug}{_SUFFIX[kind]}"


def _gone() -> TransferError:
    return TransferError(404, "not_found", EXPORT_GONE)


# --- Reading what is exported ------------------------------------------------------------------


@dataclass
class _Reader:
    """What one export reads, each once."""

    services: MonitoringServices
    registry: ClusterRegistry
    _configs: dict[str, SourceConfig] | None = None
    _cluster_names: dict[str, str | None] | None = None
    _contact_points: dict[str, str] | None = None

    async def configs(self) -> dict[str, SourceConfig]:
        if self._configs is None:
            self._configs = {c.id: c for c in await self.services.sources.list()}
        return self._configs

    async def cluster_name(self, cluster_id: str | None) -> str | None:
        """The cluster's name; None when there is none or OmniKrux no longer knows it."""
        if cluster_id is None:
            return None
        if self._cluster_names is None:
            self._cluster_names = {}
        if cluster_id not in self._cluster_names:
            try:
                self._cluster_names[cluster_id] = (await self.registry.get(cluster_id)).name
            except KeyError:
                self._cluster_names[cluster_id] = None
        return self._cluster_names[cluster_id]

    async def contact_point_names(self) -> dict[str, str]:
        """Contact point id → name (never their settings)."""
        if self._contact_points is None:
            self._contact_points = {
                cp.id: cp.name for cp in await self.services.contact_points.list()
            }
        return self._contact_points

    async def source_entry(self, cfg: SourceConfig, key: str, filter: str | None = None) -> dict:
        cluster = cfg.cluster.cluster_id if cfg.reach == "cluster" and cfg.cluster else None
        return source_entry(cfg, key, await self.cluster_name(cluster), filter)


async def _project(services: MonitoringServices, id: str) -> Project:
    try:
        return await services.projects.get(id)
    except UnknownProject:
        raise _gone() from None


def _first_of_type(project: Project, configs: Mapping[str, SourceConfig], type: str):
    """The project's first linked source of `type` that still exists (what a null id reads)."""
    for link in project.links:
        cfg = configs.get(link.source_id)
        if cfg is not None and cfg.type == type:
            return cfg
    return None


def _document_sources(doc: dict) -> Iterable[dict]:
    """Every source object the document names, variables first, then panel queries."""
    for variable in doc.get("variables", []):
        yield variable["source"]
    for panel in doc.get("panels", []):
        for query in panel.get("queries", []):
            yield query["source"]


def _keeps_notify(
    alert: dict, panel: dict, projects: list[Project], configs: Mapping[str, SourceConfig]
) -> bool:
    """Whether an alert's contact points go into the file (M5's rule for alerts run in a tool):
    an alert on OmniKrux's engine always keeps them; one run in a tool only when a source it runs
    against was installed by OmniKrux (a user's own tool notifies through its channel, and its
    `notify` may hold ids it never used)."""
    if alert.get("engine") != "tool":
        return True
    query = next((q for q in panel.get("queries", []) if q.get("ref") == alert.get("query")), None)
    if query is None:
        return False
    source = query["source"]
    for project in projects:
        if source.get("id") is not None:
            cfg = configs.get(source["id"])
        else:
            cfg = _first_of_type(project, configs, source.get("type"))
        if cfg is not None and cfg.installed_by_omnikrux:
            return True
    return False


async def _exported_doc(
    reader: _Reader,
    doc: dict,
    keys: Mapping[str, str],
    projects: list[Project],
) -> dict:
    """The document as the file carries it: source ids as keys (null when not in `keys`), each
    panel alert through `export_alert`."""
    out = copy.deepcopy(doc)
    configs = await reader.configs()
    for panel in out.get("panels", []):
        alert = panel.get("alert")
        if isinstance(alert, dict):
            keep = _keeps_notify(alert, panel, projects, configs)
            names = await reader.contact_point_names() if keep and alert.get("notify") else {}
            panel["alert"] = export_alert(alert, contact_point_names=names)
    for source in _document_sources(out):
        if source.get("id") is not None:
            source["id"] = keys.get(source["id"])
    return out


def _entry(export_id: str, owner_kind: OwnerKind, version: int, doc: dict) -> dict:
    return {"exportId": export_id, "owner": owner_kind, "version": version, "dashboard": doc}


def _check_count(name: str, count: int) -> None:
    if count == 0:
        raise TransferError(422, "not_importable", NOTHING_TO_EXPORT.format(name=name))
    if count > MAX_EXPORT_DASHBOARDS:
        raise TransferError(
            422, "not_importable", TOO_MANY_TO_EXPORT.format(name=name, count=count)
        )


async def _owned(services: MonitoringServices, kind: OwnerKind, id: str) -> list[DashboardRecord]:
    """The owner's saved dashboards by title (one deleted meanwhile is left out)."""
    found = []
    for summary in await services.dashboards.list(kind, id):
        try:
            found.append(await services.dashboards.get(summary.id))
        except UnknownDashboard:
            continue
    return found


# --- The three kinds ---------------------------------------------------------------------------


async def _dashboard_export(reader: _Reader, id: str, now: datetime) -> tuple[str, dict, int]:
    services = reader.services
    configs = await reader.configs()
    ready = parse_ready_id(id)
    if ready is not None:
        project = await _project(services, ready[0])
        types = {
            link.source_id: configs[link.source_id].type
            for link in project.links
            if link.source_id in configs
        }
        if ready[1] not in project_ready_keys(project, types):
            raise _gone()
        doc = build_ready_made(ready[1], kind=project.kind, has_loki="loki" in types.values())
        owner_kind: OwnerKind = "project"
        owner_name, version, projects = project.name, 0, [project]
    else:
        try:
            record = await services.dashboards.get(id)
        except UnknownDashboard:
            raise _gone() from None
        doc, owner_kind, version = record.spec, record.owner_kind, record.version
        if owner_kind == "project":
            project = await _project(services, record.owner_id)
            owner_name, projects = project.name, [project]
        else:
            try:
                group = await services.groups.get(record.owner_id)
            except UnknownGroup:
                raise _gone() from None
            owner_name, projects = group.name, await _members(services, group.project_ids)
    # The sources its queries name, in first-use order: only a project's own linked ones.
    sources: list[dict] = []
    keys: dict[str, str] = {}
    if owner_kind == "project":
        links = {link.source_id: link for link in projects[0].links}
        for source in _document_sources(doc):
            sid = source.get("id")
            if sid is None or sid in keys or sid not in links or sid not in configs:
                continue
            keys[sid] = f"src-{len(keys) + 1}"
            text = render_matchers(links[sid].matchers)
            sources.append(await reader.source_entry(configs[sid], keys[sid], text))
    exported = await _exported_doc(reader, doc, keys, projects)
    out = envelope(
        "dashboard",
        owner_kind=owner_kind,
        owner_name=owner_name,
        sources=sources,
        dashboards=[_entry(id, owner_kind, version, exported)],
        now=now,
    )
    return doc["title"], out, count_alerts(exported)


async def _project_export(reader: _Reader, id: str, now: datetime) -> tuple[str, dict, int]:
    services = reader.services
    project = await _project(services, id)
    configs = await reader.configs()
    sources: list[dict] = []
    links: list[dict] = []
    keys: dict[str, str] = {}
    for link in project.links:
        cfg = configs.get(link.source_id)
        if cfg is None:
            continue
        keys[cfg.id] = f"src-{len(keys) + 1}"
        sources.append(await reader.source_entry(cfg, keys[cfg.id]))
        links.append({"source": keys[cfg.id], "filter": render_matchers(link.matchers)})
    records = await _owned(services, "project", project.id)
    _check_count(project.name, len(records))
    dashboards = []
    alerts = 0
    for record in records:
        exported = await _exported_doc(reader, record.spec, keys, [project])
        alerts += count_alerts(exported)
        dashboards.append(_entry(record.id, "project", record.version, exported))
    section = {
        "name": project.name,
        "kind": project.kind,
        "cluster": await reader.cluster_name(project.cluster_id),
        "links": links,
    }
    out = envelope(
        "project",
        owner_kind="project",
        owner_name=project.name,
        sources=sources,
        dashboards=dashboards,
        project=section,
        now=now,
    )
    return project.name, out, alerts


async def _members(services: MonitoringServices, ids: Iterable[str]) -> list[Project]:
    found = []
    for pid in ids:
        try:
            found.append(await services.projects.get(pid))
        except UnknownProject:
            continue
    return found


async def _group_export(reader: _Reader, id: str, now: datetime) -> tuple[str, dict, int]:
    services = reader.services
    try:
        group = await services.groups.get(id)
    except UnknownGroup:
        raise _gone() from None
    members = await _members(services, group.project_ids)
    records = await _owned(services, "group", group.id)
    _check_count(group.name, len(records))
    dashboards = []
    alerts = 0
    for record in records:
        exported = await _exported_doc(reader, record.spec, {}, members)
        alerts += count_alerts(exported)
        dashboards.append(_entry(record.id, "group", record.version, exported))
    names = sorted((p.name for p in members), key=lambda n: (n.casefold(), n))
    out = envelope(
        "group",
        owner_kind="group",
        owner_name=group.name,
        sources=[],
        dashboards=dashboards,
        group={"name": group.name, "projects": names},
        now=now,
    )
    return group.name, out, alerts


async def build_export(
    services: MonitoringServices,
    registry: ClusterRegistry,
    kind: ExportKind,
    id: str,
    *,
    now: datetime,
) -> tuple[str, dict, ExportCounts]:
    """(file name, export file, counts) for the dashboard (saved, or a ready-made view), project
    or group `id`. 404 `not_found` when it is gone; 422 `not_importable` when a project or group
    has no dashboards or more than an export holds."""
    reader = _Reader(services, registry)
    build = {"dashboard": _dashboard_export, "project": _project_export, "group": _group_export}
    name, out, alerts = await build[kind](reader, id, now)
    counts = ExportCounts(
        dashboards=len(out["dashboards"]), sources=len(out["sources"]), alerts=alerts
    )
    return export_file_name(kind, name), out, counts
