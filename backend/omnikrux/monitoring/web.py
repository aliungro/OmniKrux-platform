"""Checks every Monitoring route runs."""

from fastapi import HTTPException, Request

from omnikrux.web_security import is_cross_origin

CROSS_ORIGIN = "Cross-origin request refused"


async def refuse_cross_origin(request: Request) -> None:
    """Reads included: another site's page must not read sources, projects or query results.
    (`CrossOriginWriteGuard` already refuses writes before any route sees them.)"""
    if is_cross_origin(request):
        raise HTTPException(status_code=403, detail=CROSS_ORIGIN)
