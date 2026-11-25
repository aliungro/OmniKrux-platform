"""Grafana connections on disk: where a Grafana is (an address, or a service in a known cluster)
and how OmniKrux signs in to it. The password or token is encrypted with `SecretBox` exactly like
a source's secrets (`SourceStore`) and is only ever decrypted into a `GrafanaConfig`, which stays
inside the backend: never in an answer, a URL, a log line, an audit record or an error."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal, get_args

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.monitoring.models import DashboardOriginRow, GrafanaRow, now, utc, writing
from omnikrux.monitoring.sources.types import MAX_NAME, ClusterTarget, NameTaken, Reach, clean_name
from omnikrux.security.secrets import SecretBox, SecretError

KIND = "Grafana connection"

GrafanaAuth = Literal["none", "basic", "bearer"]
# The secret each sign-in uses.
AUTH_SECRET = {"basic": "password", "bearer": "token"}


class UnknownGrafana(KeyError):
    pass


@dataclass(frozen=True)
class GrafanaSecrets:
    """Decrypted secret values. Never printed: every field is left out of the repr."""

    password: str | None = field(default=None, repr=False)
    token: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class GrafanaConfig:
    """A connection with its secrets decrypted; internal, it never leaves the backend.
    `secrets_unreadable`: the stored secret couldn't be decrypted (the key changed)."""

    id: str
    name: str
    reach: Reach
    url: str | None
    cluster: ClusterTarget | None
    path_prefix: str
    auth_type: GrafanaAuth
    username: str | None
    secrets: GrafanaSecrets
    created_at: datetime
    updated_at: datetime
    secrets_unreadable: bool = False


@dataclass(frozen=True)
class NewGrafana:
    name: str
    reach: Reach
    url: str | None = None
    cluster: ClusterTarget | None = None
    path_prefix: str = ""
    auth_type: GrafanaAuth = "none"
    username: str | None = None
    secrets: GrafanaSecrets = field(default_factory=GrafanaSecrets)


@dataclass(frozen=True)
class GrafanaChange:
    """What to change; `None` keeps the stored value. For `url` and `username`, `""` clears it.
    A secret left `None` keeps the stored one; a changed `auth_type` drops the old type's secret
    and user name. The reach never changes."""

    name: str | None = None
    url: str | None = None
    cluster: ClusterTarget | None = None
    path_prefix: str | None = None
    auth_type: GrafanaAuth | None = None
    username: str | None = None
    secrets: GrafanaSecrets = field(default_factory=GrafanaSecrets)


def _auth_type(value: str) -> GrafanaAuth:
    if value not in get_args(GrafanaAuth):
        raise ValueError(f"Unknown Grafana sign-in {value!r}")
    return value  # type: ignore[return-value]


def _only_for(auth_type: str, secrets: GrafanaSecrets) -> dict:
    """The secret the sign-in uses, if given."""
    secret = AUTH_SECRET.get(auth_type)
    if secret is None or getattr(secrets, secret) is None:
        return {}
    return {secret: getattr(secrets, secret)}


def _same_url(a: str | None, b: str | None) -> bool:
    return a is not None and b is not None and a.rstrip("/") == b.rstrip("/")


class GrafanaStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], box: SecretBox) -> None:
        self._sessionmaker = sessionmaker
        self._box = box

    # -- reading -------------------------------------------------------------------------------

    def _secrets(self, row: GrafanaRow) -> GrafanaSecrets | None:
        """The row's secrets; None when they can't be decrypted."""
        if row.secret_encrypted is None:
            return GrafanaSecrets()
        try:
            values = json.loads(self._box.decrypt(row.secret_encrypted))
        except SecretError:
            return None
        return GrafanaSecrets(password=values.get("password"), token=values.get("token"))

    def _config(self, row: GrafanaRow) -> GrafanaConfig:
        cluster = None
        if row.reach == "cluster" and row.cluster_id is not None:
            cluster = ClusterTarget(
                cluster_id=row.cluster_id,
                namespace=row.namespace or "",
                service=row.service or "",
                port=row.port or "",
                scheme=row.scheme,  # type: ignore[arg-type]
            )
        secrets = self._secrets(row)
        return GrafanaConfig(
            id=row.id,
            name=row.name,
            reach=row.reach,  # type: ignore[arg-type]
            url=row.url,
            cluster=cluster,
            path_prefix=row.path_prefix,
            auth_type=row.auth_type,  # type: ignore[arg-type]
            username=row.username,
            secrets=secrets or GrafanaSecrets(),
            created_at=utc(row.created_at),
            updated_at=utc(row.updated_at),
            secrets_unreadable=secrets is None,
        )

    async def list(self) -> list[GrafanaConfig]:
        async with self._sessionmaker() as session:
            rows = await session.scalars(select(GrafanaRow).order_by(GrafanaRow.name))
            return sorted((self._config(r) for r in rows), key=lambda g: (g.name.casefold(), g.id))

    async def get(self, id: str) -> GrafanaConfig:
        async with self._sessionmaker() as session:
            return self._config(await _row(session, id))

    async def find_target(
        self,
        url: str | None,
        cluster: ClusterTarget | None,
        *,
        fits: Callable[[GrafanaConfig], bool] | None = None,
    ) -> GrafanaConfig | None:
        """The connection already reaching that address (a trailing "/" aside), or that service
        port in that cluster; the oldest when there are several. With `fits`, only a connection
        it accepts (say, one that signs in the same way)."""
        async with self._sessionmaker() as session:
            if cluster is not None:
                rows = await session.scalars(
                    select(GrafanaRow)
                    .where(
                        GrafanaRow.reach == "cluster",
                        GrafanaRow.cluster_id == cluster.cluster_id,
                        GrafanaRow.namespace == cluster.namespace,
                        GrafanaRow.service == cluster.service,
                        GrafanaRow.port == cluster.port,
                    )
                    .order_by(GrafanaRow.created_at)
                )
                found = (self._config(row) for row in rows)
            elif url is None:
                return None
            else:
                rows = await session.scalars(
                    select(GrafanaRow)
                    .where(GrafanaRow.reach == "url", GrafanaRow.url.is_not(None))
                    .order_by(GrafanaRow.created_at)
                )
                found = (self._config(row) for row in rows if _same_url(row.url, url))
            return next((cfg for cfg in found if fits is None or fits(cfg)), None)

    async def unique_name(self, base: str, *, also_taken: Iterable[str] = ()) -> str:
        """`base`, or `base (2)`, `base (3)`… whichever is free (kept within the name limit) and
        not one of `also_taken`."""
        base = clean_name(base)
        async with self._sessionmaker() as session:
            taken = set(await session.scalars(select(GrafanaRow.name))) | set(also_taken)
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

    async def create(
        self, new: NewGrafana, *, session: AsyncSession | None = None
    ) -> GrafanaConfig:
        """NameTaken; ValueError for a name outside the rules or an unknown sign-in."""
        name = clean_name(new.name)
        auth_type = _auth_type(new.auth_type)
        cluster = new.cluster if new.reach == "cluster" else None
        moment = now()
        row = GrafanaRow(
            id=uuid.uuid4().hex,
            name=name,
            reach=new.reach,
            url=new.url if new.reach == "url" else None,
            cluster_id=cluster.cluster_id if cluster else None,
            namespace=cluster.namespace if cluster else None,
            service=cluster.service if cluster else None,
            port=cluster.port if cluster else None,
            scheme=cluster.scheme if cluster else "http",
            path_prefix=new.path_prefix,
            auth_type=auth_type,
            username=(new.username or None) if auth_type == "basic" else None,
            secret_encrypted=self._encrypt(_only_for(auth_type, new.secrets)),
            created_at=moment,
            updated_at=moment,
        )
        async with writing(self._sessionmaker, session) as s:
            await _name_free(s, name)
            s.add(row)
            await _flush(s, name)
            return self._config(row)

    async def update(self, id: str, change: GrafanaChange) -> GrafanaConfig:
        """UnknownGrafana, NameTaken; ValueError for a name outside the rules."""
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

            auth_type = _auth_type(change.auth_type or old.auth_type)
            switched = auth_type != old.auth_type
            username = change.username if change.username is not None else old.username
            row.auth_type = auth_type
            row.username = (username or None) if auth_type == "basic" else None
            given, stored = change.secrets, old.secrets
            merged = GrafanaSecrets(
                password=given.password if given.password is not None else stored.password,
                token=given.token if given.token is not None else stored.token,
            )
            if switched:
                # The old sign-in's secret goes; only what is given for the new one is kept.
                merged = given
            if not (old.secrets_unreadable and given == GrafanaSecrets() and not switched):
                # Unreadable secrets stay as they are until the sign-in or a secret is given
                # again.
                row.secret_encrypted = self._encrypt(_only_for(auth_type, merged))
            row.updated_at = now()
            await _flush(session, row.name)
            return self._config(row)

    async def delete(self, id: str) -> None:
        """Remove the connection; the dashboards imported through it stay, and their origins
        forget it (same transaction). UnknownGrafana."""
        async with self._sessionmaker.begin() as session:
            removed = await session.scalar(
                delete(GrafanaRow).where(GrafanaRow.id == id).returning(GrafanaRow.id)
            )
            if removed is None:
                raise UnknownGrafana(id)
            await session.execute(
                update(DashboardOriginRow)
                .where(DashboardOriginRow.grafana_id == id)
                .values(grafana_id=None)
            )


async def _row(session: AsyncSession, id: str) -> GrafanaRow:
    row = await session.get(GrafanaRow, id)
    if row is None:
        raise UnknownGrafana(id)
    return row


async def _name_free(session: AsyncSession, name: str) -> None:
    if await session.scalar(select(GrafanaRow.id).where(GrafanaRow.name == name)) is not None:
        raise NameTaken(KIND, name)


async def _flush(session: AsyncSession, name: str) -> None:
    """Write now; a name another writer took meanwhile reads as NameTaken."""
    try:
        await session.flush()
    except IntegrityError:
        raise NameTaken(KIND, name) from None
