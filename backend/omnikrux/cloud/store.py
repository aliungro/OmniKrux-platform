from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.cloud.models import CloudAccountRecord, DiscoveredRecord, DiscoveryState
from omnikrux.cloud.types import (
    KUBE_PROVIDER,
    AccountConfig,
    CloudProvider,
    CredentialSourceKind,
    DiscoveredCluster,
    NodePool,
    environment_from_tags,
)
from omnikrux.clusters.models import ClusterRecord, Environment
from omnikrux.security.secrets import SecretBox


@dataclass
class CloudAccount:
    id: str
    provider: CloudProvider
    source: CredentialSourceKind
    scope: str
    name: str
    principal: str
    settings: dict
    has_secret: bool
    checked_at: datetime | None
    check_ok: bool | None
    check_message: str | None
    problems: list[str]


@dataclass
class Discovered:
    id: str
    account_id: str
    cluster: DiscoveredCluster
    environment: Environment
    state: DiscoveryState
    cluster_id: str | None
    first_seen: datetime
    last_seen: datetime
    missing_since: datetime | None


@dataclass
class SavedDiscovery:
    new_ids: list[str]
    vanished_cluster_ids: list[str]
    changed_cluster_ids: list[str]


class AccountExists(Exception):
    def __init__(self, existing_name: str) -> None:
        self.existing_name = existing_name
        super().__init__(existing_name)


def _account(row: CloudAccountRecord) -> CloudAccount:
    return CloudAccount(
        id=row.id,
        provider=row.provider,
        source=row.source,
        scope=row.scope,
        name=row.name,
        principal=row.principal,
        settings=json.loads(row.settings),
        has_secret=row.secret_encrypted is not None,
        checked_at=row.checked_at.replace(tzinfo=UTC) if row.checked_at is not None else None,
        check_ok=row.check_ok,
        check_message=row.check_message,
        problems=json.loads(row.problems or "[]"),
    )


def _discovered(row: DiscoveredRecord) -> Discovered:
    return Discovered(
        id=row.id,
        account_id=row.account_id,
        cluster=DiscoveredCluster(
            resource_id=row.resource_id,
            name=row.name,
            region=row.region,
            kubernetes_version=row.kubernetes_version,
            node_pools=tuple(NodePool(**pool) for pool in json.loads(row.node_pools)),
            node_count=row.node_count,
            tags=json.loads(row.tags),
            private=row.private,
            why_not=row.why_not,
            details=json.loads(row.details),
        ),
        environment=Environment(row.environment),
        state=row.state,
        cluster_id=row.cluster_id,
        first_seen=row.first_seen.replace(tzinfo=UTC),
        last_seen=row.last_seen.replace(tzinfo=UTC),
        missing_since=row.missing_since.replace(tzinfo=UTC)
        if row.missing_since is not None
        else None,
    )


class CloudAccountStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], box: SecretBox) -> None:
        self._sessionmaker = sessionmaker
        self._box = box

    async def create(
        self,
        provider: CloudProvider,
        source: CredentialSourceKind,
        scope: str,
        name: str,
        principal: str,
        settings: dict,
        secret: dict | None,
    ) -> CloudAccount:
        row = CloudAccountRecord(
            provider=provider,
            source=source,
            scope=scope,
            name=name,
            principal=principal,
            settings=json.dumps(settings),
            secret_encrypted=(
                self._box.encrypt(json.dumps(secret).encode()) if secret is not None else None
            ),
        )
        async with self._sessionmaker() as session:
            session.add(row)
            try:
                await session.commit()
            except IntegrityError:
                await session.rollback()
                existing = await session.scalar(
                    select(CloudAccountRecord.name).where(
                        CloudAccountRecord.provider == provider, CloudAccountRecord.scope == scope
                    )
                )
                if existing is None:
                    raise
                raise AccountExists(existing) from None
            return _account(row)

    async def list(self) -> list[CloudAccount]:
        async with self._sessionmaker() as session:
            rows = await session.scalars(
                select(CloudAccountRecord).order_by(CloudAccountRecord.created_at)
            )
            return [_account(row) for row in rows]

    async def get(self, id: str) -> CloudAccount:
        async with self._sessionmaker() as session:
            return _account(await self._row(session, id))

    async def config(self, id: str) -> AccountConfig:
        async with self._sessionmaker() as session:
            row = await self._row(session, id)
            secret = row.secret_encrypted
            return AccountConfig(
                row.id,
                row.provider,
                row.source,
                row.scope,
                json.loads(row.settings),
                json.loads(self._box.decrypt(secret)) if secret is not None else None,
            )

    async def _row(self, session: AsyncSession, id: str) -> CloudAccountRecord:
        row = await session.get(CloudAccountRecord, id)
        if row is None:
            raise KeyError(id)
        return row

    async def delete(self, id: str) -> list[str]:
        async with self._sessionmaker.begin() as session:
            await session.execute(delete(CloudAccountRecord).where(CloudAccountRecord.id == id))
            await session.execute(delete(DiscoveredRecord).where(DiscoveredRecord.account_id == id))
            cluster_ids = await session.scalars(
                delete(ClusterRecord)
                .where(ClusterRecord.source == "cloud", ClusterRecord.cloud_account_id == id)
                .returning(ClusterRecord.id)
            )
            return list(cluster_ids)

    async def record_check(
        self, id: str, *, ok: bool, message: str | None, problems: list[str], at: datetime
    ) -> None:
        async with self._sessionmaker.begin() as session:
            row = await self._row(session, id)
            row.checked_at = at.astimezone(UTC)
            row.check_ok = ok
            row.check_message = message
            row.problems = json.dumps(problems)

    async def save_discovery(
        self,
        id: str,
        clusters: list[DiscoveredCluster],
        at: datetime,
        *,
        mark_missing: bool = True,
    ) -> SavedDiscovery:
        at = at.astimezone(UTC)
        result = SavedDiscovery([], [], [])
        async with self._sessionmaker.begin() as session:
            # Serialize discovery with other writes for this account, including account deletion.
            provider = await session.scalar(
                update(CloudAccountRecord)
                .where(CloudAccountRecord.id == id)
                .values(updated_at=CloudAccountRecord.updated_at)
                .returning(CloudAccountRecord.provider)
            )
            if provider is None:
                raise KeyError(id)

            rows = await session.execute(
                select(DiscoveredRecord, ClusterRecord)
                .outerjoin(
                    ClusterRecord,
                    (DiscoveredRecord.cluster_id == ClusterRecord.id)
                    & (DiscoveredRecord.account_id == ClusterRecord.cloud_account_id)
                    & (DiscoveredRecord.state == "added")
                    & (ClusterRecord.source == "cloud"),
                )
                .where(DiscoveredRecord.account_id == id)
            )
            previous = {row.resource_id: (row, added) for row, added in rows}
            new_rows = []
            for resource_id, found in {
                cluster.resource_id: cluster for cluster in clusters
            }.items():
                row, added = previous.pop(resource_id, (None, None))
                if row is None:
                    row = DiscoveredRecord(
                        account_id=id, resource_id=resource_id, state="new", first_seen=at
                    )
                    session.add(row)
                    new_rows.append(row)
                row.name = found.name
                row.region = found.region
                row.kubernetes_version = found.kubernetes_version
                row.node_pools = json.dumps([asdict(pool) for pool in found.node_pools])
                row.node_count = found.node_count
                row.tags = json.dumps(found.tags)
                row.environment = environment_from_tags(
                    found.tags, found.name, KUBE_PROVIDER[provider]
                )
                row.private = found.private
                row.why_not = found.why_not
                row.details = json.dumps(found.details)
                row.last_seen = at
                row.missing_since = None
                if added is not None:
                    added.kubernetes_version = row.kubernetes_version
                    added.node_pools = row.node_pools
                    added.node_count = row.node_count
                    added.region = row.region
                    added.environment = row.environment
                    added.cloud_missing_since = None
                    if session.is_modified(added):
                        result.changed_cluster_ids.append(added.id)

            if mark_missing:
                for row, added in previous.values():
                    if row.missing_since is None:
                        row.missing_since = at
                        if added is not None:
                            result.vanished_cluster_ids.append(added.id)
                    if added is not None and added.cloud_missing_since != row.missing_since:
                        added.cloud_missing_since = row.missing_since
                        result.changed_cluster_ids.append(added.id)

            await session.flush()
            result.new_ids.extend(row.id for row in new_rows)
        return result

    async def discovered(self, account_id: str | None = None) -> list[Discovered]:
        stmt = select(DiscoveredRecord)
        if account_id is not None:
            stmt = stmt.where(DiscoveredRecord.account_id == account_id)
        async with self._sessionmaker() as session:
            rows = await session.scalars(stmt)
            return [_discovered(row) for row in rows]

    async def discovered_one(self, id: str) -> Discovered:
        async with self._sessionmaker() as session:
            row = await session.get(DiscoveredRecord, id)
            if row is None:
                raise KeyError(id)
            return _discovered(row)

    async def set_state(
        self, ids: list[str], state: DiscoveryState, cluster_id: str | None = None
    ) -> None:
        async with self._sessionmaker.begin() as session:
            await session.execute(
                update(DiscoveredRecord)
                .where(DiscoveredRecord.id.in_(ids))
                .values(state=state, cluster_id=cluster_id)
            )

    async def discovered_for_cluster(self, cluster_id: str) -> Discovered | None:
        async with self._sessionmaker() as session:
            row = await session.scalar(
                select(DiscoveredRecord).where(DiscoveredRecord.cluster_id == cluster_id)
            )
            return _discovered(row) if row is not None else None
