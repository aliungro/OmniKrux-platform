"""Alert routes: the dry run.

`POST /alerts/dry-run` changes nothing (it stores nothing, sends nothing), so it writes no audit
record. Every query it runs goes through `run_query` with the project's id."""

import time

from fastapi import APIRouter, HTTPException, Request

from omnikrux.monitoring.alerts.dry_run import DryRunIn, DryRunOut, DryRunRefused, dry_run

router = APIRouter(prefix="/alerts")


@router.post("/dry-run")
async def dry_run_route(body: DryRunIn, request: Request) -> DryRunOut:
    """How often the condition would have fired over the window, per project and merged."""
    try:
        return await dry_run(request.app.state.monitoring, body, time.time())
    except DryRunRefused as exc:
        raise HTTPException(
            status_code=exc.status, detail={"code": exc.code, "message": exc.message}
        ) from None
