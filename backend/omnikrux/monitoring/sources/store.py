"""Sources on disk. Secret values are encrypted with `SecretBox` and only ever decrypted into a
`SourceConfig`, which stays inside the backend."""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.monitoring.models import ProjectSourceRecord, SourceRecord, now, utc, writing
from omnikrux.monitoring.sources.types import (
    AUTH_SECRET,
    MAX_NAME,
    AuthType,
    ClusterTarget,
    NameTaken,
    Reach,
    SourceCheck,
    SourceConfig,
    SourceSecrets,
    SourceType,
    clean_name,
)
from omnikrux.security.secrets import SecretBox, SecretError

KIND = "source"
# Non-secret authentication settings, and the type that uses each.
AUTH_SETTING = {"username": "basic", "header_name": "api_key", "client_cert_pem": "mtls"}


@dataclass(frozen=True)
class NewSource:
    name: str
    type: SourceType
    reach: Reach
    url: str | None = None
    cluster: ClusterTarget | None = None
    path_prefix: str = ""
    auth_type: AuthType = "none"
    username: str | None = None
    header_name: str | None = None
    client_cert_pem: str | None = None
    ca_pem: str | None = None
    header_names: tuple[str, ...] = ()
    secrets: SourceSecrets = field(default_factory=SourceSecrets)
    created_by_project_id: str | None = None


@dataclass(frozen=True)
class SourceChange:
    """What to change; `None` keeps the stored value. For `url`, `ca_pem` and the auth settings,
    `""` clears it. A secret left `None` (or a header value missing from `secrets.headers`) keeps
    the stored one; a changed `auth_type` drops the old type's secret and settings, and headers
    no longer in `header_names` lose their values. Type and reach never change."""

    name: str | None = None
    url: str | None = None
    cluster: ClusterTarget | None = None
    path_prefix: str | None = None
    auth_type: AuthType | None = None
    username: str | None = None
    header_name: str | None = None
    client_cert_pem: str | None = None
    ca_pem: str | None = None
    header_names: tuple[str, ...] | None = None
    secrets: SourceSecrets = field(default_factory=SourceSecrets)


def _only_for(auth_type: str, secrets: SourceSecrets, header_names: tuple[str, ...]) -> dict:
    """The secrets worth keeping: the auth type's own, and the values of listed headers."""
    kept: dict[str, Any] = {}
    secret = AUTH_SECRET.get(auth_type)
    if secret is not None and getattr(secrets, secret) is not None:
        kept[secret] = getattr(secrets, secret)
    headers = {n: secrets.headers[n] for n in header_names if n in secrets.headers}
    if headers:
        kept["headers"] = headers
    return kept


def _auth_settings(auth_type: str, values: dict[str, str | None]) -> str:
    return json.dumps(
        {k: (values.get(k) or None) if AUTH_SETTING[k] == auth_type else None for k in AUTH_SETTING}
    )


class SourceStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], box: SecretBox) -> None:
        self._sessionmaker = sessionmaker
        self._box = box

    # -- reading -------------------------------------------------------------------------------

    def _secrets(self, row: SourceRecord) -> SourceSecrets | None:
        """The row's secrets; None when they can't be decrypted (one such row never stops the
        others from being read)."""
        if row.secret_encrypted is None:
            return SourceSecrets()
        try:
            values = json.loads(self._box.decrypt(row.secret_encrypted))
        except SecretError:
            return None
        return SourceSecrets(
            password=values.get("password"),
            token=values.get("token"),
            api_key=values.get("api_key"),
            client_key_pem=values.get("client_key_pem"),
            headers=dict(values.get("headers") or {}),
        )

    def _config(self, row: SourceRecord) -> SourceConfig:
        settings = json.loads(row.auth_settings)
        cluster = None
        if row.reach == "cluster" and row.cluster_id is not None:
            cluster = ClusterTarget(
                cluster_id=row.cluster_id,
                namespace=row.namespace or "",
                service=row.service or "",
                port=row.port or "",
                scheme=row.scheme,  # type: ignore[arg-type]
            )
        check = None
        if row.checked_at is not None:
            check = SourceCheck(
                ok=bool(row.check_ok),
                message=row.check_message,
                version=row.version,
                checked_at=utc(row.checked_at),
            )
        secrets = self._secrets(row)
        return SourceConfig(
            id=row.id,
            name=row.name,
            type=row.type,  # type: ignore[arg-type]
            reach=row.reach,  # type: ignore[arg-type]
            url=row.url,
            cluster=cluster,
            path_prefix=row.path_prefix,
            auth_type=row.auth_type,  # type: ignore[arg-type]
            username=settings.get("username"),
            header_name=settings.get("header_name"),
            client_cert_pem=settings.get("client_cert_pem"),
            ca_pem=row.ca_pem,
            header_names=tuple(json.loads(row.header_names)),
            secrets=secrets or SourceSecrets(),
            created_by_project_id=row.created_by_project_id,
            created_at=utc(row.created_at),
            updated_at=utc(row.updated_at),
            check=check,
            secrets_unreadable=secrets is None,
        )

    async def list(self) -> list[SourceConfig]:
        async with self._sessionmaker() as session:
            rows = await session.scalars(select(SourceRecord).order_by(SourceRecord.name))
            return [self._config(row) for row in rows]

    async def get(self, id: str) -> SourceConfig:
        async with self._sessionmaker() as session:
            return self._config(await _row(session, id))

    async def find_cluster_target(self, target: ClusterTarget) -> SourceConfig | None:
        """The source already reaching that service port in that cluster, if any."""
        async with self._sessionmaker() as session:
            row = await session.scalar(
                select(SourceRecord)
                .where(
                    SourceRecord.reach == "cluster",
                    SourceRecord.cluster_id == target.cluster_id,
                    SourceRecord.namespace == target.namespace,
                    SourceRecord.service == target.service,
                    SourceRecord.port == target.port,
                )
                .order_by(SourceRecord.created_at)
                .limit(1)
            )
            return self._config(row) if row is not None else None

    async def count(self) -> int:
        async with self._sessionmaker() as session:
            return await session.scalar(select(func.count()).select_from(SourceRecord)) or 0

    async def unique_name(self, base: str, *, also_taken: Iterable[str] = ()) -> str:
        """`base`, or `base (2)`, `base (3)`… whichever is free (kept within the name limit) and
        not one of `also_taken` (names chosen for sources not saved yet)."""
        base = clean_name(base)
        async with self._sessionmaker() as session:
            taken = set(await session.scalars(select(SourceRecord.name))) | set(also_taken)
        if base not in taken:
            return base
        n = 2
        while True:
            suffix = f" ({n})"
            name = base[: MAX_NAME - len(suffix)].rstrip() + suffix
            if name not in taken:
                return name
            n += 1

    # -- writing -------------------------------------------------------------------------------

    def _encrypt(self, secrets: dict) -> bytes | None:
        return self._box.encrypt(json.dumps(secrets).encode()) if secrets else None

    async def create(self, new: NewSource, *, session: AsyncSession | None = None) -> SourceConfig:
        name = clean_name(new.name)
        cluster = new.cluster if new.reach == "cluster" else None
        header_names = tuple(new.header_names)
        moment = now()
        row = SourceRecord(
            id=uuid.uuid4().hex,
            name=name,
            type=new.type,
            reach=new.reach,
            url=new.url if new.reach == "url" else None,
            cluster_id=cluster.cluster_id if cluster else None,
            namespace=cluster.namespace if cluster else None,
            service=cluster.service if cluster else None,
            port=cluster.port if cluster else None,
            scheme=cluster.scheme if cluster else "http",
            path_prefix=new.path_prefix,
            auth_type=new.auth_type,
            auth_settings=_auth_settings(
                new.auth_type,
                {
                    "username": new.username,
                    "header_name": new.header_name,
                    "client_cert_pem": new.client_cert_pem,
                },
            ),
            header_names=json.dumps(list(header_names)),
            ca_pem=new.ca_pem or None,
            secret_encrypted=self._encrypt(_only_for(new.auth_type, new.secrets, header_names)),
            created_by_project_id=new.created_by_project_id,
            created_at=moment,
            updated_at=moment,
        )
        async with writing(self._sessionmaker, session) as s:
            await _name_free(s, name)
            s.add(row)
            await _flush(s, name)
            return self._config(row)

    async def update(self, id: str, change: SourceChange) -> SourceConfig:
        async with self._sessionmaker.begin() as session:
            row = await _row(session, id)
            old = self._config(row)
            if change.name is not None:
                name = clean_name(change.name)
                if name != row.name:
                    await _name_free(session, name)
                row.name = name
            if change.url is not None and row.reach == "url":
                row.url = change.url or None
            if change.cluster is not None and row.reach == "cluster":
                row.cluster_id = change.cluster.cluster_id
                row.namespace = change.cluster.namespace
                row.service = change.cluster.service
                row.port = change.cluster.port
                row.scheme = change.cluster.scheme
            if change.path_prefix is not None:
                row.path_prefix = change.path_prefix
            if change.ca_pem is not None:
                row.ca_pem = change.ca_pem or None

            auth_type = change.auth_type or old.auth_type
            settings = {
                key: getattr(change, key) if getattr(change, key) is not None else getattr(old, key)
                for key in AUTH_SETTING
            }
            row.auth_type = auth_type
            row.auth_settings = _auth_settings(auth_type, settings)

            header_names = (
                tuple(change.header_names) if change.header_names is not None else old.header_names
            )
            row.header_names = json.dumps(list(header_names))
            given, stored = change.secrets, old.secrets
            merged = SourceSecrets(
                password=given.password if given.password is not None else stored.password,
                token=given.token if given.token is not None else stored.token,
                api_key=given.api_key if given.api_key is not None else stored.api_key,
                client_key_pem=(
                    given.client_key_pem
                    if given.client_key_pem is not None
                    else stored.client_key_pem
                ),
                headers={**stored.headers, **given.headers},
            )
            if not (
                old.secrets_unreadable
                and given == SourceSecrets()
                and change.auth_type is None
                and change.header_names is None
            ):
                # Unreadable secrets stay as they are until the authentication, the headers or
                # a secret is given again; then only what is given is kept.
                row.secret_encrypted = self._encrypt(_only_for(auth_type, merged, header_names))
            row.updated_at = now()
            await _flush(session, row.name)
            return self._config(row)

    async def delete(self, id: str, *, session: AsyncSession | None = None) -> None:
        """Remove the source and every project's link to it. KeyError if it doesn't exist."""
        async with writing(self._sessionmaker, session) as s:
            removed = await s.scalar(
                delete(SourceRecord).where(SourceRecord.id == id).returning(SourceRecord.id)
            )
            if removed is None:
                raise KeyError(id)
            await s.execute(delete(ProjectSourceRecord).where(ProjectSourceRecord.source_id == id))

    async def record_check(self, id: str, check: SourceCheck) -> None:
        """Keep the last check's result (it leaves `updated_at` alone). KeyError if unknown."""
        async with self._sessionmaker.begin() as session:
            result = await session.execute(
                update(SourceRecord)
                .where(SourceRecord.id == id)
                .values(
                    checked_at=check.checked_at,
                    check_ok=check.ok,
                    check_message=check.message,
                    version=check.version,
                )
            )
            if result.rowcount == 0:
                raise KeyError(id)


async def _row(session: AsyncSession, id: str) -> SourceRecord:
    row = await session.get(SourceRecord, id)
    if row is None:
        raise KeyError(id)
    return row


async def _name_free(session: AsyncSession, name: str) -> None:
    if await session.scalar(select(SourceRecord.id).where(SourceRecord.name == name)) is not None:
        raise NameTaken(KIND, name)


async def _flush(session: AsyncSession, name: str) -> None:
    """Write now; a name another writer took meanwhile reads as NameTaken."""
    try:
        await session.flush()
    except IntegrityError:
        raise NameTaken(KIND, name) from None
