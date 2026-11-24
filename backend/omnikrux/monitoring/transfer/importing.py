"""Importing dashboards: from an OmniKrux export, a bare OmniKrux document, a Grafana dashboard
file or a Grafana instance.

`POST /import/preview` reads the input and shows what an import would do: each dashboard with
what it skips, its alerts and problems, a digest of what was shown, and the source references
with a suggested source for each. Nothing is stored and nothing is audited.

`POST /import/commit` reads the input again and checks everything before it writes anything:
each chosen dashboard is still importable and unchanged since its preview (the digest), the
target exists and takes this kind of export, every mapped source is linked to the target
project, each document is valid for its owner once mapped and its alerts attached, and the
titles are free. Then every write is audited first (a new group, a new Grafana connection, each
dashboard) and the writes go in one transaction: the dashboards are all imported, or none is.
Audit records never hold a document, a query, a secret or a file's content."""

import asyncio
import copy
import hashlib
import json
import logging
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Annotated, Literal, cast

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.monitoring.alerts.sync import AlertChangeOut
from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.dashboards.schema import (
    DashboardInvalid,
    OwnerKind,
    Problem,
    panel_count,
    validate_dashboard,
)
from omnikrux.monitoring.dashboards.store import MAX_TITLE
from omnikrux.monitoring.dashboards.writes import reconcile_alerts
from omnikrux.monitoring.models import GrafanaRow, lock_first, now
from omnikrux.monitoring.projects.api import CHOSEN_PROJECT_GONE, new_group_checked
from omnikrux.monitoring.projects.types import UnknownGroup, UnknownProject
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.types import NameTaken, ProjectKind, SourceConfig
from omnikrux.monitoring.transfer.alerts import alert_from_draft, import_alert
from omnikrux.monitoring.transfer.api import (
    GRAFANA_GONE,
    GrafanaIn,
    _Body,
    _details,
    _schema,
    grafana_config_from_in,
    read_body,
    transfer_error,
)
from omnikrux.monitoring.transfer.detect import (
    MAX_IMPORT_BYTES,
    TOO_LARGE,
    detect_format,
    parse_import_text,
)
from omnikrux.monitoring.transfer.envelope import EnvelopeRead, read_envelope
from omnikrux.monitoring.transfer.grafana.convert import convert_grafana
from omnikrux.monitoring.transfer.grafana.datasources import GrafanaContext
from omnikrux.monitoring.transfer.grafana_client import GrafanaError
from omnikrux.monitoring.transfer.grafana_store import (
    KIND as GRAFANA_KIND,
)
from omnikrux.monitoring.transfer.grafana_store import (
    GrafanaConfig,
    NewGrafana,
    UnknownGrafana,
)
from omnikrux.monitoring.transfer.mapping import (
    TYPE_LABELS,
    SourceRefOut,
    Target,
    apply_mapping,
    ref_detail,
    suggest,
)
from omnikrux.monitoring.transfer.origins import MappingChoice, OriginRecord, OriginVia
from omnikrux.monitoring.transfer.types import (
    ConvertedDashboard,
    ExportedCluster,
    Identity,
    SkippedItem,
    SourceRefFound,
    TransferError,
    digest,
)

# --- words ---------------------------------------------------------------------------------

WRONG_TARGET = "A project export goes into a project, and a group export into a group."
TARGET_GONE = "That project or group no longer exists. Pick another."
NOT_IMPORTABLE = '"{title}" can\'t be imported: {problem}.'
CHANGED = '"{title}" changed since you checked it. Check again.'
UNLINKED_SOURCE = '"{source}" isn\'t linked to {project}. Pick one of its sources.'
# Not in the plan's list: refusals of a body that names its parts wrongly, and of a source of
# the other type.
ONE_GRAFANA = "Choose one Grafana: a saved connection or a new one."
ONE_PLACE = "Choose where the dashboards go: a project or group, or a new group."
ONCE_EACH = "Each dashboard can be imported only once at a time."
WRONG_TYPE = '"{source}" is a {has} source, and these queries need a {needs} one. Pick another.'
NOT_IMPORTED = "The import couldn't be saved, so nothing was imported. Try again."

log = logging.getLogger(__name__)

FILE_LABEL = "a file"
PASTE_LABEL = "pasted JSON"
GRAFANA_READS = 4  # dashboards read from a Grafana at a time

FormatName = Literal[
    "omnikrux_dashboard", "omnikrux_project", "omnikrux_group", "grafana", "grafana_instance"
]


def _dashboards_word(n: int) -> str:
    return "1 dashboard" if n == 1 else f"{n} dashboards"


# --- request and response shapes -------------------------------------------------------------


class TextInput(_Body):
    """A file's text or pasted text. Its size is checked as it is read (413 over 10 MB)."""

    kind: Literal["text"]
    text: str
    file_name: str | None = Field(None, max_length=255)
    via: Literal["file", "paste"]


