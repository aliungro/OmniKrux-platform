"""GET /api/kinds: every kind any registered cluster serves, and how each cluster answered."""

from fastapi import APIRouter, Request

from omnikrux.resources.catalog import KindsOut

router = APIRouter()


@router.get("/api/kinds")
async def kinds(request: Request, refresh: bool = False) -> KindsOut:
    return await request.app.state.catalog.union(refresh=refresh)
