import json
import logging
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Literal, cast

import yaml
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.cloud.types import KUBE_PROVIDER, CloudClusterRef, DiscoveredCluster, NodePool
from omnikrux.clusters.kubeconfig import ParsedContext, parse_kubeconfig
from omnikrux.clusters.models import ClusterRecord, Environment, Provider
from omnikrux.security.secrets import SecretBox

Source = Literal["file", "upload", "cloud"]
SOURCE_FILE: Source = "file"
SOURCE_UPLOAD: Source = "upload"
SOURCE_CLOUD: Source = "cloud"
_ENV_ORDER = {Environment.PRODUCTION: 0, Environment.DEVELOPMENT: 1, Environment.UNKNOWN: 2}

log = logging.getLogger(__name__)


class ClusterConflict(ValueError):
    """An upload names a context that was already uploaded for a different server."""


@dataclass(frozen=True)
class ClusterInfo:
    id: str
    name: str
    context_name: str
    server: str
    original_server: str | None
    provider: Provider
    region: str | None
    environment: Environment
    source: str = "file"
    kubernetes_version: str | None = None
    node_pools: tuple[NodePool, ...] = ()
    node_count: int | None = None
    cloud_account_id: str | None = None
    cloud_resource_id: str | None = None
    cloud_missing_since: datetime | None = None


def _info(row: ClusterRecord) -> ClusterInfo:
    return ClusterInfo(
        id=row.id,
        name=row.name,
        context_name=row.context_name,
        server=row.server,
        original_server=row.original_server,
        provider=Provider(row.provider),
        region=row.region,
        environment=Environment(row.environment),
        source=row.source,
        kubernetes_version=row.kubernetes_version,
        node_pools=tuple(NodePool(**pool) for pool in json.loads(row.node_pools or "[]")),
        node_count=row.node_count,
        cloud_account_id=row.cloud_account_id,
        cloud_resource_id=row.cloud_resource_id,
        cloud_missing_since=(
            row.cloud_missing_since.replace(tzinfo=UTC)
            if row.cloud_missing_since is not None
            else None
        ),
    )


