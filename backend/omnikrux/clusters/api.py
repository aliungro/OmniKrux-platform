from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from omnikrux.clusters.models import Environment, Provider
from omnikrux.clusters.registry import ClusterInfo

router = APIRouter(prefix="/api/clusters")


class ClusterOut(BaseModel):
    id: str
    name: str
    context_name: str
    server: str
    provider: Provider
    region: str | None
    environment: Environment
    state: Literal["unknown", "syncing", "ready", "error"] = "unknown"
    message: str | None = None


class KubeconfigIn(BaseModel):
    kubeconfig: str


def _out(info: ClusterInfo) -> ClusterOut:
    # TODO(Task 10): take state/message from app.state.hub.status(info.id).
    return ClusterOut(**asdict(info), state="unknown", message=None)


@router.get("")
async def list_clusters(request: Request) -> list[ClusterOut]:
    return [_out(c) for c in await request.app.state.registry.list()]


@router.post("/kubeconfig")
async def import_kubeconfig(body: KubeconfigIn, request: Request) -> list[ClusterOut]:
    settings = request.app.state.settings
    try:
        infos = await request.app.state.registry.upsert_from_kubeconfig(
            body.kubeconfig, in_container=settings.in_container
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return [_out(c) for c in infos]
