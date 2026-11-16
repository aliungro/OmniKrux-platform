"""Which kinds each cluster serves: one discovery per cluster, cached, and their union."""

import asyncio
import dataclasses
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from pydantic import BaseModel

from omnikrux.clusters.registry import ClusterInfo
from omnikrux.kube.client import CloudApiClient
from omnikrux.kube.connections import ClusterConnections, cloud_kube_error, kube_error_message
from omnikrux.kube.discovery import Discovery, discover
from omnikrux.resources.kinds import HELM_RELEASES, KINDS, KindSpec, generic_spec, kind_key

logger = logging.getLogger(__name__)

DISCOVERY_TTL_SECONDS = 300
# helm-releases reads Secrets but never changes them, whatever the cluster allows on secrets.
READ_VERBS = frozenset({"get", "list", "watch"})


class KindNotServed(Exception):
    def __init__(self, key: str):
        self.key = key
        self.message = f"This cluster doesn't serve {key}."
        super().__init__(self.message)


@dataclass
class ClusterKinds:
    specs: dict[str, KindSpec]
    failed_groups: dict[str, str]
    fetched_at: float  # time.monotonic()
    version: str | None = None


class ColumnOut(BaseModel):
    key: str
    label: str
    type: str
    width: str


class ServedKind(BaseModel):
    key: str
    group: str
    version: str
    kind: str
    plural: str
    label: str
    plural_label: str
    namespaced: bool
    short_names: list[str]
    columns: list[ColumnOut]
    sort: Literal["status", "recent"]
    builtin: bool
    verbs: list[str]
    verbs_by_cluster: dict[str, list[str]]
    clusters: list[str]


class ClusterKindsStatus(BaseModel):
    state: Literal["ok", "error"]
    message: str | None
    failed_groups: dict[str, str]


class KindsOut(BaseModel):
    kinds: list[ServedKind]
    clusters: dict[str, ClusterKindsStatus]


class ClusterLister(Protocol):
    async def list(self) -> list[ClusterInfo]: ...


def cluster_specs(discovery: Discovery) -> dict[str, KindSpec]:
    """The specs for what a cluster serves: curated where `KINDS` has the kind, generic otherwise."""
    served = {(r.group, r.plural): r for r in discovery.resources}
    specs: dict[str, KindSpec] = {}
    for key, curated in KINDS.items():
        if key == HELM_RELEASES:  # releases are Secrets labelled owner=helm
            if (secrets := served.get(("", "secrets"))) is not None:
                specs[key] = dataclasses.replace(curated, verbs=secrets.verbs & READ_VERBS)
        elif (res := served.get((curated.group, curated.plural))) is not None:
            specs[key] = dataclasses.replace(curated, verbs=res.verbs)
    for res in discovery.resources:
        key = kind_key(res.group, res.plural)
        if key not in specs and key not in KINDS:
            specs[key] = generic_spec(res, discovery.printer_columns.get((res.group, res.plural)))
    return specs