class GrafanaInput(_Body):
    """Dashboards of a Grafana: a saved connection (`grafana_id`) or one as entered."""

    kind: Literal["grafana"]
    grafana_id: str | None = Field(None, max_length=200)
    connection: GrafanaIn | None = None
    uids: list[Annotated[str, Field(max_length=200)]] = Field(min_length=1, max_length=100)


ImportInput = Annotated[TextInput | GrafanaInput, Field(discriminator="kind")]


class TargetIn(_Body):
    kind: OwnerKind
    id: str = Field(max_length=200)


class NewGroupIn(_Body):
    name: str = Field(max_length=200)
    project_ids: list[Annotated[str, Field(max_length=200)]] = Field(max_length=500)


class ImportPreviewIn(_Body):
    input: ImportInput
    target: TargetIn | None = None


class MappingIn(_Body):
    key: str = Field(max_length=300)
    source_id: str | None = Field(None, max_length=200)
    leave_out: bool = False


class CommitDashboardIn(_Body):
    key: str = Field(max_length=300)
    title: str = Field(max_length=500)
    digest: str = Field(max_length=64)


class ImportCommitIn(_Body):
    input: ImportInput
    target: TargetIn | None = None
    new_group: NewGroupIn | None = None
    mapping: list[MappingIn] = Field(default_factory=list, max_length=500)
    dashboards: list[CommitDashboardIn] = Field(min_length=1, max_length=200)


class SkippedOut(BaseModel):
    where: str
    what: str
    reason: str


class ProblemOut(BaseModel):
    path: str
    message: str


class BundleSourceOut(BaseModel):
    key: str
    name: str
    type: Literal["prometheus", "loki"]
    where: str
    filter: str | None
    auth: str


class BundleInfoOut(BaseModel):
    kind: Literal["project", "group"]
    name: str
    project_kind: ProjectKind | None
    cluster: str | None
    sources: list[BundleSourceOut]
    projects: list[str]


class PreviewDashboardOut(BaseModel):
    key: str
    title: str
    suggested_title: str
    title_taken: bool
    panels: int
    alerts: int
    skipped: list[SkippedOut]
    problems: list[ProblemOut]
    importable: bool
    digest: str


class TargetOut(BaseModel):
    kind: OwnerKind
    id: str


class ImportPreviewOut(BaseModel):
    format: FormatName
    format_label: str
    target_kinds: list[OwnerKind]
    suggested_target: TargetOut | None
    bundle: BundleInfoOut | None
    sources: list[SourceRefOut]
    dashboards: list[PreviewDashboardOut]
    skipped_total: int


class ImportedOut(BaseModel):
    key: str
    id: str
    title: str
    owner_kind: OwnerKind
    owner_id: str


class ImportResultOut(BaseModel):
    dashboards: list[ImportedOut]
    group_id: str | None
    grafana_id: str | None
    warnings: list[str]
    alert_changes: list[AlertChangeOut]


# --- reading the input -----------------------------------------------------------------------


@dataclass(frozen=True)
class ReadResult:
    format: FormatName
    format_label: str
    converted: list[ConvertedDashboard]
    bundle: EnvelopeRead | None
    grafana: GrafanaConfig | None
    via: OriginVia = "file"
    label: str = FILE_LABEL
    # The kinds of owner the dashboards may go into.
    target_kinds: tuple[OwnerKind, ...] = ("project", "group")


def _text_label(input: TextInput) -> tuple[OriginVia, str]:
    if input.via == "paste":
        return "paste", PASTE_LABEL
    return "file", input.file_name or FILE_LABEL


def _doc_sources(doc: dict):
    for v in doc.get("variables", []):
        yield v["source"]
    for panel in doc.get("panels", []):
        for q in panel.get("queries", []):
            yield q["source"]


def _used_refs(doc: dict | None, refs: Sequence[SourceRefFound]) -> tuple[SourceRefFound, ...]:
    """The references the document reads, in first-use order."""
    if doc is None:
        return ()
    by_key = {r.key: r for r in refs}
    used: list[SourceRefFound] = []
    for source in _doc_sources(doc):
        ref = by_key.get(source.get("id"))
        if ref is not None and ref not in used:
            used.append(ref)
    return tuple(used)


def _panel_ids(doc: dict | None) -> tuple[tuple[str, str], ...]:
    return tuple((p["id"], p["id"]) for p in doc.get("panels", [])) if doc else ()


def _from_envelope(read: EnvelopeRead) -> list[ConvertedDashboard]:
    out = []
    for d in read.dashboards:
        out.append(
            ConvertedDashboard(
                key=d.key,
                title=d.title,
                doc=d.doc,
                refs=_used_refs(d.doc, read.sources),
                skipped=read.skipped_by_key.get(d.key, ()),
                alerts=(),
                problems=d.problems,
                identity=Identity("omnikrux", d.export_id, None),
                panel_sources=_panel_ids(d.doc),
            )
        )
    return out


