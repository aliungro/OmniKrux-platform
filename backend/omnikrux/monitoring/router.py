"""Every route under /api/monitoring. The feature routers' routes are added here."""

from fastapi import APIRouter, Depends
from fastapi.routing import APIRoute

from omnikrux.monitoring.sources.api import finding_router
from omnikrux.monitoring.sources.api import router as sources_router
from omnikrux.monitoring.web import refuse_cross_origin

router = APIRouter(prefix="/api/monitoring", dependencies=[Depends(refuse_cross_origin)])

# What `add_api_route` takes that an `APIRoute` keeps under the same name. A route's
# `dependencies` already hold its own router's (FastAPI merges them when the route is added).
_CARRIED = (
    "response_model",
    "status_code",
    "tags",
    "dependencies",
    "summary",
    "description",
    "response_description",
    "responses",
    "deprecated",
    "operation_id",
    "response_model_include",
    "response_model_exclude",
    "response_model_by_alias",
    "response_model_exclude_unset",
    "response_model_exclude_defaults",
    "response_model_exclude_none",
    "include_in_schema",
    "response_class",
    "name",
    "callbacks",
    "openapi_extra",
    "generate_unique_id_function",
    "strict_content_type",
)


def adopt(feature: APIRouter, into: APIRouter = router) -> None:
    """Add a feature router's routes to `into`, under its prefix and behind its dependencies,
    keeping every setting of each route. Not `include_router`: FastAPI keeps a nested include as
    one opaque entry whose routes carry only their own short paths, which hides them from walks
    over `app.routes`."""
    for route in feature.routes:
        if type(route) is not APIRoute:
            raise TypeError(f"Only plain API routes can be adopted, not {route!r}")
        settings = {key: getattr(route, key) for key in _CARRIED if hasattr(route, key)}
        into.add_api_route(route.path, route.endpoint, methods=sorted(route.methods), **settings)


adopt(sources_router)
adopt(finding_router)
