"""Update from source: an imported dashboard re-reads where it came from and, once the user has
reviewed the differences, takes it as a new version.

`GET /dashboards/{id}/origin` says where a dashboard came from (null when it wasn't imported).
`POST /dashboards/{id}/update-from-source/preview` re-reads the source (its Grafana, or the file
picked again), converts it as the import did, maps its sources (the stored mapping, overlaid
with the body's; a reference the import never saw gets its suggestion and is listed), attaches
its alerts, keeps the dashboard's own title and panel ids, and shows the document beside the
current one. Nothing is stored and nothing is audited.

`POST /dashboards/{id}/update-from-source` does the same steps again and writes only when the
source and what it makes here are what was reviewed (`digest`: the source, the incoming document
with its alerts' contact points and source choices, the suggestions and the skipped list) and
the dashboard is still at `base_version`; the save
and the origin's update commit together, and the replaced content stays in Versions.

Each panel alert keeps who it tells, where it runs and how often it is checked (the user's
decision); its definition comes from the source (`merge_alert`). An alert the source dropped
goes: a tool-run one through M4's removal review, which the answer's `alert_changes` carries.
When Grafana's alert rules weren't read this time (a dashboard imported from a Grafana updated
from its file, or rules Grafana didn't send), whether the source still has an alert is unknown,
so each surviving panel keeps its alert as it is, in words."""

import copy
import hashlib
import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import cast

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.monitoring.dashboards.api import DashboardOut, dashboard_out
from omnikrux.monitoring.dashboards.ready_made import parse_ready_id
from omnikrux.monitoring.dashboards.schema import DashboardInvalid, validate_dashboard
from omnikrux.monitoring.dashboards.store import DashboardRecord, UnknownDashboard, VersionConflict
from omnikrux.monitoring.dashboards.writes import (
    DASHBOARD_GONE,
    OWNER_GONE,
    READ_ONLY,
    alert_changes,
    save_dashboard_audited,
    version_conflict,
)
from omnikrux.monitoring.models import now
from omnikrux.monitoring.projects.types import UnknownGroup, UnknownProject
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.types import SourceConfig
from omnikrux.monitoring.transfer.alerts import merge_alert, validate_panel_alert
from omnikrux.monitoring.transfer.api import _Body, _schema, transfer_error
from omnikrux.monitoring.transfer.grafana.convert import convert_grafana
from omnikrux.monitoring.transfer.grafana_client import GrafanaError
from omnikrux.monitoring.transfer.grafana_store import GrafanaConfig, UnknownGrafana
from omnikrux.monitoring.transfer.importing import (
    CHANGED,
    MappingIn,
    SkippedOut,
    TextInput,
    _cluster_names,
    _import_body,
    _panels_gone,
    _problem_text,
    attach_alerts,
    contact_points_by_name,
    mapping_choices,
    read_input,
)
from omnikrux.monitoring.transfer.mapping import SourceRefOut, Target, apply_mapping, suggest
from omnikrux.monitoring.transfer.origins import (
    MappingChoice,
    OriginKind,
    OriginRecord,
    OriginVia,
)
from omnikrux.monitoring.transfer.types import (
    AlertDraft,
    ConvertedDashboard,
    Identity,
    SkippedItem,
    TransferError,
    digest,
)

# --- words ---------------------------------------------------------------------------------