async def _cluster_names(registry: ClusterRegistry) -> dict[str, str]:
    return {c.id: c.name for c in await registry.list()}


def _bare_ref(
    key: str, sid: str, kind: str, cfg: SourceConfig | None, clusters: Mapping[str, str]
) -> SourceRefFound:
    if cfg is None:
        return SourceRefFound(key, kind, False, sid, None, None)  # type: ignore[arg-type]
    cluster = None
    if cfg.reach == "cluster" and cfg.cluster is not None:
        c = cfg.cluster
        cluster = ExportedCluster(
            clusters.get(c.cluster_id), c.namespace, c.service, c.port, c.scheme
        )
    return SourceRefFound(
        key=key,
        type=kind,  # type: ignore[arg-type]
        type_guessed=False,
        name=cfg.name,
        url=cfg.url if cfg.reach == "url" else None,
        cluster=cluster,
        path_prefix=cfg.path_prefix,
        auth=cfg.auth_type,
    )


async def _from_bare(
    services: MonitoringServices, registry: ClusterRegistry, value: dict, key: str
) -> ConvertedDashboard:
    """A bare OmniKrux document (from the JSON editor or the API). Each source id it names
    becomes the reference `id:<id>`, described by that source when it is one of this
    OmniKrux's; contact point ids this OmniKrux knows are named, so the import maps them back."""
    try:
        doc = validate_dashboard(value, owner_kind="project")
    except DashboardInvalid as exc:
        title = value.get("title") if isinstance(value.get("title"), str) else ""
        return ConvertedDashboard(
            key=key,
            title=title,
            doc=None,
            refs=(),
            skipped=(),
            alerts=(),
            problems=exc.problems,
            identity=Identity("omnikrux", None, None),
        )
    configs = {c.id: c for c in await services.sources.list()}
    clusters = await _cluster_names(registry)
    refs: dict[str, SourceRefFound] = {}
    for source in _doc_sources(doc):
        sid = source["id"]
        if sid is None:
            continue
        ref_key = f"id:{sid}"
        if ref_key not in refs:
            refs[ref_key] = _bare_ref(ref_key, sid, source["type"], configs.get(sid), clusters)
        source["id"] = ref_key
    names: dict[str, str] | None = None
    for panel in doc["panels"]:
        alert = panel.get("alert")
        if isinstance(alert, dict) and alert.get("notify"):
            if names is None:
                names = {cp.id: cp.name for cp in await services.contact_points.list()}
            alert["notify"] = [{"name": names[i]} if i in names else i for i in alert["notify"]]
    return ConvertedDashboard(
        key=key,
        title=doc["title"],
        doc=doc,
        refs=tuple(refs.values()),
        skipped=(),
        alerts=(),
        problems=(),
        identity=Identity("omnikrux", None, None),
        panel_sources=_panel_ids(doc),
    )


def _envelope_format(read: EnvelopeRead) -> tuple[FormatName, str, tuple[OwnerKind, ...]]:
    n = _dashboards_word(len(read.dashboards))
    if read.kind == "project":
        label = f"OmniKrux project export: {read.owner_name} · {n}"
        return "omnikrux_project", label, ("project",)
    if read.kind == "group":
        return "omnikrux_group", f"OmniKrux group export: {read.owner_name} · {n}", ("group",)
    return "omnikrux_dashboard", "OmniKrux dashboard", ("project", "group")


async def _read_text(
    services: MonitoringServices, registry: ClusterRegistry, input: TextInput
) -> ReadResult:
    via, label = _text_label(input)
    found, value = detect_format(parse_import_text(input.text))
    if found == "omnikrux_export":
        read = read_envelope(cast(dict, value))
        fmt, fmt_label, kinds = _envelope_format(read)
        return ReadResult(
            fmt, fmt_label, _from_envelope(read), read, None, via, label, target_kinds=kinds
        )
    if found == "omnikrux_dashboard":
        converted = await _from_bare(services, registry, cast(dict, value), "d-1")
        return ReadResult(
            "omnikrux_dashboard", "OmniKrux dashboard", [converted], None, None, via, label
        )
    converted = convert_grafana(value, GrafanaContext(), key="d-1")
    return ReadResult("grafana", "Grafana dashboard", [converted], None, None, via, label)


def _failed(uid: str, message: str) -> ConvertedDashboard:
    return ConvertedDashboard(
        key=uid,
        title=uid,
        doc=None,
        refs=(),
        skipped=(),
        alerts=(),
        problems=(Problem("", message),),
        identity=Identity("grafana", uid, None),
    )


async def grafana_config(
    services: MonitoringServices, registry: ClusterRegistry, input: GrafanaInput
) -> GrafanaConfig:
    """The connection the input names: a saved one (404 when it is gone) or one as entered."""
    if (input.grafana_id is None) == (input.connection is None):
        raise TransferError(422, "invalid_input", ONE_GRAFANA)
    if input.grafana_id is not None:
        try:
            return await services.grafana.get(input.grafana_id)
        except UnknownGrafana:
            raise TransferError(404, "not_found", GRAFANA_GONE) from None
    return await grafana_config_from_in(cast(GrafanaIn, input.connection), registry)


