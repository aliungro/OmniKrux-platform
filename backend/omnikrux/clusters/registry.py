from dataclasses import dataclass

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.clusters.kubeconfig import parse_kubeconfig
from omnikrux.clusters.models import ClusterRecord, Environment, Provider
from omnikrux.security.secrets import SecretBox

SOURCE = "kubeconfig"
_ENV_ORDER = {Environment.PRODUCTION: 0, Environment.DEVELOPMENT: 1, Environment.UNKNOWN: 2}


@dataclass(frozen=True)
class ClusterInfo:
    id: str
    name: str
    context_name: str
    server: str
    provider: Provider
    region: str | None
    environment: Environment


def _info(row: ClusterRecord) -> ClusterInfo:
    return ClusterInfo(
        id=row.id,
        name=row.name,
        context_name=row.context_name,
        server=row.server,
        provider=Provider(row.provider),
        region=row.region,
        environment=Environment(row.environment),
    )


class ClusterRegistry:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], box: SecretBox) -> None:
        self._sessionmaker = sessionmaker
        self._box = box

    async def upsert_from_kubeconfig(self, text: str, *, in_container: bool) -> list[ClusterInfo]:
        parsed = parse_kubeconfig(text, in_container=in_container)
        out: list[ClusterInfo] = []
        async with self._sessionmaker() as session:
            for ctx in parsed:
                blob = self._box.encrypt(yaml.safe_dump(ctx.standalone).encode())
                row = (
                    await session.execute(
                        select(ClusterRecord).where(
                            ClusterRecord.source == SOURCE,
                            ClusterRecord.context_name == ctx.context_name,
                            ClusterRecord.server == ctx.server,
                        )
                    )
                ).scalar_one_or_none()
                if row is None:
                    row = ClusterRecord(
                        name=ctx.context_name,
                        source=SOURCE,
                        context_name=ctx.context_name,
                        server=ctx.server,
                        provider=ctx.provider.value,
                        region=None,
                        environment=ctx.environment.value,
                        kubeconfig_encrypted=blob,
                    )
                    session.add(row)
                else:
                    row.kubeconfig_encrypted = blob
                    row.provider = ctx.provider.value
                    row.environment = ctx.environment.value
                await session.flush()
                out.append(_info(row))
            await session.commit()
        return out

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
