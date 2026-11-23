"""Every route under /api/monitoring. The feature routers' routes are added here."""

from fastapi import APIRouter, Depends

from omnikrux.monitoring.alerts.router import router as alerts_router
from omnikrux.monitoring.dashboards.api import router as dashboards_router
from omnikrux.monitoring.explore.api import router as explore_router
from omnikrux.monitoring.projects.api import router as projects_router
from omnikrux.monitoring.query.api import router as query_router
from omnikrux.monitoring.sources.api import finding_router
from omnikrux.monitoring.sources.api import router as sources_router
from omnikrux.monitoring.web import adopt as adopt_routes
from omnikrux.monitoring.web import refuse_cross_origin

router = APIRouter(prefix="/api/monitoring", dependencies=[Depends(refuse_cross_origin)])


def adopt(feature: APIRouter, into: APIRouter = router) -> None:
    """Add a feature router's routes to `into` (the Monitoring router by default); see
    `web.adopt`."""
    adopt_routes(feature, into)


adopt(sources_router)
adopt(finding_router)
adopt(projects_router)
adopt(query_router)
adopt(dashboards_router)
adopt(explore_router)
adopt(alerts_router)
