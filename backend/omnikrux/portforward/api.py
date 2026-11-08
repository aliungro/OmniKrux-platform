"""Port-forward routes: start one, list them, stop one."""

from fastapi import APIRouter, HTTPException, Request, Response

from omnikrux.actions.authz import NotAllowed
from omnikrux.audit.store import actor_of
from omnikrux.portforward.manager import (
    NOT_RUNNING,
    ForwardIn,
    ForwardOut,
    ForwardRefused,
    PortForwardManager,
)

router = APIRouter()


def _forwards(request: Request) -> PortForwardManager:
    return request.app.state.forwards


@router.post("/api/port-forwards")
async def start_forward(body: ForwardIn, request: Request) -> ForwardOut:
    try:
        return await _forwards(request).start(body, actor_of(request))
    except NotAllowed as exc:
        raise HTTPException(status_code=403, detail=exc.message) from exc
    except ForwardRefused as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from exc


@router.get("/api/port-forwards")
async def list_forwards(request: Request) -> list[ForwardOut]:
    return _forwards(request).list()


@router.delete("/api/port-forwards/{forward_id}", status_code=204)
async def stop_forward(forward_id: str, request: Request) -> Response:
    try:
        await _forwards(request).stop(forward_id, actor_of(request))
    except NotAllowed as exc:
        raise HTTPException(status_code=403, detail=exc.message) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=NOT_RUNNING) from exc
    return Response(status_code=204)