NO_ORIGIN = "This dashboard wasn't imported, so it has no source to update from."
GRAFANA_REMOVED = (
    "The Grafana this came from was removed. Pick the dashboard's file to update from it instead."
)
PICK_FILE = "Pick the file again, or paste its JSON."
NOT_THIS_DASHBOARD = (
    "This file's dashboard isn't the one \"{title}\" was imported from. "
    "Check that it's the right file."
)
NO_MATCH = 'This file has no dashboard that matches "{title}".'
# T8's words for a dashboard that can't be imported, said of the update.
NOT_IMPORTABLE = '"{title}" can\'t be updated from this source: {problem}.'
TITLE_KEPT = 'The source\'s title is "{t}"; this dashboard keeps its own title.'
SOURCE_CHANGED = "The source changed since you reviewed it. Review it again."
NOT_UPDATED = "The update couldn't be saved, so nothing changed. Try again."
PANEL_GONE = (
    'The panel is gone from the source, so its alert "{name}" keeps running as a rule on the '
    "Alerts page."
)
# Not in the plan's list: a panel added here after the import isn't in the source, so the update
# leaves it out (it stays in Versions); its alert, if any, keeps running as a page rule.
LOCAL_PANEL = "It was added here and isn't in the source, so the update leaves it out."
LOCAL_PANEL_ALERT = (
    "It was added here and isn't in the source, so the update leaves it out; its alert "
    '"{name}" keeps running as a rule on the Alerts page.'
)
# Not in the plan's list: the alert's contact points, engine and check interval kept here no
# longer fit the source's alert (M4's check refuses them), so the source's alert is taken as is
# (a Grafana alert names no contact points; an OmniKrux file's may).
ROUTING_RESET = (
    "Where it runs and who it tells here don't fit the source's new alert, so it runs on "
    "OmniKrux's engine and tells no one. Pick them again in the panel's Alert tab."
)
ROUTING_FROM_FILE = (
    "Where it runs and who it tells here don't fit the source's new alert, so it runs on "
    "OmniKrux's engine and tells the contact points the file names. Check them in the panel's "
    "Alert tab."
)
# Not in the plan's list: whether the source still has the alert is unknown (review M1).
RULES_NOT_READ = "Grafana's alert rules weren't read, so the alert here is kept as it is."
RULES_NOT_READ_DROPPED = (
    "Grafana's alert rules weren't read, and the alert here no longer fits the source's panel, "
    "so the update removes it."
)
_RUNS_IN_THE_TOOL = "Runs in the tool"

log = logging.getLogger(__name__)


# --- request and response shapes -------------------------------------------------------------


class OriginOut(BaseModel):
    kind: OriginKind
    via: OriginVia
    label: str
    grafana_id: str | None
    # The saved connection's name while it exists (never its address or sign-in).
    grafana_name: str | None
    grafana_uid: str | None
    grafana_version: int | None
    imported_at: datetime
    imported_version: int
    updated_at: datetime | None
    updated_version: int | None
    # Whether the source can be read again without a file: its Grafana connection still exists.
    can_refetch: bool


class UpdatePreviewIn(_Body):
    input: TextInput | None = None
    mapping: list[MappingIn] = Field(default_factory=list, max_length=500)


class UpdateApplyIn(_Body):
    base_version: int
    digest: str = Field(max_length=64)
    input: TextInput | None = None
    mapping: list[MappingIn] = Field(default_factory=list, max_length=500)


class UpdatePreviewOut(BaseModel):
    current_version: int
    current: dict
    incoming: dict
    same: bool
    skipped: list[SkippedOut]
    new_sources: list[SourceRefOut]
    identity_warning: str | None
    title_note: str | None
    edited_since_import: bool
    source_label: str
    source_version: int | None
    previous_source_version: int | None
    digest: str


# --- the dashboard, its owner and its origin -------------------------------------------------


@dataclass(frozen=True)
class _Imported:
    record: DashboardRecord
    owner: Target
    origin: OriginRecord


async def _owner(services: MonitoringServices, record: DashboardRecord) -> Target:
    try:
        if record.owner_kind == "project":
            project = await services.projects.get(record.owner_id)
            links = tuple(l.source_id for l in project.links)
            return Target("project", project.id, project.name, links)
        group = await services.groups.get(record.owner_id)
        return Target("group", group.id, group.name)
    except (UnknownProject, UnknownGroup):
        raise TransferError(404, "not_found", OWNER_GONE) from None


async def _imported(services: MonitoringServices, id: str) -> _Imported:
    """The dashboard, then its owner, then its origin: an origin is only ever read through a
    dashboard that exists and the owner it belongs to. 409 `read_only` for a ready-made view,
    404 `not_found` or `no_origin`."""
    if parse_ready_id(id) is not None:
        raise TransferError(409, "read_only", READ_ONLY)
    try:
        record = await services.dashboards.get(id)
    except UnknownDashboard:
        raise TransferError(404, "not_found", DASHBOARD_GONE) from None
    owner = await _owner(services, record)
    origin = await services.origins.get(record.id)
    if origin is None:
        raise TransferError(404, "no_origin", NO_ORIGIN)
    return _Imported(record, owner, origin)


async def _connection(services: MonitoringServices, origin: OriginRecord) -> GrafanaConfig | None:
    """The saved Grafana connection the dashboard was imported through, while it exists."""
    if origin.via != "grafana" or origin.grafana_id is None:
        return None
    try:
        return await services.grafana.get(origin.grafana_id)
    except UnknownGrafana:
        return None


# --- reading the source again ----------------------------------------------------------------


