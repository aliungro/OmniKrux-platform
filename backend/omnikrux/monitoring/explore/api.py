"""`GET /projects/{id}/catalog`: the project catalog the building and Explore pages search in the
browser. Read only, so nothing is audited. Every refusal answers `detail = {"code", "message"}`
in plain words."""

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from omnikrux.monitoring.explore.catalog import (
    CatalogCacheClosed,
    CatalogEntry,
    CatalogState,
    project_catalog,
)
from omnikrux.monitoring.projects.types import UnknownProject
from omnikrux.monitoring.query.run import PROJECT_GONE
from omnikrux.monitoring.sources.connector import DEFAULT_LIMITS
from omnikrux.monitoring.sources.types import SourceType

REFRESH_CHOICE = "Use refresh=true or refresh=false."
STOPPING = "OmniKrux is stopping. Try again in a moment."

router = APIRouter()


class CatalogMetricOut(BaseModel):
    name: str
    type: str | None
    help: str | None
    unit: str | None
    labels: list[str]
    series: int | None  # None when the source didn't list its series
    family: str | None


class StreamLabelOut(BaseModel):
    name: str
    values: list[str]
    truncated: bool


class SourceCatalogOut(BaseModel):
    source_id: str
    source_name: str
    source_type: SourceType
    state: CatalogState
    message: str | None
    built_at: datetime
    metrics: list[CatalogMetricOut]
    labels: list[str]
    streams: list[StreamLabelOut]
    notes: list[str]
    # How far back a Loki's streams were read (seconds); None for any other source.
    stream_window_seconds: int | None


class CatalogOut(BaseModel):
    project_id: str
    sources: list[SourceCatalogOut]  # in link order


def _refusal(status: int, code: Literal["not_found", "bad_request", "unavailable"], message: str):
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _refresh(text: str | None) -> bool:
    if text is None or text in ("", "false", "0"):
        return False
    if text in ("true", "1"):
        return True
    raise _refusal(400, "bad_request", REFRESH_CHOICE)


def _source_out(entry: CatalogEntry) -> SourceCatalogOut:
    catalog = entry.catalog
    return SourceCatalogOut(
        source_id=entry.source_id,
        source_name=entry.source_name,
        source_type=entry.source_type,
        state=entry.state,
        message=entry.message,
        built_at=datetime.fromtimestamp(entry.built_at, UTC),
        metrics=[
            CatalogMetricOut(
                name=m.name,
                type=m.type,
                help=m.help,
                unit=m.unit,
                labels=list(m.labels),
                series=m.series,
                family=m.family,
            )
            for m in (catalog.metrics if catalog else ())
        ],
        labels=list(catalog.labels) if catalog else [],
        streams=[
            StreamLabelOut(name=s.name, values=list(s.values), truncated=s.truncated)
            for s in (catalog.streams if catalog else ())
        ],
        notes=list(catalog.notes) if catalog else [],
        stream_window_seconds=(
            DEFAULT_LIMITS.stream_window
            if entry.source_type == "loki" and entry.state == "ok"
            else None
        ),
    )


@router.get("/projects/{id}/catalog")
async def catalog_route(id: str, request: Request, refresh: str | None = None) -> CatalogOut:
    """Each linked source's catalog under its link's filter, cached; `refresh=true` rebuilds
    (at most once per 10 s per source). A source that fails is its own `error` section."""
    wanted = _refresh(refresh)
    try:
        entries = await project_catalog(request.app.state.monitoring, id, refresh=wanted)
    except UnknownProject:
        raise _refusal(404, "not_found", PROJECT_GONE) from None
    except CatalogCacheClosed:
        # The app is shutting down: the cache starts no new build.
        raise _refusal(503, "unavailable", STOPPING) from None
    return CatalogOut(project_id=id, sources=[_source_out(e) for e in entries])
