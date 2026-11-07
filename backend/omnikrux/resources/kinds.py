"""Kinds: how one kind of object is listed, watched and shown.

A kind's key is kubectl's fully qualified resource name (`pods`, `deployments.apps`,
`widgets.example.omnikrux.dev`); `helm-releases` is the one virtual key. `KINDS` holds the curated
built-in kinds; every other kind a cluster serves gets `generic_spec`.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from typing import Literal

from omnikrux.kube.discovery import ApiResource
from omnikrux.resources.rows import ResourceRow, parse_ts, pod_row

ColumnType = Literal["text", "number", "status", "age", "time", "cpu", "memory", "object", "pods"]

HELM_RELEASES = "helm-releases"

# A DNS subdomain (RFC 1123), which every kubectl resource name is: lower case, dot-separated.
_KIND_KEY = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$")


@dataclass(frozen=True)
class Column:
    key: str
    label: str
    type: ColumnType = "text"
    width: Literal["s", "m", "l"] = "m"


@dataclass(frozen=True)
class KindSpec:
    key: str
    group: str
    version: str
    plural: str
    kind: str
    namespaced: bool
    label: str
    columns: tuple[Column, ...]
    to_row: Callable[[dict, str], ResourceRow]
    sort: Literal["status", "recent"] = "status"
    short_names: tuple[str, ...] = ()
    label_selector: str | None = None
    verbs: frozenset[str] = frozenset()
    # For copy such as "No deployments"; the plural resource name unless set.
    plural_label: str | None = None

    def _prefix(self) -> str:
        return f"/apis/{self.group}/{self.version}" if self.group else f"/api/{self.version}"

    def list_path(self) -> str:
        """The cluster-wide collection: `/api/v1/pods`, `/apis/apps/v1/deployments`."""
        return f"{self._prefix()}/{self.plural}"

    def object_path(self, namespace: str | None, name: str) -> str:
        if self.namespaced and namespace:
            return f"{self._prefix()}/namespaces/{namespace}/{self.plural}/{name}"
        return f"{self._prefix()}/{self.plural}/{name}"


def kind_key(group: str, plural: str) -> str:
    return f"{plural}.{group}" if group else plural


def is_kind_key(key: str) -> bool:
    return key == HELM_RELEASES or (len(key) <= 253 and _KIND_KEY.match(key) is not None)


NAME = Column("name", "Name", width="l")
NAMESPACE = Column("namespace", "Namespace")
AGE = Column("age", "Age", "age", "s")


def generic_row(obj: dict, cluster_id: str, *, kind: str) -> ResourceRow:
    """The row every kind can have: identity, age and labels."""
    md = obj.get("metadata") or {}
    return ResourceRow(
        uid=md.get("uid", ""),
        cluster_id=cluster_id,
        kind=kind,
        namespace=md.get("namespace"),
        name=md.get("name", ""),
        created_at=parse_ts(md["creationTimestamp"]) if md.get("creationTimestamp") else None,
        columns={},
        labels=md.get("labels") or {},
    )


def generic_spec(res: ApiResource, printer: list[dict] | None) -> KindSpec:
    """A spec for any served resource. `printer` (a CRD's printer columns) is used from Task 2."""
    columns = (NAME, NAMESPACE, AGE) if res.namespaced else (NAME, AGE)
    return KindSpec(
        key=kind_key(res.group, res.plural),
        group=res.group,
        version=res.version,
        plural=res.plural,
        kind=res.kind,
        namespaced=res.namespaced,
        label=res.kind,
        columns=columns,
        to_row=partial(generic_row, kind=res.kind),
        short_names=res.short_names,
        verbs=res.verbs,
    )


KINDS: dict[str, KindSpec] = {
    "pods": KindSpec(
        key="pods",
        group="",
        version="v1",
        plural="pods",
        kind="Pod",
        namespaced=True,
        label="Pod",
        columns=(
            NAME,
            NAMESPACE,
            Column("status", "Status", "status"),
            Column("ready", "Ready", width="s"),
            Column("restarts", "Restarts", "number", "s"),
            Column("node", "Node"),
            AGE,
        ),
        to_row=pod_row,
        short_names=("po",),
    ),
}
