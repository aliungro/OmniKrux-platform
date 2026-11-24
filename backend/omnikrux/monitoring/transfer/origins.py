"""Where an imported dashboard came from: an OmniKrux export (a file or pasted text) or a
Grafana, the source mapping the import used, the digest of what was imported and which source
panel became which panel. "Update from source" reads it; the row goes with its dashboard
(`DashboardStore.delete`/`delete_owned`), and a removed Grafana connection only clears
`grafana_id` (`GrafanaStore.delete`)."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.monitoring.models import DashboardOriginRow, utc, writing

OriginKind = Literal["omnikrux", "grafana"]
OriginVia = Literal["file", "paste", "grafana"]


@dataclass(frozen=True)
class MappingChoice:
    """What one source reference of the imported document reads: a source of the owner
    (`source_id`; None: the owner's first source of the type), or nothing (`leave_out`)."""

    source_id: str | None
    leave_out: bool = False


def mapping_json(m: Mapping[str, MappingChoice]) -> str:
    return json.dumps(
        {key: {"source_id": c.source_id, "leave_out": c.leave_out} for key, c in m.items()},
        sort_keys=True,
    )


def mapping_from_json(text: str) -> dict[str, MappingChoice]:
    """The stored mapping; an entry that isn't a choice is left out."""
    raw = json.loads(text)
    found: dict[str, MappingChoice] = {}
    if not isinstance(raw, dict):
        return found
    for key, value in raw.items():
        if not isinstance(value, dict):
            continue
        source_id = value.get("source_id")
        found[key] = MappingChoice(
            source_id if isinstance(source_id, str) else None, value.get("leave_out") is True
        )
    return found


def _panels_json(panels: Mapping[str, str]) -> str:
    return json.dumps(dict(panels), sort_keys=True)


def _panels_from_json(text: str) -> dict[str, str]:
    raw = json.loads(text or "{}")
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(v, str)}


@dataclass(frozen=True)
class OriginRecord:
    dashboard_id: str
    kind: OriginKind
    via: OriginVia
    label: str
    grafana_id: str | None
    grafana_uid: str | None
    grafana_version: int | None
    export_id: str | None
    source_title: str
    mapping: dict[str, MappingChoice]
    digest: str
    imported_at: datetime
    imported_version: int
    updated_at: datetime | None = None
    updated_version: int | None = None
    # {the source's panel identity: panel id}: an update gives a known source panel its id.
    panels: dict[str, str] = field(default_factory=dict)


def _record(row: DashboardOriginRow) -> OriginRecord:
    return OriginRecord(
        dashboard_id=row.dashboard_id,
        kind=row.kind,  # type: ignore[arg-type]
        via=row.via,  # type: ignore[arg-type]
        label=row.label,
        grafana_id=row.grafana_id,
        grafana_uid=row.grafana_uid,
        grafana_version=row.grafana_version,
        export_id=row.export_id,
        source_title=row.source_title,
        mapping=mapping_from_json(row.mapping),
        digest=row.digest,
        imported_at=utc(row.imported_at),
        imported_version=row.imported_version,
        updated_at=utc(row.updated_at),
        updated_version=row.updated_version,
        panels=_panels_from_json(row.panels),
    )


class OriginStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    async def record(self, o: OriginRecord, *, session: AsyncSession | None = None) -> OriginRecord:
        """Keep where the dashboard came from (replacing what was kept for it before)."""
        row = DashboardOriginRow(
            dashboard_id=o.dashboard_id,
            kind=o.kind,
            via=o.via,
            label=o.label,
            grafana_id=o.grafana_id,
            grafana_uid=o.grafana_uid,
            grafana_version=o.grafana_version,
            export_id=o.export_id,
            source_title=o.source_title,
            mapping=mapping_json(o.mapping),
            panels=_panels_json(o.panels),
            digest=o.digest,
            imported_at=o.imported_at,
            imported_version=o.imported_version,
            updated_at=o.updated_at,
            updated_version=o.updated_version,
        )
        async with writing(self._sessionmaker, session) as s:
            merged = await s.merge(row)
            await s.flush()
            return _record(merged)

    async def get(self, dashboard_id: str) -> OriginRecord | None:
        async with self._sessionmaker() as session:
            row = await session.get(DashboardOriginRow, dashboard_id)
            return _record(row) if row is not None else None

    async def mark_updated(
        self,
        dashboard_id: str,
        *,
        version: int,
        digest: str,
        grafana_version: int | None,
        mapping: Mapping[str, MappingChoice],
        now: datetime,
        panels: Mapping[str, str] | None = None,
        session: AsyncSession | None = None,
    ) -> OriginRecord:
        """The dashboard was updated from its source as `version`; `panels` None keeps the stored
        panel map. KeyError when the dashboard has no origin. With `session`, the change is part
        of the caller's transaction (the dashboard's save) and commits with it."""
        async with writing(self._sessionmaker, session) as s:
            row = await s.get(DashboardOriginRow, dashboard_id)
            if row is None:
                raise KeyError(dashboard_id)
            row.updated_version = version
            row.updated_at = now
            row.digest = digest
            row.grafana_version = grafana_version
            row.mapping = mapping_json(mapping)
            if panels is not None:
                row.panels = _panels_json(panels)
            await s.flush()
            return _record(row)

    async def from_grafana(self, grafana_id: str) -> list[str]:
        """The dashboards imported through that Grafana connection."""
        async with self._sessionmaker() as session:
            found = await session.scalars(
                select(DashboardOriginRow.dashboard_id)
                .where(DashboardOriginRow.grafana_id == grafana_id)
                .order_by(DashboardOriginRow.dashboard_id)
            )
            return list(found)

    async def delete(self, dashboard_id: str, *, session: AsyncSession) -> None:
        """Forget the dashboard's origin inside the caller's transaction (it commits)."""
        await session.execute(
            delete(DashboardOriginRow).where(DashboardOriginRow.dashboard_id == dashboard_id)
        )