@dataclass(frozen=True)
class _Source:
    converted: ConvertedDashboard
    label: str
    identity_warning: str | None
    # Whether every alert the source has was read: False for a dashboard imported from a Grafana
    # when its rules weren't read this time (its file holds none; Grafana didn't send them).
    rules_read: bool = True


def _pick(
    origin: OriginRecord, found: Sequence[ConvertedDashboard], fmt: str, title: str
) -> tuple[ConvertedDashboard, str | None]:
    """The dashboard of the text that this one was imported from, and a warning when it may not
    be: a Grafana origin takes a Grafana dashboard (its uid should be the recorded one); an
    OmniKrux origin takes the dashboard with the recorded export id, else the only one."""
    no_match = TransferError(422, "not_importable", NO_MATCH.format(title=title))
    warning = NOT_THIS_DASHBOARD.format(title=title)
    if origin.kind == "grafana":
        if fmt != "grafana" or len(found) != 1:
            raise no_match
        c = found[0]
        return c, (None if c.identity.ref == origin.grafana_uid else warning)
    if fmt == "grafana":
        raise no_match
    same = [c for c in found if c.identity.ref is not None and c.identity.ref == origin.export_id]
    if same:
        return same[0], None
    if len(found) == 1:
        c = found[0]
        unnamed = origin.export_id is None and c.identity.ref is None  # a bare document
        return c, (None if unnamed else warning)
    raise no_match


async def _read_source(
    services: MonitoringServices,
    registry: ClusterRegistry,
    imported: _Imported,
    input: TextInput | None,
) -> _Source:
    origin, title = imported.origin, imported.record.title
    if input is not None:
        read = await read_input(services, registry, input)
        c, warning = _pick(origin, read.converted, read.format, title)
        # A dashboard's JSON never holds Grafana's alert rules.
        return _Source(c, read.label, warning, rules_read=origin.via != "grafana")
    if origin.via != "grafana":
        raise TransferError(422, "invalid_input", PICK_FILE)
    cfg = await _connection(services, origin)
    if cfg is None or origin.grafana_uid is None:
        raise TransferError(409, "no_origin", GRAFANA_REMOVED)
    uid = origin.grafana_uid
    try:
        # The same reads, and so the same kind of conversion, as the import from this Grafana.
        got, context = await services.grafana_client.context(cfg, uid)
    except GrafanaError as exc:
        raise TransferError(exc.status, "grafana", exc.message) from None
    c = convert_grafana(got.raw, context, key=uid)
    version = got.version if got.version is not None else c.identity.version
    return _Source(
        replace(c, identity=Identity("grafana", uid, version)),
        cfg.name,
        None,
        rules_read=context.alert_rules is not None,
    )


# --- the incoming document -------------------------------------------------------------------


@dataclass(frozen=True)
class _Update:
    imported: _Imported
    source: _Source
    doc: dict
    skipped: list[SkippedItem]
    new_sources: list[SourceRefOut]
    mapping: dict[str, MappingChoice]
    panels: dict[str, str]
    # The source's own content (T1's digest): what the origin keeps.
    source_digest: str

    @property
    def digest(self) -> str:
        """What the reviewer saw: the source (the first half, so a changed source is told apart)
        and what the update makes of it here (the incoming document with its alerts' contact
        points and source choices, the sources suggested, the skipped list)."""
        payload = {
            "doc": self.doc,
            "new_sources": [s.model_dump() for s in self.new_sources],
            "skipped": [[i.where, i.what, i.reason] for i in self.skipped],
        }
        text = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        made = hashlib.sha256(text.encode("utf-8")).hexdigest()
        return self.source_digest[:32] + made[:32]

    @property
    def same(self) -> bool:
        return self.doc == self.imported.record.spec

    @property
    def source_version(self) -> int | None:
        c = self.source.converted
        return c.identity.version if c.identity.kind == "grafana" else None


