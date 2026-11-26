"""What Monitoring keeps that depends on a cluster: shown when the cluster is about to be
removed. Names only, sorted; nothing is changed."""

from fastapi import APIRouter, Request
from pydantic import BaseModel

from omnikrux.monitoring.services import MonitoringServices

router = APIRouter()


class ClusterUsesOut(BaseModel):
    projects: list[str]  # projects whose cluster it is
    sources: list[str]  # sources reached inside it


@router.get("/clusters/{cluster_id}/uses")
async def cluster_uses(cluster_id: str, request: Request) -> ClusterUsesOut:
    services: MonitoringServices = request.app.state.monitoring
    projects = [p.name for p in await services.projects.list() if p.cluster_id == cluster_id]
    sources = [
        s.name
        for s in await services.sources.list()
        if s.reach == "cluster" and s.cluster is not None and s.cluster.cluster_id == cluster_id
    ]
    key = lambda name: (name.casefold(), name)
    return ClusterUsesOut(projects=sorted(projects, key=key), sources=sorted(sources, key=key))
