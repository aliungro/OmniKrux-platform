"""The OmniKrux export file: writing the envelope and reading one back.

The reader is a hand-written walker over plain JSON values that reports exact paths. A broken
dashboard inside the file does not break the others: it stays in the result with its problems."""

import copy
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from omnikrux.monitoring.dashboards.schema import (
    DashboardInvalid,
    OwnerKind,
    Problem,
    validate_dashboard,
)
from omnikrux.monitoring.sources.types import SourceConfig
from omnikrux.monitoring.transfer.types import (
    NEWER_FORMAT,
    ExportedCluster,
    SkippedItem,
    SourceRefFound,
    TransferError,
)

ENVELOPE_MARK = "monitoring-export"
FORMAT_VERSION = 1
MAX_EXPORT_DASHBOARDS = 200
ExportKind = Literal["dashboard", "project", "group"]

_KINDS = ("dashboard", "project", "group")
_OWNERS = ("project", "group")
_TYPE_LABELS = {"prometheus": "Prometheus-compatible", "loki": "Loki"}

_KIND_COPY = 'Use "dashboard", "project" or "group".'
_OWNER_COPY = 'Use "project" or "group".'
_SOURCE_TYPE_COPY = 'Use "prometheus" or "loki".'
_SOURCE_KEY_COPY = "Each source needs its own key."
_DASHBOARDS_COPY = "An export holds 1 to 200 dashboards."
_SOURCES_COPY = "Sources must be a list. Export the file again, or fix the sources section."
_CLUSTER_COPY = "Give the cluster's name, namespace, service, port and scheme."
_UNLISTED_SOURCE = "It named a source the file doesn't list, so it uses the first {type} source."


@dataclass(frozen=True)
class EnvelopeDashboard:
    """One dashboard of the file. `doc` is checked as M2 checks a document, except that each
    panel alert's `notify` is left as the file has it (contact point names: `import_alert` maps
    them to this instance's ids)."""

    key: str
    export_id: str | None
    owner_kind: OwnerKind
    title: str
    doc: dict | None
    problems: tuple[Problem, ...]


@dataclass(frozen=True)
class EnvelopeRead:
    kind: ExportKind
    owner_kind: OwnerKind
    owner_name: str
    project: dict | None
    group: dict | None
    sources: tuple[SourceRefFound, ...]
    dashboards: tuple[EnvelopeDashboard, ...]
    skipped_by_key: dict[str, tuple[SkippedItem, ...]]


# --- writing --------------------------------------------------------------------------------


def source_entry(
    cfg: SourceConfig, key: str, cluster_name: str | None, filter: str | None = None
) -> dict:
    """One source as the file names it: type, address or cluster service, auth type and header
    names only. Never a secret, a user name or an internal cluster id."""
    cluster = None
    if cfg.reach == "cluster" and cfg.cluster is not None:
        c = cfg.cluster
        cluster = {
            "name": cluster_name,  # None: OmniKrux no longer knows the cluster
            "namespace": c.namespace,
            "service": c.service,
            "port": c.port,
            "scheme": c.scheme,
        }
    entry = {
        "key": key,
        "type": cfg.type,
        "name": cfg.name,
        "reach": cfg.reach,
        "url": cfg.url if cfg.reach == "url" else None,
        "cluster": cluster,
        "pathPrefix": cfg.path_prefix,
        "auth": cfg.auth_type,
        "headerNames": list(cfg.header_names),
    }
    if filter is not None:
        entry["filter"] = filter
    return entry


def envelope(
    kind: ExportKind,
    *,
    owner_kind: OwnerKind,
    owner_name: str,
    sources: list[dict],
    dashboards: list[dict],
    project: dict | None = None,
    group: dict | None = None,
    now: datetime,
) -> dict:
    if now.tzinfo is not None:
        now = now.astimezone(UTC)
    out: dict = {
        "omnikrux": ENVELOPE_MARK,
        "formatVersion": FORMAT_VERSION,
        "kind": kind,
        "exportedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "owner": {"kind": owner_kind, "name": owner_name},
    }
    if kind == "project" and project is not None:
        out["project"] = project
    if kind == "group" and group is not None:
        out["group"] = group
    out["sources"] = sources
    out["dashboards"] = dashboards
    return out


