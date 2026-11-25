"""Contact points on disk. Settings are plain JSON; secrets are one `SecretBox`-encrypted JSON
object, decrypted only into a `ContactPoint` (which stays inside the backend).

Every write checks what it stores (`types.resolve`), runs in its own transaction and raises
`NameTaken` for a name another contact point has."""

from __future__ import annotations

import json
import uuid
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.monitoring.alerts.contact_points.types import (
    ContactPoint,
    ContactPointType,
    UnknownContactPoint,
    resolve,
)
from omnikrux.monitoring.alerts.store import RuleRef
from omnikrux.monitoring.models import (
    AlertRuleRow,
    ContactPointRow,
    DeliveryRow,
    lock_first,
    now,
    utc,
)
from omnikrux.monitoring.projects.types import ReviewChanged, review_token
from omnikrux.monitoring.sources.types import NameTaken
from omnikrux.security.secrets import SecretBox, SecretError

KIND = "contact point"
DeliveryKind = str  # a notice kind ("firing", "resolved", …, "test")


@dataclass(frozen=True)
class ContactPointDeleteReview:
    id: str
    name: str
    used_by: tuple[RuleRef, ...]
    token: str


@dataclass(frozen=True)
class DeliveryRecord:
    id: int
    at: datetime
    contact_point_id: str
    target_id: str | None
    kind: str
    ok: bool
    message: str | None


def _by_name(refs: list[RuleRef]) -> list[RuleRef]:
    return sorted(set(refs), key=lambda r: (r.name.casefold(), r.id))


def _token(id: str, name: str, used_by: list[RuleRef]) -> str:
    return review_token({"id": id, "name": name, "used_by": [[r.id, r.name] for r in used_by]})


async def _usage(session: AsyncSession) -> dict[str, list[RuleRef]]:
    """Contact point id → the (not deleted) rules that notify it, by name."""
    rows = await session.execute(
        select(AlertRuleRow.id, AlertRuleRow.name, AlertRuleRow.contact_point_ids).where(
            AlertRuleRow.deleted_at.is_(None)
        )
    )
    found: dict[str, list[RuleRef]] = defaultdict(list)
    for rule_id, name, ids in rows:
        for cp_id in set(json.loads(ids)):
            found[cp_id].append(RuleRef(rule_id, name))
    return {cp_id: _by_name(refs) for cp_id, refs in found.items()}


async def _row(session: AsyncSession, id: str) -> ContactPointRow:
    row = await session.get(ContactPointRow, id)
    if row is None:
        raise UnknownContactPoint(id)
    return row


async def _name_free(session: AsyncSession, name: str, but: str | None = None) -> None:
    query = select(ContactPointRow.id).where(ContactPointRow.name == name)
    if but is not None:
        query = query.where(ContactPointRow.id != but)
    if await session.scalar(query) is not None:
        raise NameTaken(KIND, name)


async def _flush(session: AsyncSession, name: str) -> None:
    """Write now; a name another writer took meanwhile reads as NameTaken."""
    try:
        await session.flush()
    except IntegrityError:
        raise NameTaken(KIND, name) from None


class ContactPointStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], box: SecretBox) -> None:
        self._sessionmaker = sessionmaker
        self._box = box

    # -- rows to records -----------------------------------------------------------------------

    def _secrets(self, row: ContactPointRow) -> dict[str, str] | None:
        """The row's secrets; None when they can't be decrypted (one such row never stops the
        others from being read)."""
        if row.secret_encrypted is None:
            return {}
        try:
            values = json.loads(self._box.decrypt(row.secret_encrypted))
        except (SecretError, ValueError):
            return None
        return {str(k): str(v) for k, v in values.items() if v}

    def _encrypt(self, secrets: Mapping[str, str]) -> bytes | None:
        kept = {key: value for key, value in secrets.items() if value}
        return self._box.encrypt(json.dumps(kept).encode()) if kept else None

    def _record(self, row: ContactPointRow) -> ContactPoint:
        secrets = self._secrets(row)
        return ContactPoint(
            id=row.id,
            name=row.name,
            type=row.type,  # type: ignore[arg-type]
            settings=json.loads(row.settings),
            secrets=secrets or {},
            last_delivery_at=utc(row.last_delivery_at),
            last_delivery_ok=row.last_delivery_ok,
            last_delivery_message=row.last_delivery_message,
            created_at=utc(row.created_at),  # type: ignore[arg-type]
            updated_at=utc(row.updated_at),  # type: ignore[arg-type]
            secrets_unreadable=secrets is None,
        )

    # -- reading -------------------------------------------------------------------------------

    async def list(self) -> list[ContactPoint]:
        """Every contact point, by name (any case)."""
        async with self._sessionmaker() as session:
            rows = await session.scalars(select(ContactPointRow))
            records = [self._record(row) for row in rows]
        return sorted(records, key=lambda cp: (cp.name.casefold(), cp.id))

    async def get(self, id: str) -> ContactPoint:
        """UnknownContactPoint."""
        async with self._sessionmaker() as session:
            return self._record(await _row(session, id))

    async def used_by(self, id: str) -> list[RuleRef]:
        """The rules that notify the contact point, by name."""
        async with self._sessionmaker() as session:
            return (await _usage(session)).get(id, [])

    async def usage(self) -> dict[str, list[RuleRef]]:
        """`used_by` of every contact point at once."""
        async with self._sessionmaker() as session:
            return await _usage(session)

    # -- writing -------------------------------------------------------------------------------

    async def create(
        self,
        name: str,
        type: ContactPointType,
        settings: Mapping[str, object],
        secrets: Mapping[str, str | None],
    ) -> ContactPoint:
        """ContactPointInvalid, NameTaken."""
        checked = resolve(type, name=name, settings=settings, secrets=secrets)
        moment = now()
        row = ContactPointRow(
            id=uuid.uuid4().hex,
            name=checked.name,
            type=type,
            settings=json.dumps(checked.settings, sort_keys=True),
            secret_encrypted=self._encrypt(checked.secrets or {}),
            last_delivery_at=None,
            last_delivery_ok=None,
            last_delivery_message=None,
            created_at=moment,
            updated_at=moment,
        )
        async with self._sessionmaker.begin() as session:
            await _name_free(session, checked.name)
            session.add(row)
            await _flush(session, checked.name)
            return self._record(row)

    async def update(
        self,
        id: str,
        *,
        name: str | None = None,
        settings: Mapping[str, object] | None = None,
        secrets: Mapping[str, str | None] | None = None,
    ) -> ContactPoint:
        """Change what is given: `settings` are merged onto the stored ones; a secret sent as
        `None` (or not sent) keeps the stored value and `""` clears an optional one. Secrets
        that can't be read stay as they are until one is given again (then only what is given
        counts). The type never changes. UnknownContactPoint, ContactPointInvalid, NameTaken."""
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            row = await _row(session, id)
            old = self._record(row)
            checked = resolve(
                old.type,
                name=name if name is not None else old.name,
                settings=settings or {},
                secrets=secrets or {},
                stored_settings=old.settings,
                stored_secrets=old.secrets,
                secrets_unreadable=old.secrets_unreadable,
            )
            if checked.name != row.name:
                await _name_free(session, checked.name, but=id)
            row.name = checked.name
            row.settings = json.dumps(checked.settings, sort_keys=True)
            if checked.secrets is not None:
                row.secret_encrypted = self._encrypt(checked.secrets)
            row.updated_at = now()
            await _flush(session, checked.name)
            return self._record(row)

    async def delete_review(self, id: str) -> ContactPointDeleteReview:
        """What a delete would do: the rules that lose the contact point. UnknownContactPoint."""
        async with self._sessionmaker() as session:
            return await self._review(session, id)

    async def _review(self, session: AsyncSession, id: str) -> ContactPointDeleteReview:
        row = await _row(session, id)
        used_by = (await _usage(session)).get(id, [])
        return ContactPointDeleteReview(
            id=row.id,
            name=row.name,
            used_by=tuple(used_by),
            token=_token(row.id, row.name, used_by),
        )

    async def delete(self, id: str, token: str | None = None) -> list[RuleRef]:
        """Remove the contact point, and its id from every rule that notifies it (each such rule
        moves to its next version). With `token`, the review must still be what it was
        (ReviewChanged, nothing changed). Returns the rules it was removed from.
        UnknownContactPoint."""
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            review = await self._review(session, id)
            if token is not None and token != review.token:
                raise ReviewChanged()
            moment = now()
            rows = await session.scalars(
                select(AlertRuleRow).where(
                    AlertRuleRow.contact_point_ids.contains(id, autoescape=True)
                )
            )
            for rule in rows:
                ids = json.loads(rule.contact_point_ids)
                if id not in ids:
                    continue
                rule.contact_point_ids = json.dumps([each for each in ids if each != id])
                rule.version = rule.version + 1
                rule.updated_at = moment
            await session.execute(delete(ContactPointRow).where(ContactPointRow.id == id))
            return list(review.used_by)

    async def record_delivery(self, id: str, ok: bool, message: str | None, at: datetime) -> None:
        """Keep the last delivery's result (it leaves `updated_at` alone). `message` must be
        copy that carries no secret. UnknownContactPoint."""
        async with self._sessionmaker.begin() as session:
            result = await session.execute(
                update(ContactPointRow)
                .where(ContactPointRow.id == id)
                .values(last_delivery_at=at, last_delivery_ok=ok, last_delivery_message=message)
            )
            if result.rowcount == 0:
                raise UnknownContactPoint(id)

    async def add_delivery(
        self,
        contact_point_id: str,
        target_id: str | None,
        kind: DeliveryKind,
        ok: bool,
        message: str | None,
        at: datetime,
    ) -> None:
        """One row of the delivery log (`AlertStore.prune` bounds it). `message` must be copy
        that carries no secret."""
        async with self._sessionmaker.begin() as session:
            session.add(
                DeliveryRow(
                    at=at,
                    contact_point_id=contact_point_id,
                    target_id=target_id,
                    kind=kind,
                    ok=ok,
                    message=message,
                )
            )

    async def deliveries(
        self, *, contact_point_id: str | None = None, limit: int = 50
    ) -> list[DeliveryRecord]:
        """The delivery log, newest first; or one contact point's."""
        query = select(DeliveryRow)
        if contact_point_id is not None:
            query = query.where(DeliveryRow.contact_point_id == contact_point_id)
        query = query.order_by(DeliveryRow.at.desc(), DeliveryRow.id.desc()).limit(limit)
        async with self._sessionmaker() as session:
            return [
                DeliveryRecord(
                    id=row.id,
                    at=utc(row.at),  # type: ignore[arg-type]
                    contact_point_id=row.contact_point_id,
                    target_id=row.target_id,
                    kind=row.kind,
                    ok=bool(row.ok),
                    message=row.message,
                )
                for row in await session.scalars(query)
            ]