def _rekey(
    doc: dict,
    panel_sources: Sequence[tuple[str, str]],
    known: Mapping[str, str],
    current: dict,
) -> tuple[dict, dict[str, str], dict[str, str]]:
    """`doc` with panel ids kept stable: a panel whose source identity is in `known` takes its
    id; any other gets the next `p-<n>` the current document and `known` don't use. Answers the
    document, converted id → new id, and the panel map to keep (the known one, updated)."""
    out = copy.deepcopy(doc)
    source_of = dict(panel_sources)
    used = {p["id"] for p in current.get("panels", [])} | set(known.values())
    given: dict[str, str] = {}
    taken: set[str] = set()
    for panel in out["panels"]:
        want = known.get(source_of[panel["id"]]) if panel["id"] in source_of else None
        if want is not None and want not in taken:
            given[panel["id"]] = want
            taken.add(want)
    n = 1
    for panel in out["panels"]:
        if panel["id"] in given:
            continue
        while f"p-{n}" in used or f"p-{n}" in taken:
            n += 1
        given[panel["id"]] = f"p-{n}"
        taken.add(f"p-{n}")
    for panel in out["panels"]:
        panel["id"] = given[panel["id"]]
    panels = dict(known)
    for old, src in source_of.items():
        if old in given:
            panels[src] = given[old]
    return out, given, panels


def _merge_alerts(
    doc: dict,
    current: dict,
    drafts: Mapping[str, AlertDraft],
    items: Sequence[SkippedItem],
    tool_items: Sequence[str] = (),
) -> tuple[dict, list[SkippedItem]]:
    """Each panel's alert as the update leaves it: where the panel has an alert now, it keeps
    who it tells, where it runs and how often it is checked, and takes the rest from the source
    (`merge_alert`), checked again by M4's rules; when the kept part no longer fits, the
    source's alert is taken as it is, in words. `items` are the attach step's; `tool_items`
    names, in order, the panel id of each of its "Runs in the tool" items, and such an item goes
    when that panel's alert stays in the tool."""
    out = copy.deepcopy(doc)
    before = {
        p["id"]: p["alert"] for p in current.get("panels", []) if isinstance(p.get("alert"), dict)
    }
    variables = out.get("variables", [])
    stays_in_tool: set[str] = set()
    more: list[SkippedItem] = []
    for panel in out["panels"]:
        now_alert = before.get(panel["id"])
        incoming = panel.get("alert")
        if now_alert is None or incoming is None:
            continue
        merged = merge_alert(now_alert, incoming, draft=drafts.get(panel["id"]))
        try:
            validate_panel_alert(cast(dict, merged), panel, variables=variables)
        except DashboardInvalid:
            why = ROUTING_FROM_FILE if incoming.get("notify") else ROUTING_RESET
            more.append(SkippedItem(f'Alert "{incoming.get("name")}"', "The rule", why))
            continue
        panel["alert"] = merged
        if cast(dict, merged).get("engine") == "tool":
            stays_in_tool.add(panel["id"])
    kept: list[SkippedItem] = []
    tool_panels = iter(tool_items)
    for item in items:
        if item.what == _RUNS_IN_THE_TOOL and next(tool_panels, None) in stays_in_tool:
            continue
        kept.append(item)
    return out, kept + more


def _keep_unread_alerts(doc: dict, current: dict) -> tuple[dict, list[SkippedItem]]:
    """When the source's alert rules weren't read: each panel that is here now with an alert and
    comes in without one keeps its alert as it is (checked again by M4's rules), in words."""
    out = copy.deepcopy(doc)
    before = {
        p["id"]: p["alert"] for p in current.get("panels", []) if isinstance(p.get("alert"), dict)
    }
    variables = out.get("variables", [])
    items: list[SkippedItem] = []
    for panel in out["panels"]:
        alert = before.get(panel["id"])
        if alert is None or isinstance(panel.get("alert"), dict):
            continue
        where = f'Alert "{alert.get("name", "")}"'
        try:
            validate_panel_alert(copy.deepcopy(alert), panel, variables=variables)
        except DashboardInvalid:
            items.append(SkippedItem(where, "The rule", RULES_NOT_READ_DROPPED))
            continue
        panel["alert"] = copy.deepcopy(alert)
        items.append(SkippedItem(where, "The rule", RULES_NOT_READ))
    return out, items


def _gone_panels(current: dict, incoming: dict, from_source: set[str]) -> list[SkippedItem]:
    """The current panels the update leaves out, in words: a source panel the source no longer
    has, with its alert (M4 keeps its rule on the Alerts page), and every panel added here after
    the import (`from_source`: the ids the source's panels were given)."""
    ids = {p["id"] for p in incoming["panels"]}
    items: list[SkippedItem] = []
    for p in current.get("panels", []):
        if p["id"] in ids:
            continue
        where = f'Panel "{p.get("title", "")}"'
        alert = p.get("alert") if isinstance(p.get("alert"), dict) else None
        name = alert.get("name", "") if alert is not None else ""
        if p["id"] not in from_source:
            why = LOCAL_PANEL if alert is None else LOCAL_PANEL_ALERT.format(name=name)
            items.append(SkippedItem(where, "The whole panel", why))
        elif alert is not None:
            items.append(SkippedItem(where, "Its alert", PANEL_GONE.format(name=name)))
    return items


