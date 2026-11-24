"""The shapes every import and export step shares."""

import hashlib
import json
from dataclasses import asdict, dataclass
from typing import Literal

from omnikrux.monitoring.dashboards.schema import Problem

TransferErrorCode = Literal[
    "invalid_input",
    "unknown_format",
    "too_large",
    "not_found",
    "wrong_target",
    "unlinked_source",
    "changed",
    "name_taken",
    "not_importable",
    "grafana",
    "source_changed",
    "no_origin",
    "read_only",
    "version_conflict",
]


NEWER_FORMAT = (
    "This file comes from a newer OmniKrux (export format {n}). Update OmniKrux to import it."
)


class TransferError(Exception):
    """An import or export that can't go on, said in plain words."""

    def __init__(
        self,
        status: int,
        code: TransferErrorCode,
        message: str,
        key: str | None = None,
        problems: tuple[Problem, ...] = (),
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.key = key
        self.problems = problems


@dataclass(frozen=True)
class SkippedItem:
    """Something that was not converted exactly, with the reason."""

    where: str
    what: str
    reason: str


@dataclass(frozen=True)
class ExportedCluster:
    """A cluster service as an export names it (by cluster name, never by internal id). `name`
    is None when the exporting OmniKrux no longer knew the cluster."""

    name: str | None
    namespace: str
    service: str
    port: str
    scheme: Literal["http", "https"]


@dataclass(frozen=True)
class SourceRefFound:
    key: str
    type: Literal["prometheus", "loki"]
    type_guessed: bool
    name: str
    url: str | None
    cluster: ExportedCluster | None
    path_prefix: str = ""
    auth: str | None = None
    filter: str | None = None


@dataclass(frozen=True)
class AlertDraft:
    query_ref: str
    reducer: Literal["last", "mean", "max", "min", "sum"]
    op: Literal["above", "below"]
    threshold: float
    for_seconds: int
    title: str
    message: str | None  # None: the source sets no message
    severity: str | None  # None: the source sets no severity
    window_seconds: int | None


@dataclass(frozen=True)
class Identity:
    """Where a dashboard came from: `ref` is the Grafana uid or the OmniKrux export id."""

    kind: Literal["grafana", "omnikrux"]
    ref: str | None
    version: int | None


@dataclass(frozen=True)
class ConvertedDashboard:
    """One dashboard ready for review. `doc` is None exactly when `problems` is not empty.

    Source ids inside `doc` are ref keys or None. Panel ids in `alerts` are the converted ids.
    `panel_sources` pairs each converted panel id with the source's own panel identity (the
    Grafana panel id, or the OmniKrux panel id) so an update can keep panel ids stable; it is
    not part of the digest. Alert drafts carry no contact points or engine, so an update can keep
    the ones a panel's alert already has."""

    key: str
    title: str
    doc: dict | None
    refs: tuple[SourceRefFound, ...]
    skipped: tuple[SkippedItem, ...]
    alerts: tuple[tuple[str, AlertDraft], ...]
    problems: tuple[Problem, ...]
    identity: Identity
    panel_sources: tuple[tuple[str, str], ...] = ()


def digest(c: ConvertedDashboard) -> str:
    """What a reviewer saw, as a hash: the document, the skipped list, the alerts, the problems."""
    payload = {
        "doc": c.doc,
        "skipped": [asdict(s) for s in c.skipped],
        "alerts": [[pid, asdict(a)] for pid, a in c.alerts],
        "problems": [asdict(p) for p in c.problems],
    }
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
