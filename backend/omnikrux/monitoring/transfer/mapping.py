"""The source mapping of an import: which of the target's sources each source reference of the
imported documents reads, the suggestion offered for it, and the document once mapped.

A reference is never turned into a source: an import only points queries at sources the target
project already links (or at none, which reads the project's first source of the type). So no
address, sign-in or header is ever invented from a file."""

import copy
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel

from omnikrux.monitoring.dashboards.schema import OwnerKind, variables_used
from omnikrux.monitoring.sources.types import SourceConfig
from omnikrux.monitoring.transfer.origins import MappingChoice
from omnikrux.monitoring.transfer.types import SkippedItem, SourceRefFound

TYPE_LABELS = {"prometheus": "Prometheus-compatible", "loki": "Loki"}

GROUP_TARGET = "In a group dashboard each project uses its own source."
NO_TARGET = "Pick where the dashboards go first."
SAME_SOURCE = "The same source."
SAME_ADDRESS = "Same address."
SAME_SERVICE = "Same service in the same cluster."
SAME_NAME = "Same name."
FIRST_OF_TYPE = "Uses {project}'s first {type} source ({name})."
NONE_OF_TYPE = "{project} has no {type} source yet; its panels say so until you link one."
LEFT_OUT = 'Left out on import: its data source "{name}" wasn\'t mapped.'


@dataclass(frozen=True)
class Target:
    """Where the dashboards go: a project (with its linked source ids, in link order) or a
    group (which links none)."""

    kind: OwnerKind
    id: str
    name: str
    links: tuple[str, ...] = ()


class SourceRefOut(BaseModel):
    key: str
    type: Literal["prometheus", "loki"]
    type_guessed: bool
    name: str
    detail: str | None
    suggestion: str | None
    leave_out: bool
    reason: str


def _address(url: str | None, path_prefix: str = "") -> str | None:
    """An address as it is compared: no trailing "/", the path prefix after it."""
    if not url:
        return None
    prefix = path_prefix.strip("/")
    base = url.rstrip("/")
    return f"{base}/{prefix}" if prefix else base


def ref_detail(ref: SourceRefFound) -> str | None:
    """Where the reference reads from, as the review shows it: an address, or a cluster's
    service (`cluster/namespace/service:port`)."""
    address = _address(ref.url, ref.path_prefix)
    if address is not None:
        return address
    c = ref.cluster
    if c is not None:
        service = f"{c.namespace}/{c.service}:{c.port}"
        return f"{c.name}/{service}" if c.name else service
    return None


def _ref_id(ref: SourceRefFound) -> str | None:
    """The source id a bare OmniKrux document named (`id:<id>`)."""
    return ref.key.removeprefix("id:") if ref.key.startswith("id:") else None


def suggest(
    ref: SourceRefFound,
    target: Target | None,
    sources: Sequence[SourceConfig],
    cluster_names: Mapping[str, str],
) -> SourceRefOut:
    """The reference with the source suggested for it in `target` and why. Only a source the
    target project links, of the reference's type, is ever suggested."""

    def out(suggestion: str | None, reason: str) -> SourceRefOut:
        return SourceRefOut(
            key=ref.key,
            type=ref.type,
            type_guessed=ref.type_guessed,
            name=ref.name,
            detail=ref_detail(ref),
            suggestion=suggestion,
            leave_out=False,
            reason=reason,
        )

    if target is None:
        return out(None, NO_TARGET)
    if target.kind == "group":
        return out(None, GROUP_TARGET)
    by_id = {s.id: s for s in sources}
    linked = [by_id[i] for i in target.links if i in by_id and by_id[i].type == ref.type]
    label = TYPE_LABELS[ref.type]
    if not linked:
        return out(None, NONE_OF_TYPE.format(project=target.name, type=label))
    wanted_id = _ref_id(ref)
    for s in linked:
        if wanted_id is not None and s.id == wanted_id:
            return out(s.id, SAME_SOURCE)
    wanted_address = _address(ref.url, ref.path_prefix)
    for s in linked:
        if (
            wanted_address is not None
            and s.reach == "url"
            and _address(s.url, s.path_prefix) == wanted_address
        ):
            return out(s.id, SAME_ADDRESS)
    c = ref.cluster
    for s in linked:
        if c is None or c.name is None or s.reach != "cluster" or s.cluster is None:
            continue
        mine = s.cluster
        if (cluster_names.get(mine.cluster_id), mine.namespace, mine.service, mine.port) == (
            c.name,
            c.namespace,
            c.service,
            c.port,
        ):
            return out(s.id, SAME_SERVICE)
    for s in linked:
        if ref.name and s.name.casefold() == ref.name.casefold():
            return out(s.id, SAME_NAME)
    return out(None, FIRST_OF_TYPE.format(project=target.name, type=label, name=linked[0].name))


