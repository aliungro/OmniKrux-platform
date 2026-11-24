"""Routes for import and export.

Every refusal answers `detail = {"code": TransferErrorCode, "message": plain words, "key": the
dashboard or source key it is about or null, "problems": [{path, message}]}` through
`transfer_error`. Bodies are read here, not by FastAPI, so a body of the wrong shape is refused
in the same shape and words. An export is audited (`monitoring_export`) before it is answered."""

import json
from typing import cast

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, ValidationError

from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.dashboards.api import FIELD_INVALID, FIELD_UNKNOWN, NOT_AN_OBJECT, NOT_JSON
from omnikrux.monitoring.models import now
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.transfer.envelope import ExportKind
from omnikrux.monitoring.transfer.export import build_export
from omnikrux.monitoring.transfer.types import TransferError

EXPORT_KIND_CHOICE = 'Choose "dashboard", "project" or "group" to export.'
EXPORT_ID_NEEDED = "Choose the dashboard, project or group to export by its id."
_FIELD_WORDS = {"kind": EXPORT_KIND_CHOICE, "id": EXPORT_ID_NEEDED}

router = APIRouter()


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ExportIn(_Body):
    kind: ExportKind
    id: str


class ExportOut(BaseModel):
    file_name: str
    export: dict
    dashboards: int
    sources: int
    alerts: int


def transfer_error(exc: TransferError) -> HTTPException:
    """The refusal a route answers for `exc`."""
    return HTTPException(
        status_code=exc.status,
        detail={
            "code": exc.code,
            "message": exc.message,
            "key": exc.key,
            "problems": [{"path": p.path, "message": p.message} for p in exc.problems],
        },
    )


def _schema(model: type[BaseModel]) -> dict:
    """The body's schema for the OpenAPI document (the handler reads the body itself)."""
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": model.model_json_schema()}},
        }
    }


async def read_body[Body: BaseModel](
    request: Request, model: type[Body], words: dict[str, str] | None = None
) -> Body:
    """The body as `model`; 422 `invalid_input` in plain words when it isn't one (`words`: what
    each field is told). Never the value sent."""
    raw = await request.body()
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):  # RecursionError: nesting too deep to read
        raise transfer_error(TransferError(422, "invalid_input", NOT_JSON)) from None
    if not isinstance(data, dict):
        raise transfer_error(TransferError(422, "invalid_input", NOT_AN_OBJECT))
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        error = exc.errors()[0]
        if error.get("type") == "extra_forbidden":
            message = FIELD_UNKNOWN
        else:
            field = str((error.get("loc") or ("",))[0])
            message = (words or {}).get(field, FIELD_INVALID)
        raise transfer_error(TransferError(422, "invalid_input", message)) from None


@router.post("/export", openapi_extra=_schema(ExportIn))
async def export(request: Request) -> ExportOut:
    """The dashboard, project or group as an OmniKrux export file, with its name and counts."""
    body = await read_body(request, ExportIn, _FIELD_WORDS)
    services = cast(MonitoringServices, request.app.state.monitoring)
    try:
        file_name, out, counts = await build_export(
            services, request.app.state.registry, body.kind, body.id, now=now()
        )
    except TransferError as exc:
        raise transfer_error(exc) from None
    if body.kind == "dashboard":
        name = out["dashboards"][0]["dashboard"]["title"]
    else:
        name = out["owner"]["name"]
    details = {"dashboards": counts.dashboards, "sources": counts.sources, "alerts": counts.alerts}
    record = await begin_change(request, "monitoring_export", body.kind, name, details)
    await finish_change(request, record, True)
    return ExportOut(
        file_name=file_name,
        export=out,
        dashboards=counts.dashboards,
        sources=counts.sources,
        alerts=counts.alerts,
    )