class KindCatalog:
    """Per-cluster discovery, shared by concurrent callers and cached for `ttl` seconds.

    Failures are not cached: the next call discovers again."""

    def __init__(
        self,
        connections: ClusterConnections,
        registry: ClusterLister,
        *,
        ttl: float = DISCOVERY_TTL_SECONDS,
        is_cloud: Callable[[str], Awaitable[bool]] | None = None,
    ):
        self._connections = connections
        self._registry = registry
        self._ttl = ttl
        self._is_cloud = is_cloud
        self._entries: dict[str, ClusterKinds] = {}
        self._inflight: dict[str, asyncio.Task[ClusterKinds]] = {}

    async def cluster(self, cluster_id: str, *, refresh: bool = False) -> ClusterKinds:
        """What `cluster_id` serves. Raises KeyError (unknown cluster), ClusterUnavailable, or
        the connection error that stopped discovery."""
        entry = self._entries.get(cluster_id)
        if entry is not None and not refresh and time.monotonic() - entry.fetched_at < self._ttl:
            return entry
        task = self._inflight.get(cluster_id)
        if task is None:
            task = asyncio.create_task(
                self._discover(cluster_id), name=f"kind-discovery:{cluster_id}"
            )
            self._inflight[cluster_id] = task
            task.add_done_callback(lambda t: self._done(cluster_id, t))
        # Shielded: one caller giving up (a socket closing) must not cancel it for the others.
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            current = asyncio.current_task()
            if task.cancelled() and current is not None and not current.cancelling():
                # The discovery was cancelled, not this caller: the cluster was forgotten.
                raise KeyError(cluster_id) from None
            raise

    async def spec(self, cluster_id: str, key: str) -> KindSpec:
        """The spec for `key` on `cluster_id`; raises KindNotServed, ClusterUnavailable or
        KeyError (unknown cluster)."""
        spec = (await self.cluster(cluster_id)).specs.get(key)
        if spec is None:
            raise KindNotServed(key)
        return spec

    def cached_version(self, cluster_id: str) -> str | None:
        entry = self._entries.get(cluster_id)
        return entry.version if entry is not None else None

    async def union(self, *, refresh: bool = False) -> KindsOut:
        """Every kind any cluster serves, with the clusters serving it; all clusters at once.

        An unreachable cluster is an `error` entry, never a failed call."""
        infos = await self._registry.list()
        results = await asyncio.gather(*(self._status(i.id, refresh) for i in infos))
        kinds: dict[str, ServedKind] = {}
        clusters: dict[str, ClusterKindsStatus] = {}
        for info, (status, found) in zip(infos, results, strict=True):
            if status is None:  # removed while we asked
                continue
            clusters[info.id] = status
            for key, spec in (found.specs if found else {}).items():
                if (served := kinds.get(key)) is None:
                    kinds[key] = _served(spec, info.id)
                else:
                    served.clusters.append(info.id)
                    served.verbs_by_cluster[info.id] = sorted(spec.verbs)
                    served.verbs = sorted(set(served.verbs) | spec.verbs)
        order = {key: n for n, key in enumerate(KINDS)}
        ordered = sorted(
            kinds.values(), key=lambda k: (order.get(k.key, len(order)), k.label, k.key)
        )
        return KindsOut(kinds=ordered, clusters=clusters)

    def forget(self, cluster_id: str) -> None:
        """Drop what is known about a removed cluster and cancel its discovery in flight (its
        callers get KeyError, as for an unknown cluster)."""
        self._entries.pop(cluster_id, None)
        if (task := self._inflight.pop(cluster_id, None)) is not None:
            task.cancel()

    async def close(self) -> None:
        """Cancel every discovery in flight and wait for them; forget everything."""
        tasks = list(self._inflight.values())
        for cluster_id in list(self._inflight):
            self.forget(cluster_id)
        self._entries.clear()
        if tasks:
            await asyncio.wait(tasks)

    # --- internals ----------------------------------------------------------------------

    async def _discover(self, cluster_id: str) -> ClusterKinds:
        cloud = self._is_cloud is not None and await self._is_cloud(cluster_id)
        try:
            async with self._connections.api(cluster_id) as api:
                cloud = cloud or isinstance(api, CloudApiClient)
                discovery = await discover(api, cloud=cloud)
        except Exception as exc:
            if not cloud or (isinstance(exc, KeyError) and exc.args == (cluster_id,)):
                raise
            raise cloud_kube_error("read which kinds the cluster serves", exc=exc) from None
        entry = ClusterKinds(
            specs=cluster_specs(discovery),
            failed_groups=discovery.failed_groups,
            fetched_at=time.monotonic(),
            version=discovery.version,
        )
        if self._inflight.get(cluster_id) is asyncio.current_task():  # not forgotten meanwhile
            self._entries[cluster_id] = entry
        for group, why in discovery.failed_groups.items():
            logger.info("cluster %s: API group %s skipped: %s", cluster_id, group, why)
        return entry

    def _done(self, cluster_id: str, task: asyncio.Task) -> None:
        if self._inflight.get(cluster_id) is task:
            del self._inflight[cluster_id]
        if not task.cancelled():
            task.exception()  # retrieved: every waiter may have gone away

    async def _status(
        self, cluster_id: str, refresh: bool
    ) -> tuple[ClusterKindsStatus | None, ClusterKinds | None]:
        try:
            found = await self.cluster(cluster_id, refresh=refresh)
        except KeyError:
            return None, None
        except Exception as exc:  # noqa: BLE001 (one cluster's failure is its own entry)
            message = kube_error_message(exc, "read which kinds the cluster serves")
            return ClusterKindsStatus(state="error", message=message, failed_groups={}), None
        status = ClusterKindsStatus(state="ok", message=None, failed_groups=found.failed_groups)
        return status, found


def _served(spec: KindSpec, cluster_id: str) -> ServedKind:
    return ServedKind(
        key=spec.key,
        group=spec.group,
        version=spec.version,
        kind=spec.kind,
        plural=spec.plural,
        label=spec.label,
        plural_label=spec.plural_label or spec.plural,
        namespaced=spec.namespaced,
        short_names=list(spec.short_names),
        columns=[ColumnOut(**dataclasses.asdict(c)) for c in spec.columns],
        sort=spec.sort,
        builtin=spec.key in KINDS,
        verbs=sorted(spec.verbs),
        verbs_by_cluster={cluster_id: sorted(spec.verbs)},
        clusters=[cluster_id],
    )