async def _read_grafana(
    services: MonitoringServices, registry: ClusterRegistry, input: GrafanaInput
) -> ReadResult:
    cfg = await grafana_config(services, registry, input)
    client = services.grafana_client
    try:
        datasources = await client.datasources(cfg)  # once for every dashboard
    except GrafanaError as exc:
        raise TransferError(exc.status, "grafana", exc.message) from None
    uids = list(dict.fromkeys(input.uids))
    gate = asyncio.Semaphore(GRAFANA_READS)

    async def one(uid: str) -> ConvertedDashboard:
        async with gate:
            try:
                got = await client.dashboard(cfg, uid)
            except GrafanaError as exc:  # gone, or refused: that dashboard's problem only
                return _failed(uid, exc.message)
            try:
                rules, note = await client.alert_rules(cfg, uid)
            except GrafanaError as exc:
                rules, note = None, exc.message
        context = GrafanaContext(
            datasources=datasources or (), alert_rules=rules, alert_rules_note=note
        )
        converted = convert_grafana(got.raw, context, key=uid)
        version = got.version if got.version is not None else converted.identity.version
        return replace(converted, identity=Identity("grafana", uid, version))

    converted = list(await asyncio.gather(*(one(uid) for uid in uids)))
    n = len(uids)
    if n == 1:
        label = f"Grafana dashboard from {cfg.name}"
    else:
        label = f"{n} Grafana dashboards from {cfg.name}"
    return ReadResult("grafana_instance", label, converted, None, cfg, "grafana", cfg.name)


async def read_input(
    services: MonitoringServices, registry: ClusterRegistry, input: TextInput | GrafanaInput
) -> ReadResult:
    """What the input holds, converted for review. TransferError when it can't be read at all;
    a dashboard that can't be converted stays in the result with its problems."""
    if isinstance(input, TextInput):
        return await _read_text(services, registry, input)
    return await _read_grafana(services, registry, input)


# --- alerts, titles, targets -----------------------------------------------------------------


async def contact_points_by_name(services: MonitoringServices) -> dict[str, str]:
    """Contact point name → id (never their settings)."""
    return {cp.name: cp.id for cp in await services.contact_points.list()}


def attach_alerts(
    c: ConvertedDashboard,
    doc: dict,
    contact_points: Mapping[str, str],
    *,
    panels_gone: Mapping[str, str] | None = None,
) -> tuple[dict, list[SkippedItem]]:
    """`doc` with its alerts as this OmniKrux keeps them, and what changed on the way: an alert
    already in an OmniKrux document goes through `import_alert` (contact points by name, its own
    engine), and each Grafana draft through `alert_from_draft` onto its panel. `panels_gone`:
    panel id → why the mapping took that panel away (its draft goes with it, in words)."""
    out = copy.deepcopy(doc)
    items: list[SkippedItem] = []
    variables = out.get("variables", [])
    for panel in out["panels"]:
        alert = panel.get("alert")
        if alert is None:
            continue
        kept, found = import_alert(
            alert,
            panel=panel,
            panel_title=panel.get("title", ""),
            contact_points_by_name=contact_points,
            variables=variables,
        )
        items.extend(found)
        panel["alert"] = kept
    by_id = {p["id"]: p for p in out["panels"]}
    for panel_id, draft in c.alerts:
        panel = by_id.get(panel_id)
        if panel is None:
            why = (panels_gone or {}).get(panel_id)
            if why is not None:
                items.append(SkippedItem(f'Alert "{draft.title}"', "The rule", why))
            continue
        alert, item = alert_from_draft(draft, panel=panel, variables=variables)
        if item is not None:
            items.append(item)
        if alert is not None:
            panel["alert"] = alert
    return out, items


def review_digest(c: ConvertedDashboard, doc: dict, items: Sequence[SkippedItem]) -> str:
    """What a reviewer saw of one dashboard, as a hash: the converted dashboard (`digest`, which
    the origin row keeps) and its alerts as this OmniKrux attaches them now, with what changed on
    the way. A contact point removed, renamed or added since the preview changes it, so the
    commit is refused instead of an alert silently telling someone else, or no one."""
    payload = {
        "converted": digest(c),
        "alerts": [[p["id"], p.get("alert")] for p in doc.get("panels", [])],
        "items": [[i.where, i.what, i.reason] for i in items],
    }
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _alert_count(doc: dict) -> int:
    return sum(1 for p in doc.get("panels", []) if p.get("alert") is not None)


def unique_title(base: str, taken: set[str]) -> str:
    """`base`, or `base (2)`, `base (3)`… : the first title not in `taken`, within 120
    characters (as `DashboardStore.unique_title` numbers them)."""
    base = base.strip()[:MAX_TITLE]
    title, n = base, 1
    while title in taken:
        n += 1
        suffix = f" ({n})"
        title = base[: MAX_TITLE - len(suffix)].rstrip() + suffix
    return title