def _not_importable(title: str, problem) -> TransferError:
    message = NOT_IMPORTABLE.format(title=title, problem=_problem_text(problem))
    return TransferError(422, "not_importable", message)


def _stored_choice_fits(
    choice: MappingChoice | None, kind: str, target: Target, sources: Mapping[str, SourceConfig]
) -> bool:
    """A choice stored at import still holds: left out, the first source of the type, or a
    source of the type the project still links."""
    if choice is None:
        return False
    if choice.leave_out or choice.source_id is None:
        return True
    cfg = sources.get(choice.source_id)
    return (
        target.kind == "project"
        and choice.source_id in target.links
        and cfg is not None
        and cfg.type == kind
    )


async def _prepare(
    services: MonitoringServices,
    registry: ClusterRegistry,
    id: str,
    input: TextInput | None,
    mapping_in: Sequence[MappingIn],
) -> _Update:
    """The update as it would be written, and what the review shows. Nothing is stored."""
    imported = await _imported(services, id)
    record, target, origin = imported.record, imported.owner, imported.origin
    source = await _read_source(services, registry, imported, input)
    c = source.converted
    if c.doc is None:
        raise _not_importable(record.title, c.problems[0])
    current = record.spec

    # The source mapping: the body's choices, then the stored ones while they still hold, then
    # the suggestion for a reference the import never saw (listed for the review).
    configs = {s.id: s for s in await services.sources.list()}
    refs = {r.key: r for r in c.refs}
    given = mapping_choices(mapping_in, target, refs, configs)
    clusters = await _cluster_names(registry)
    mapping: dict[str, MappingChoice] = {}
    new_sources: list[SourceRefOut] = []
    for ref in c.refs:
        stored = origin.mapping.get(ref.key)
        if not _stored_choice_fits(stored, ref.type, target, configs):
            suggested = suggest(ref, target, list(configs.values()), clusters)
            new_sources.append(suggested)
            stored = MappingChoice(suggested.suggestion)
        mapping[ref.key] = given.get(ref.key, cast(MappingChoice, stored))

    names = {ref.key: ref.name for ref in c.refs}
    mapped, map_items = apply_mapping(c.doc, mapping, owner_kind=target.kind, titles=names)
    gone = _panels_gone(c.doc, mapped, map_items)
    contact_points = await contact_points_by_name(services)
    attached, alert_items = attach_alerts(c, mapped, contact_points, panels_gone=gone)
    rekeyed, renamed, panels = _rekey(attached, c.panel_sources, origin.panels, current)
    drafts = {renamed[pid]: d for pid, d in c.alerts if pid in renamed}
    # `import_alert` says "Runs in the tool" once for each alert of the mapped document that runs
    # in the tool, in panel order: these are those panels, by their ids here.
    tool_items = [
        renamed[p["id"]]
        for p in mapped["panels"]
        if isinstance(p.get("alert"), dict) and p["alert"].get("engine") == "tool"
    ]
    merged, alert_items = _merge_alerts(rekeyed, current, drafts, alert_items, tool_items)
    if not source.rules_read:
        merged, unread_items = _keep_unread_alerts(merged, current)
        alert_items = [*alert_items, *unread_items]
    merged["title"] = current["title"]
    try:
        doc = validate_dashboard(merged, owner_kind=target.kind)
    except DashboardInvalid as exc:
        raise _not_importable(record.title, exc.problems[0]) from None
    gone_items = _gone_panels(current, doc, set(origin.panels.values()))
    skipped = [*c.skipped, *map_items, *alert_items, *gone_items]
    return _Update(
        imported=imported,
        source=source,
        doc=doc,
        skipped=skipped,
        new_sources=new_sources,
        mapping=dict(origin.mapping) | mapping,
        panels=panels,
        source_digest=digest(c),
    )