class ClusterRegistry:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], box: SecretBox) -> None:
        self._sessionmaker = sessionmaker
        self._box = box

    async def upsert_from_kubeconfig(
        self, text: str, *, rewrite_loopback: bool, source: Source
    ) -> list[ClusterInfo]:
        return await self.upsert_contexts(
            parse_kubeconfig(text, rewrite_loopback=rewrite_loopback), source=source
        )

    async def upsert_contexts(
        self, contexts: Sequence[ParsedContext], *, source: Source
    ) -> list[ClusterInfo]:
        """Store each context, all or nothing. A file context updates its record in place even
        when its server moved (a re-created kind cluster); an upload never silently replaces
        another server's cluster: that raises `ClusterConflict` and stores nothing."""
        out: list[ClusterInfo] = []
        async with self._sessionmaker() as session:
            for ctx in contexts:
                blob = self._box.encrypt(yaml.safe_dump(ctx.standalone).encode())
                row = (
                    await session.execute(
                        select(ClusterRecord).where(
                            ClusterRecord.source == source,
                            ClusterRecord.context_name == ctx.context_name,
                        )
                    )
                ).scalar_one_or_none()
                if row is None:
                    row = ClusterRecord(
                        name=ctx.context_name,
                        source=source,
                        context_name=ctx.context_name,
                        server=ctx.server,
                        original_server=ctx.original_server,
                        provider=ctx.provider.value,
                        region=None,
                        environment=ctx.environment.value,
                        kubeconfig_encrypted=blob,
                    )
                    session.add(row)
                else:
                    if source == SOURCE_UPLOAD and row.server != ctx.server:
                        raise ClusterConflict(
                            f"A cluster called {ctx.context_name} was already uploaded for"
                            f" {row.server}. Delete it first to replace it."
                        )
                    row.kubeconfig_encrypted = blob
                    row.server = ctx.server
                    row.original_server = ctx.original_server
                    row.provider = ctx.provider.value
                    row.environment = ctx.environment.value
                await session.flush()
                out.append(_info(row))
            await session.commit()
        return out

    async def reconcile_files(self, seen: set[str]) -> list[str]:
        """Delete `file` clusters whose context is no longer in any kubeconfig file; their ids."""
        async with self._sessionmaker() as session:
            gone = (
                await session.execute(
                    select(ClusterRecord.id, ClusterRecord.context_name).where(
                        ClusterRecord.source == SOURCE_FILE,
                        ClusterRecord.context_name.not_in(seen),
                    )
                )
            ).all()
            if not gone:
                return []
            ids = [cluster_id for cluster_id, _ in gone]
            await session.execute(delete(ClusterRecord).where(ClusterRecord.id.in_(ids)))
            await session.commit()
        log.warning(
            "Removed %d cluster(s) whose context is no longer in the kubeconfig files: %s",
            len(gone),
            ", ".join(sorted(name for _, name in gone)),
        )
        return ids

    async def upsert_cloud_cluster(
        self,
        ref: CloudClusterRef,
        found: DiscoveredCluster,
        *,
        server: str,
        ca_data: str | None,
        environment: Environment,
    ) -> ClusterInfo:
        name = ref.resource_id
        cluster = {"server": server}
        if ca_data is not None:
            cluster["certificate-authority-data"] = ca_data
        config = {
            "apiVersion": "v1",
            "kind": "Config",
            "current-context": name,
            "clusters": [{"name": name, "cluster": cluster}],
            "users": [{"name": name, "user": {}}],
            "contexts": [{"name": name, "context": {"cluster": name, "user": name}}],
        }
        blob = self._box.encrypt(yaml.safe_dump(config).encode())
        async with self._sessionmaker.begin() as session:
            row = await session.scalar(
                select(ClusterRecord).where(
                    ClusterRecord.source == SOURCE_CLOUD, ClusterRecord.context_name == name
                )
            )
            if row is None:
                row = ClusterRecord(source=SOURCE_CLOUD, context_name=name)
                session.add(row)
            row.name = ref.name
            row.server = server
            row.provider = KUBE_PROVIDER[ref.provider].value
            row.region = ref.region
            row.environment = environment.value
            row.kubeconfig_encrypted = blob
            row.cloud_account_id = ref.account_id
            row.cloud_resource_id = ref.resource_id
            row.cloud_details = json.dumps(ref.details)
            row.kubernetes_version = found.kubernetes_version
            row.node_pools = json.dumps([asdict(pool) for pool in found.node_pools])
            row.node_count = found.node_count
            row.cloud_missing_since = None
            await session.flush()
            return _info(row)

    async def cloud_ref(self, cluster_id: str) -> CloudClusterRef | None:
        async with self._sessionmaker() as session:
            row = await self._row(session, cluster_id)
            if row.source != SOURCE_CLOUD:
                return None
            provider = next(cloud for cloud, kube in KUBE_PROVIDER.items() if kube == row.provider)
            return CloudClusterRef(
                account_id=cast(str, row.cloud_account_id),
                provider=provider,
                resource_id=cast(str, row.cloud_resource_id),
                name=row.name,
                region=cast(str, row.region),
                details=json.loads(row.cloud_details or "{}"),
            )

    async def delete(self, cluster_id: str) -> None:
        async with self._sessionmaker() as session:
            await session.delete(await self._row(session, cluster_id))
            await session.commit()

    async def list(self) -> list[ClusterInfo]:
        async with self._sessionmaker() as session:
            rows = (await session.execute(select(ClusterRecord))).scalars().all()
        infos = [_info(r) for r in rows]
        return sorted(infos, key=lambda c: (_ENV_ORDER[c.environment], c.name))

    async def _row(self, session: AsyncSession, cluster_id: str) -> ClusterRecord:
        row = await session.get(ClusterRecord, cluster_id)
        if row is None:
            raise KeyError(cluster_id)
        return row

    async def get(self, cluster_id: str) -> ClusterInfo:
        async with self._sessionmaker() as session:
            return _info(await self._row(session, cluster_id))

    async def get_kubeconfig(self, cluster_id: str) -> dict:
        async with self._sessionmaker() as session:
            row = await self._row(session, cluster_id)
            return yaml.safe_load(self._box.decrypt(row.kubeconfig_encrypted))