async def resolve_target(services: MonitoringServices, kind: OwnerKind, id: str) -> Target:
    """The project or group as it is now; 404 `not_found` when it is gone."""
    try:
        if kind == "project":
            project = await services.projects.get(id)
            return Target("project", id, project.name, tuple(l.source_id for l in project.links))
        group = await services.groups.get(id)
        return Target("group", id, group.name)
    except (UnknownProject, UnknownGroup):
        raise TransferError(404, "not_found", TARGET_GONE) from None


async def _owner_titles(services: MonitoringServices, target: Target | None) -> set[str]:
    if target is None or not target.id:
        return set()
    return {s.title for s in await services.dashboards.list(target.kind, target.id)}


async def _suggested_target(
    services: MonitoringServices, read: ReadResult, given: Target | None
) -> TargetOut | None:
    if given is not None:
        return TargetOut(kind=given.kind, id=given.id)
    bundle = read.bundle
    if bundle is None or not bundle.owner_name or bundle.owner_kind not in read.target_kinds:
        return None
    if bundle.owner_kind == "project":
        owners = [(p.id, p.name) for p in await services.projects.list()]
    else:
        owners = [(g.id, g.name) for g in await services.groups.list()]
    for id, name in owners:
        if name == bundle.owner_name:
            return TargetOut(kind=bundle.owner_kind, id=id)
    return None


def _all_refs(converted: Sequence[ConvertedDashboard]) -> list[SourceRefFound]:
    """Every reference the importable dashboards read, each once, in first-use order."""
    seen: dict[str, SourceRefFound] = {}
    for c in converted:
        if c.doc is None:
            continue
        for ref in c.refs:
            seen.setdefault(ref.key, ref)
    return list(seen.values())


def _bundle_out(read: ReadResult) -> BundleInfoOut | None:
    b = read.bundle
    if b is None or b.kind not in ("project", "group"):
        return None
    project = b.project or {}
    group = b.group or {}
    kind = project.get("kind")
    cluster = project.get("cluster")
    names = group.get("projects")
    return BundleInfoOut(
        kind=b.kind,  # type: ignore[arg-type]
        name=b.owner_name,
        project_kind=kind if kind in ("kubernetes", "docker", "servers", "custom") else None,
        cluster=cluster if isinstance(cluster, str) else None,
        sources=[
            BundleSourceOut(
                key=s.key,
                name=s.name,
                type=s.type,
                where=ref_detail(s) or "",
                filter=s.filter,
                auth=s.auth or "none",
            )
            for s in b.sources
        ],
        projects=[n for n in names if isinstance(n, str)] if isinstance(names, list) else [],
    )


def _problem_text(problem: Problem) -> str:
    message = problem.message.rstrip(".")
    return f"{problem.path}: {message}" if problem.path else message


def _not_importable(title: str, problem: Problem, key: str) -> TransferError:
    return TransferError(
        422,
        "not_importable",
        NOT_IMPORTABLE.format(title=title, problem=_problem_text(problem)),
        key=key,
    )


# --- preview -----------------------------------------------------------------------------------


async def preview(
    services: MonitoringServices, registry: ClusterRegistry, body: ImportPreviewIn
) -> ImportPreviewOut:
    """What importing the input would do. Nothing is stored and nothing is audited."""
    read = await read_input(services, registry, body.input)
    target: Target | None = None
    if body.target is not None:
        found = await resolve_target(services, body.target.kind, body.target.id)
        target = found if found.kind in read.target_kinds else None
    taken = await _owner_titles(services, target)
    contact_points = await contact_points_by_name(services)
    dashboards: list[PreviewDashboardOut] = []
    for c in read.converted:
        skipped = list(c.skipped)
        panels = alerts = 0
        shown = digest(c)
        if c.doc is not None:
            doc, items = attach_alerts(c, c.doc, contact_points)
            skipped.extend(items)
            panels, alerts = panel_count(doc), _alert_count(doc)
            shown = review_digest(c, doc, items)
        suggested = unique_title(c.title, taken) if c.title.strip() else c.title
        if c.doc is not None:
            taken.add(suggested)
        dashboards.append(
            PreviewDashboardOut(
                key=c.key,
                title=c.title,
                suggested_title=suggested,
                title_taken=suggested != c.title,
                panels=panels,
                alerts=alerts,
                skipped=[SkippedOut(where=s.where, what=s.what, reason=s.reason) for s in skipped],
                problems=[ProblemOut(path=p.path, message=p.message) for p in c.problems],
                importable=c.doc is not None,
                digest=shown,
            )
        )
    sources = await services.sources.list()
    clusters = await _cluster_names(registry)
    return ImportPreviewOut(
        format=read.format,
        format_label=read.format_label,
        target_kinds=list(read.target_kinds),
        suggested_target=await _suggested_target(services, read, target),
        bundle=_bundle_out(read),
        sources=[suggest(ref, target, sources, clusters) for ref in _all_refs(read.converted)],
        dashboards=dashboards,
        skipped_total=sum(len(d.skipped) for d in dashboards),
    )