def _preview_out(u: _Update) -> UpdatePreviewOut:
    record, origin, c = u.imported.record, u.imported.origin, u.source.converted
    since = (
        origin.updated_version if origin.updated_version is not None else origin.imported_version
    )
    title = c.title
    return UpdatePreviewOut(
        current_version=record.version,
        current=record.spec,
        incoming=u.doc,
        same=u.same,
        skipped=[SkippedOut(where=s.where, what=s.what, reason=s.reason) for s in u.skipped],
        new_sources=u.new_sources,
        identity_warning=u.source.identity_warning,
        title_note=TITLE_KEPT.format(t=title) if title != record.spec["title"] else None,
        edited_since_import=record.version > since,
        source_label=u.source.label,
        source_version=u.source_version,
        previous_source_version=origin.grafana_version,
        digest=u.digest,
    )


# --- routes ------------------------------------------------------------------------------------

router = APIRouter()


def _services(request: Request) -> MonitoringServices:
    return cast(MonitoringServices, request.app.state.monitoring)


@router.get("/dashboards/{id}/origin")
async def dashboard_origin(id: str, request: Request) -> OriginOut | None:
    """Where the dashboard came from; null when it wasn't imported."""
    services = _services(request)
    try:
        imported = await _imported(services, id)
    except TransferError as exc:
        if exc.code in ("no_origin", "read_only"):
            return None
        raise transfer_error(exc) from None
    origin = imported.origin
    cfg = await _connection(services, origin)
    return OriginOut(
        kind=origin.kind,
        via=origin.via,
        label=origin.label,
        grafana_id=origin.grafana_id,
        grafana_name=cfg.name if cfg is not None else None,
        grafana_uid=origin.grafana_uid,
        grafana_version=origin.grafana_version,
        imported_at=origin.imported_at,
        imported_version=origin.imported_version,
        updated_at=origin.updated_at,
        updated_version=origin.updated_version,
        can_refetch=cfg is not None,
    )


@router.post("/dashboards/{id}/update-from-source/preview", openapi_extra=_schema(UpdatePreviewIn))
async def update_preview(id: str, request: Request) -> UpdatePreviewOut:
    """The source as it is now beside the dashboard; nothing is stored and nothing is audited."""
    body = await _import_body(request, UpdatePreviewIn)
    try:
        u = await _prepare(
            _services(request), request.app.state.registry, id, body.input, body.mapping
        )
    except TransferError as exc:
        raise transfer_error(exc) from None
    return _preview_out(u)


@router.post("/dashboards/{id}/update-from-source", openapi_extra=_schema(UpdateApplyIn))
async def update_from_source(id: str, request: Request) -> DashboardOut:
    """Take the source as the next version, when it is what was reviewed and the dashboard is
    still at `base_version`; unchanged (no version, no audit) when they are the same."""
    body = await _import_body(request, UpdateApplyIn)
    services = _services(request)
    try:
        u = await _prepare(services, request.app.state.registry, id, body.input, body.mapping)
        if body.digest[:32] != u.digest[:32]:
            raise TransferError(409, "source_changed", SOURCE_CHANGED)
    except TransferError as exc:
        raise transfer_error(exc) from None
    record, owner, origin = u.imported.record, u.imported.owner, u.imported.origin
    if body.base_version != record.version:
        raise version_conflict(VersionConflict(record.version))
    if body.digest != u.digest:
        # The source is as reviewed, but what it makes here isn't: a contact point, a source
        # choice or a suggestion changed meanwhile.
        raise transfer_error(TransferError(409, "changed", CHANGED.format(title=record.title)))
    if u.same:
        return dashboard_out(record, owner.name)
    base = record.version
    details = {
        "from": u.source.label,
        "version": base + 1,
        "previous_version": base,
        "skipped": len(u.skipped),
    } | alert_changes(record.spec, u.doc)
    source_version = u.source_version if origin.kind == "grafana" else origin.grafana_version

    async def along(session: AsyncSession, saved: DashboardRecord) -> None:
        await services.origins.mark_updated(
            saved.id,
            version=saved.version,
            digest=u.source_digest,
            grafana_version=source_version,
            mapping=u.mapping,
            now=now(),
            panels=u.panels,
            session=session,
        )

    try:
        saved, changes = await save_dashboard_audited(
            request,
            record.id,
            base_version=base,
            spec=u.doc,
            origin="updated",
            copied_from=u.source.label,
            action="dashboard_update",
            details=details,
            along=along,
        )
    except HTTPException:  # the write path's own refusals, in its words
        raise
    except Exception as exc:  # noqa: BLE001 - answered in words; nothing was saved
        log.warning("An update from source couldn't be saved (%s)", type(exc).__name__)
        raise transfer_error(TransferError(500, "not_updated", NOT_UPDATED)) from None
    return dashboard_out(saved, owner.name, changes)
