"""Every route under /api/monitoring. The feature routers' routes are added here."""

from fastapi import APIRouter, Depends
from fastapi.routing import APIRoute

from omnikrux.monitoring.sources.api import router as sources_router
from omnikrux.monitoring.web import refuse_cross_origin

router = APIRouter(prefix="/api/monitoring", dependencies=[Depends(refuse_cross_origin)])


def adopt(feature: APIRouter) -> None:
    """Add a feature router's routes to this one, with this router's prefix and checks. Not
    `include_router`: FastAPI keeps a nested include as one opaque entry whose routes carry only
    their own short paths, which hides them from walks over `app.routes`."""
    for route in feature.routes:
        if not isinstance(route, APIRoute):
            raise TypeError(f"Only plain API routes can be adopted, not {route!r}")
        router.add_api_route(
            route.path,
            route.endpoint,
            methods=sorted(route.methods),
            status_code=route.status_code,
            name=route.name,
        )


adopt(sources_router)
