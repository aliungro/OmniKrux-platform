"""GET /api/audit: the audit log, newest first."""

import logging
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request

from omnikrux.audit.store import AuditLog, AuditPage

log = logging.getLogger(__name__)

router = APIRouter()

MAX_LIMIT = 500


@router.get("/api/audit")
async def audit_records(
    request: Request,
    cluster: str | None = None,
    action: str | None = None,
    q: str | None = None,
    outcome: Literal["failed"] | None = None,
    before: int | None = None,
    limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = 100,
) -> AuditPage:
    audit: AuditLog = request.app.state.audit
    try:
        return await audit.list(
            cluster_id=cluster or None,
            action=action or None,
            text=q,
            outcome=outcome,
            before=before,
            limit=limit,
        )
    except Exception as exc:
        log.warning("Could not read the audit log (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=503, detail="The audit log can't be read right now. Try again."
        ) from exc