# --- commit ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Planned:
    """One dashboard, checked and ready to write."""

    key: str
    converted: ConvertedDashboard
    doc: dict
    mapping: dict[str, MappingChoice]
    skipped: int


@dataclass(frozen=True)
class _NewGrafana:
    cfg: GrafanaConfig
    name: str


def _choices(
    body: ImportCommitIn,
    target: Target,
    refs: Mapping[str, SourceRefFound],
    sources: Mapping[str, SourceConfig],
) -> dict[str, MappingChoice]:
    """The mapping as chosen, checked: a source must be one the target project links, of the
    reference's type. A group's documents read no source of their own, so none is kept."""
    choices: dict[str, MappingChoice] = {}
    for m in body.mapping:
        if m.leave_out:
            choices[m.key] = MappingChoice(None, True)
            continue
        if m.source_id is None or target.kind == "group":
            choices[m.key] = MappingChoice(None)
            continue
        cfg = sources.get(m.source_id)
        if m.source_id not in target.links or cfg is None:
            name = cfg.name if cfg is not None else m.source_id
            message = UNLINKED_SOURCE.format(source=name, project=target.name)
            raise TransferError(422, "unlinked_source", message, key=m.key)
        ref = refs.get(m.key)
        if ref is not None and cfg.type != ref.type:
            message = WRONG_TYPE.format(
                source=cfg.name,
                has=TYPE_LABELS.get(cfg.type, cfg.type),
                needs=TYPE_LABELS[ref.type],
            )
            raise TransferError(422, "invalid_input", message, key=m.key)
        choices[m.key] = MappingChoice(m.source_id)
    return choices


def _panels_gone(before: dict, after: dict, skipped: Sequence[SkippedItem]) -> dict[str, str]:
    """Panel id → why the mapping took it away. `apply_mapping` lists one "The whole panel"
    item per panel it removes, in panel order, so the removed panels pair with them in order."""
    kept = {p["id"] for p in after["panels"]}
    removed = [p["id"] for p in before["panels"] if p["id"] not in kept]
    reasons = [s.reason for s in skipped if s.what == "The whole panel"]
    return dict(zip(removed, reasons, strict=False))


def _plan(
    c: ConvertedDashboard,
    title: str,
    target: Target,
    choices: Mapping[str, MappingChoice],
    contact_points: Mapping[str, str],
) -> _Planned:
    """The dashboard as it will be written for `target`: mapped, its alerts attached, titled and
    valid for the owner. 422 `not_importable` otherwise."""
    assert c.doc is not None
    mine = {ref.key: choices.get(ref.key, MappingChoice(None)) for ref in c.refs}
    names = {ref.key: ref.name for ref in c.refs}
    mapped, items = apply_mapping(c.doc, mine, owner_kind=target.kind, titles=names)
    gone = _panels_gone(c.doc, mapped, items)
    doc, alert_items = attach_alerts(c, mapped, contact_points, panels_gone=gone)
    doc["title"] = title
    try:
        doc = validate_dashboard(doc, owner_kind=target.kind)
    except DashboardInvalid as exc:
        raise _not_importable(title, exc.problems[0], c.key) from None
    if target.kind == "project":
        for source in _doc_sources(doc):
            sid = source["id"]
            if sid is not None and sid not in target.links:  # never: the mapping is checked
                message = UNLINKED_SOURCE.format(source=sid, project=target.name)
                raise TransferError(422, "unlinked_source", message, key=c.key)
    skipped = len(c.skipped) + len(items) + len(alert_items)
    return _Planned(c.key, c, doc, mine, skipped)


async def _place(
    services: MonitoringServices, body: ImportCommitIn, read: ReadResult
) -> tuple[Target, tuple[str, dict, list[str]] | None]:
    """Where the dashboards go, checked: an existing project or group, or a new group (its
    checked name and audit details; it is created with the dashboards)."""
    if (body.target is None) == (body.new_group is None):
        raise TransferError(422, "invalid_input", ONE_PLACE)
    if body.target is not None:
        if body.target.kind not in read.target_kinds:
            raise TransferError(422, "wrong_target", WRONG_TARGET)
        return await resolve_target(services, body.target.kind, body.target.id), None
    new = cast(NewGroupIn, body.new_group)
    if "group" not in read.target_kinds:
        raise TransferError(422, "wrong_target", WRONG_TARGET)
    try:
        name, details = await new_group_checked(services, new.name, new.project_ids)
    except HTTPException as exc:
        raise TransferError(exc.status_code, "invalid_input", str(exc.detail)) from None
    if any(g.name == name for g in await services.groups.list()):
        raise TransferError(409, "name_taken", str(NameTaken("group", name)))
    return Target("group", "", name), (name, details, list(new.project_ids))