# --- applying the mapping -------------------------------------------------------------------


def _uses(text: object, names: set[str]) -> bool:
    return isinstance(text, str) and any(n in names for n in variables_used(text))


def apply_mapping(
    doc: dict,
    mapping: Mapping[str, MappingChoice],
    *,
    owner_kind: OwnerKind,
    titles: Mapping[str, str],
) -> tuple[dict, list[SkippedItem]]:
    """The document with each source reference replaced by its chosen source, and what was
    left out on the way.

    A reference marked `leave_out` takes away the queries that read it (a panel left without
    queries goes too) and the variables that read it, with every query and variable that uses
    such a variable. A reference without a choice reads the owner's first source of its type
    (id None). In a group's document every source id is None: each project reads its own.
    `titles` names each reference (key → name) for the skipped list."""
    out = copy.deepcopy(doc)
    skipped: list[SkippedItem] = []
    left_out = {key for key, choice in mapping.items() if choice.leave_out}

    def reason(key: object) -> str:
        return LEFT_OUT.format(name=titles.get(str(key), str(key)))

    # Variables: those reading a left-out source, then (until nothing changes) those whose match
    # uses a variable that is gone.
    gone: dict[str, str] = {}  # variable name → the reason it went
    kept_vars: list[dict] = []
    for v in out.get("variables", []):
        sid = (v.get("source") or {}).get("id")
        if sid is not None and sid in left_out:
            gone[v["name"]] = reason(sid)
        else:
            kept_vars.append(v)
    changed = True
    while changed:
        changed = False
        for v in list(kept_vars):
            if _uses(v.get("match"), set(gone)):
                why = next(gone[n] for n in variables_used(v["match"]) if n in gone)
                gone[v["name"]] = why
                kept_vars.remove(v)
                changed = True
    for v in out.get("variables", []):
        if v["name"] in gone:
            skipped.append(
                SkippedItem(f"Variable ${v['name']}", "Its data source", gone[v["name"]])
            )
    out["variables"] = kept_vars

    kept_panels: list[dict] = []
    for panel in out.get("panels", []):
        where = f'Panel "{panel.get("title")}"'
        kept_queries: list[dict] = []
        removed: list[tuple[dict, str]] = []
        for q in panel.get("queries", []):
            sid = (q.get("source") or {}).get("id")
            if sid is not None and sid in left_out:
                removed.append((q, reason(sid)))
            elif _uses(q.get("expr"), set(gone)):
                name = next(n for n in variables_used(q["expr"]) if n in gone)
                removed.append((q, gone[name]))
            else:
                kept_queries.append(q)
        if removed and not kept_queries:
            skipped.append(SkippedItem(where, "The whole panel", removed[0][1]))
            alert = panel.get("alert")
            if isinstance(alert, dict):
                skipped.append(
                    SkippedItem(f'Alert "{alert.get("name")}"', "The rule", removed[0][1])
                )
            continue
        for q, why in removed:
            skipped.append(SkippedItem(where, f"Query {q.get('ref')}", why))
        panel["queries"] = kept_queries
        alert = panel.get("alert")
        refs = {q.get("ref") for q in kept_queries}
        if isinstance(alert, dict) and alert.get("query") not in refs:
            why = next((w for q, w in removed if q.get("ref") == alert.get("query")), None)
            if why is not None:
                skipped.append(SkippedItem(f'Alert "{alert.get("name")}"', "The rule", why))
                panel["alert"] = None
        kept_panels.append(panel)
    out["panels"] = kept_panels

    for source in _sources(out):
        sid = source.get("id")
        if owner_kind == "group" or sid is None:
            source["id"] = None
            continue
        choice = mapping.get(sid)
        source["id"] = choice.source_id if choice is not None else None
    return out, skipped


def _sources(doc: dict):
    for v in doc.get("variables", []):
        if isinstance(v.get("source"), dict):
            yield v["source"]
    for panel in doc.get("panels", []):
        for q in panel.get("queries", []):
            if isinstance(q.get("source"), dict):
                yield q["source"]