# --- reading --------------------------------------------------------------------------------


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _text(value: object, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _cluster(raw: object, path: str, problems: list[Problem]) -> ExportedCluster | None:
    if raw is None:
        return None
    if isinstance(raw, dict):
        name = raw.get("name")
        fields = [raw.get(k) for k in ("namespace", "service", "port")]
        if _is_int(fields[2]):
            fields[2] = str(fields[2])
        if (
            (name is None or isinstance(name, str))
            and all(isinstance(f, str) for f in fields)
            and raw.get("scheme") in ("http", "https")
        ):
            return ExportedCluster(name, *fields, raw["scheme"])
    problems.append(Problem(path, _CLUSTER_COPY))
    return None


def _links(raw: object) -> dict[str, str | None]:
    """source key -> filter, from a project's `links`."""
    out: dict[str, str | None] = {}
    if isinstance(raw, list):
        for link in raw:
            if isinstance(link, dict) and isinstance(link.get("source"), str):
                out[link["source"]] = _optional_text(link.get("filter"))
    return out


def _sources(
    raw: object, links: dict[str, str | None], problems: list[Problem]
) -> list[SourceRefFound]:
    found: list[SourceRefFound] = []
    if raw is None:
        return found
    if not isinstance(raw, list):
        problems.append(Problem("sources", _SOURCES_COPY))
        return found
    seen: set[str] = set()
    for i, item in enumerate(raw):
        path = f"sources[{i}]"
        if not isinstance(item, dict):
            problems.append(Problem(path, "Expected an object."))
            continue
        key = item.get("key")
        if not isinstance(key, str) or not key or key in seen:
            problems.append(Problem(f"{path}.key", _SOURCE_KEY_COPY))
            key = None
        else:
            seen.add(key)
        kind = item.get("type")
        if not isinstance(kind, str) or kind not in _TYPE_LABELS:
            problems.append(Problem(f"{path}.type", _SOURCE_TYPE_COPY))
            continue
        cluster = _cluster(item.get("cluster"), f"{path}.cluster", problems)
        if key is None:
            continue
        key_text = key
        found.append(
            SourceRefFound(
                key=key_text,
                type=kind,
                type_guessed=False,
                name=_text(item.get("name")),
                url=_optional_text(item.get("url")),
                cluster=cluster,
                path_prefix=_text(item.get("pathPrefix")),
                auth=_optional_text(item.get("auth")),
                filter=links[key_text] if key_text in links else _optional_text(item.get("filter")),
            )
        )
    return found


def _unlisted_sources(
    doc: dict, listed: set[str], owner_kind: OwnerKind
) -> tuple[dict, tuple[SkippedItem, ...]]:
    """Null every query source id the file doesn't list, saying so for each."""
    skipped: list[SkippedItem] = []
    if owner_kind == "group":
        return doc, ()
    for panel in doc.get("panels", []):
        for query in panel.get("queries", []):
            source = query.get("source") or {}
            sid = source.get("id")
            if sid is not None and sid not in listed:
                source["id"] = None
                label = _TYPE_LABELS.get(source.get("type"), "Prometheus-compatible")
                skipped.append(
                    SkippedItem(
                        f'Panel "{panel.get("title")}"',
                        f"Query {query.get('ref')}",
                        _UNLISTED_SOURCE.format(type=label),
                    )
                )
    return doc, tuple(skipped)


def _without_notify(body: object) -> tuple[object, dict[int, object]]:
    """`body` with each panel alert's `notify` set aside, and what was set aside by panel index.

    A file names contact points by name (`{"name": …}`), which the dashboard check refuses (it
    takes this instance's ids): the names go back in after the check, for `import_alert` to map
    or leave out in words."""
    if not isinstance(body, dict) or not isinstance(body.get("panels"), list):
        return body, {}
    out = copy.deepcopy(body)
    held: dict[int, object] = {}
    for i, panel in enumerate(out["panels"]):
        alert = panel.get("alert") if isinstance(panel, dict) else None
        if isinstance(alert, dict) and "notify" in alert:
            held[i] = alert.pop("notify")
    return out, held


def _dashboards(
    raw: object, owner_kind: OwnerKind, listed: set[str], problems: list[Problem]
) -> tuple[list[EnvelopeDashboard], dict[str, tuple[SkippedItem, ...]]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_EXPORT_DASHBOARDS:
        problems.append(Problem("dashboards", _DASHBOARDS_COPY))
        return [], {}
    out: list[EnvelopeDashboard] = []
    skipped_by_key: dict[str, tuple[SkippedItem, ...]] = {}
    for i, item in enumerate(raw, start=1):
        key = f"d-{i}"
        entry = item if isinstance(item, dict) else {}
        owner = (
            entry["owner"]
            if isinstance(entry.get("owner"), str) and entry["owner"] in _OWNERS
            else owner_kind
        )
        export_id = _optional_text(entry.get("exportId"))
        body = entry.get("dashboard")
        title = _text(body.get("title")) if isinstance(body, dict) else ""
        checked, held = _without_notify(body)
        try:
            doc = validate_dashboard(checked, owner_kind=owner)
        except DashboardInvalid as e:
            found = tuple(
                Problem(f"dashboard.{p.path}" if p.path else "dashboard", p.message)
                for p in e.problems
            )
            out.append(EnvelopeDashboard(key, export_id, owner, title, None, found))
            skipped_by_key[key] = ()
            continue
        for i, notify in held.items():
            doc["panels"][i]["alert"]["notify"] = notify
        doc, skipped = _unlisted_sources(doc, listed, owner)
        out.append(EnvelopeDashboard(key, export_id, owner, doc["title"], doc, ()))
        skipped_by_key[key] = skipped
    return out, skipped_by_key


def read_envelope(value: dict) -> EnvelopeRead:
    """The export file's contents. A broken envelope raises `TransferError(422, "invalid_input")`
    listing every problem; a broken dashboard stays in `dashboards` with its problems."""
    problems: list[Problem] = []
    version = value.get("formatVersion")
    if _is_int(version) and version > FORMAT_VERSION:
        problems.append(Problem("formatVersion", NEWER_FORMAT.format(n=version)))
    elif not (_is_int(version) and version == FORMAT_VERSION):
        problems.append(Problem("formatVersion", "Expected 1."))
    kind = value.get("kind")
    if not isinstance(kind, str) or kind not in _KINDS:
        problems.append(Problem("kind", _KIND_COPY))
    owner = value.get("owner") if isinstance(value.get("owner"), dict) else {}
    owner_kind = owner.get("kind")
    if not isinstance(owner_kind, str) or owner_kind not in _OWNERS:
        problems.append(Problem("owner.kind", _OWNER_COPY))
    project = value.get("project") if isinstance(value.get("project"), dict) else None
    group = value.get("group") if isinstance(value.get("group"), dict) else None
    links = _links(project.get("links")) if project else {}
    sources = _sources(value.get("sources"), links, problems)
    listed = {s.key for s in sources}
    dashboards, skipped_by_key = _dashboards(
        value.get("dashboards"),
        owner_kind if owner_kind in _OWNERS else "project",
        listed,
        problems,
    )
    if problems:
        raise TransferError(422, "invalid_input", problems[0].message, problems=tuple(problems))
    return EnvelopeRead(
        kind=kind,
        owner_kind=owner_kind,
        owner_name=_text(owner.get("name")),
        project=project if kind == "project" else None,
        group=group if kind == "group" else None,
        sources=tuple(sources),
        dashboards=tuple(dashboards),
        skipped_by_key=skipped_by_key,
    )