async def _grafana_to_save(
    services: MonitoringServices, read: ReadResult, input: GrafanaInput
) -> tuple[str | None, _NewGrafana | None, str]:
    """(the saved connection's id, the connection to save, the origin label). A connection as
    entered reuses the saved one reaching the same Grafana; otherwise it is saved with the
    import, under its name or an automatic one."""
    cfg = cast(GrafanaConfig, read.grafana)
    if input.grafana_id is not None:
        return cfg.id, None, cfg.name
    existing = await services.grafana.find_target(cfg.url, cfg.cluster)
    if existing is not None:
        return existing.id, None, existing.name
    named = input.connection is not None and input.connection.name is not None
    if named:
        if any(g.name == cfg.name for g in await services.grafana.list()):
            raise TransferError(409, "name_taken", str(NameTaken(GRAFANA_KIND, cfg.name)))
        name = cfg.name
    else:
        name = await services.grafana.unique_name(cfg.name)
    return None, _NewGrafana(replace(cfg, name=name), name), name


async def commit(request: Request, body: ImportCommitIn) -> ImportResultOut:
    """Check every chosen dashboard, then write them all in one transaction (with a new group or
    Grafana connection), each audited first. TransferError when a check fails: nothing written."""
    services = cast(MonitoringServices, request.app.state.monitoring)
    registry: ClusterRegistry = request.app.state.registry
    read = await read_input(services, registry, body.input)
    by_key = {c.key: c for c in read.converted}
    keys = [d.key for d in body.dashboards]
    if len(set(keys)) != len(keys):
        raise TransferError(422, "invalid_input", ONCE_EACH)
    contact_points = await contact_points_by_name(services)
    for d in body.dashboards:
        c = by_key.get(d.key)
        if c is None:
            raise TransferError(409, "changed", CHANGED.format(title=d.title), key=d.key)
        if c.doc is None:
            raise _not_importable(c.title, c.problems[0], c.key)
        # The dashboard and its alerts as the preview showed them, contact points included.
        attached, items = attach_alerts(c, c.doc, contact_points)
        if review_digest(c, attached, items) != d.digest:
            raise TransferError(409, "changed", CHANGED.format(title=c.title), key=c.key)
    target, new_group = await _place(services, body, read)
    refs = {r.key: r for r in _all_refs([by_key[k] for k in keys])}
    sources = {s.id: s for s in await services.sources.list()}
    choices = _choices(body, target, refs, sources)
    taken = await _owner_titles(services, target)
    planned: list[_Planned] = []
    for d in body.dashboards:
        p = _plan(by_key[d.key], d.title, target, choices, contact_points)
        title = p.doc["title"]
        if title in taken:
            raise TransferError(409, "name_taken", str(NameTaken("dashboard", title)), key=d.key)
        taken.add(title)
        planned.append(p)
    grafana_id, new_grafana, label = None, None, read.label
    if isinstance(body.input, GrafanaInput):
        grafana_id, new_grafana, label = await _grafana_to_save(services, read, body.input)
    return await _write(
        request,
        services,
        registry,
        read,
        target,
        new_group,
        new_grafana,
        grafana_id,
        label,
        planned,
    )


async def _begin_all(
    request: Request,
    services: MonitoringServices,
    registry: ClusterRegistry,
    target: Target,
    new_group: tuple[str, dict, list[str]] | None,
    new_grafana: _NewGrafana | None,
    label: str,
    planned: Sequence[_Planned],
) -> list[int]:
    """The audit record of every write, before any is made. When one can't be written, those
    already begun end as failed and nothing is written (503)."""
    batch = uuid.uuid4().hex
    started: list[int] = []
    try:
        if new_group is not None:
            name, details, _ = new_group
            started.append(await begin_change(request, "group_add", "group", name, details))
        if new_grafana is not None:
            details = await _details(registry, new_grafana.cfg)
            started.append(
                await begin_change(request, "grafana_add", "grafana", new_grafana.name, details)
            )
        for p in planned:
            details = {
                "owner": target.kind,
                "owner_name": target.name,
                "from": label,
                "panels": panel_count(p.doc),
                "alerts": _alert_count(p.doc),
                "skipped": p.skipped,
                "batch": batch,
            }
            started.append(
                await begin_change(
                    request, "dashboard_import", "dashboard", p.doc["title"], details
                )
            )
    except Exception:  # 503 from the audit, or anything else: nothing is written
        for record in started:
            await finish_change(request, record, False, NOT_IMPORTED)
        raise
    return started


