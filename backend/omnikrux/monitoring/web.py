"""Checks every Monitoring route runs, and how a feature's routes are added."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.routing import APIRoute

from omnikrux.web_security import is_cross_origin

CROSS_ORIGIN = "Cross-origin request refused"


async def refuse_cross_origin(request: Request) -> None:
    """Reads included: another site's page must not read sources, projects or query results.
    (`CrossOriginWriteGuard` already refuses writes before any route sees them.)"""
    if is_cross_origin(request):
        raise HTTPException(status_code=403, detail=CROSS_ORIGIN)


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


def adopt(feature: APIRouter, into: APIRouter) -> None:
    """Add a feature router's routes to `into`, under its prefix and behind its dependencies,
    keeping every setting of each route. Not `include_router`: FastAPI keeps a nested include as
    one opaque entry whose routes carry only their own short paths, which hides them from walks
    over `app.routes`."""
    for route in feature.routes:
        if type(route) is not APIRoute:
            raise TypeError(f"Only plain API routes can be adopted, not {route!r}")
        settings = {key: getattr(route, key) for key in _CARRIED if hasattr(route, key)}
        into.add_api_route(route.path, route.endpoint, methods=sorted(route.methods), **settings)