async def _write(
    request: Request,
    services: MonitoringServices,
    registry: ClusterRegistry,
    read: ReadResult,
    target: Target,
    new_group: tuple[str, dict, list[str]] | None,
    new_grafana: _NewGrafana | None,
    grafana_id: str | None,
    label: str,
    planned: Sequence[_Planned],
) -> ImportResultOut:
    records = await _begin_all(
        request, services, registry, target, new_group, new_grafana, label, planned
    )

    async def fail(message: str) -> None:
        for record in records:
            await finish_change(request, record, False, message)

    is_grafana = read.format in ("grafana", "grafana_instance")
    owner_id = target.id
    created = []
    key: str | None = None
    try:
        async with services.sessionmaker.begin() as session:
            await lock_first(session)
            if new_group is not None:
                name, _, project_ids = new_group
                group = await services.groups.create(name, project_ids, session=session)
                owner_id = group.id
            if new_grafana is not None:
                cfg = new_grafana.cfg
                saved = await services.grafana.create(
                    NewGrafana(
                        name=new_grafana.name,
                        reach=cfg.reach,
                        url=cfg.url,
                        cluster=cfg.cluster,
                        path_prefix=cfg.path_prefix,
                        auth_type=cfg.auth_type,
                        username=cfg.username,
                        secrets=cfg.secrets,
                    ),
                    session=session,
                )
                grafana_id = saved.id
            elif grafana_id is not None and await session.get(GrafanaRow, grafana_id) is None:
                grafana_id = None  # removed since it was read: the origins name none
            moment = now()
            for p in planned:
                key = p.key
                record = await services.dashboards.create(
                    target.kind,
                    owner_id,
                    p.doc,
                    origin="imported",
                    copied_from=label,
                    session=session,
                )
                identity = p.converted.identity
                ids = {panel["id"] for panel in p.doc["panels"]}
                await services.origins.record(
                    OriginRecord(
                        dashboard_id=record.id,
                        kind="grafana" if is_grafana else "omnikrux",
                        via=read.via,
                        label=label,
                        grafana_id=grafana_id if read.format == "grafana_instance" else None,
                        grafana_uid=identity.ref if is_grafana else None,
                        grafana_version=identity.version if is_grafana else None,
                        export_id=identity.ref if not is_grafana else None,
                        source_title=p.converted.title,
                        mapping=p.mapping,
                        digest=digest(p.converted),
                        imported_at=moment,
                        imported_version=1,
                        panels={src: pid for pid, src in p.converted.panel_sources if pid in ids},
                    ),
                    session=session,
                )
                created.append((p, record))
    except NameTaken as exc:
        await fail(str(exc))
        raise TransferError(409, "name_taken", str(exc), key=key) from None
    except UnknownProject:
        if new_group is not None:
            await fail(CHOSEN_PROJECT_GONE)
            raise TransferError(422, "invalid_input", CHOSEN_PROJECT_GONE) from None
        await fail(TARGET_GONE)
        raise TransferError(404, "not_found", TARGET_GONE) from None
    except UnknownGroup:
        await fail(TARGET_GONE)
        raise TransferError(404, "not_found", TARGET_GONE) from None
    except Exception as exc:  # noqa: BLE001 - answered in words; nothing was written
        log.warning("An import couldn't be saved (%s)", type(exc).__name__)
        await fail(NOT_IMPORTED)
        raise TransferError(500, "not_imported", NOT_IMPORTED) from None
    for record in records:
        await finish_change(request, record, True)
    changes: list[AlertChangeOut] = []
    for _, record in created:
        changes.extend(await reconcile_alerts(services, record.id))
    return ImportResultOut(
        dashboards=[
            ImportedOut(
                key=p.key,
                id=record.id,
                title=record.title,
                owner_kind=record.owner_kind,
                owner_id=record.owner_id,
            )
            for p, record in created
        ],
        group_id=owner_id if new_group is not None else None,
        grafana_id=grafana_id if read.format == "grafana_instance" else None,
        warnings=[],
        alert_changes=changes,
    )


# --- routes ------------------------------------------------------------------------------------

router = APIRouter()


async def _import_body[Body: BaseModel](request: Request, model: type[Body]) -> Body:
    """The body as `model`. A body far beyond what a 10 MB file can be, even written as JSON
    text, is refused before it is read (413)."""
    if len(await request.body()) > 8 * MAX_IMPORT_BYTES:
        raise transfer_error(TransferError(413, "too_large", TOO_LARGE))
    return await read_body(request, model)


@router.post("/import/preview", openapi_extra=_schema(ImportPreviewIn))
async def import_preview(request: Request) -> ImportPreviewOut:
    """What importing would do; nothing is stored and nothing is audited."""
    body = await _import_body(request, ImportPreviewIn)
    services = cast(MonitoringServices, request.app.state.monitoring)
    try:
        return await preview(services, request.app.state.registry, body)
    except TransferError as exc:
        raise transfer_error(exc) from None


@router.post("/import/commit", status_code=201, openapi_extra=_schema(ImportCommitIn))
async def import_commit(request: Request) -> ImportResultOut:
    """Import the chosen dashboards: all of them, or (when a check fails) none."""
    body = await _import_body(request, ImportCommitIn)
    try:
        return await commit(request, body)
    except TransferError as exc:
        raise transfer_error(exc) from None
