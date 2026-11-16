"""422 answers for invalid requests that say which field is wrong and never echo what was sent.

FastAPI's default body carries pydantic's `input` (the whole request body, entered secrets
included) and `ctx`, and its `loc` can hold an unknown key the caller invented or a union tag.
This keeps only `loc` parts that are the route's own declared field names or list positions, a
curated `msg` per error type, and the type itself (Plan 5 ruling R6).
"""

from typing import get_args

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel

SOURCES = ("body", "query", "path", "header", "cookie")
MESSAGES = {
    "missing": "A required field is missing.",
    "extra_forbidden": "Remove the unrecognized field and try again.",
    "union_tag_invalid": "Choose a supported option and try again.",
    "union_tag_not_found": "Choose an option and try again.",
    "string_pattern_mismatch": "A field has an invalid format. Check the value and try again.",
    "too_short": "Add the required values and try again.",
    "too_long": "There are too many values. Remove some and try again.",
    "json_invalid": "The request body isn't valid JSON. Correct it and try again.",
}
GENERIC = "A value is invalid. Check the request and try again."
_CACHED = "_omnikrux_declared_names"  # kept on the route itself (routes aren't hashable)


def _model_names(annotation: object) -> set[str]:
    """Every field name (and alias) of the models reachable from a type annotation."""
    names: set[str] = set()
    seen: set[type] = set()
    pending = [annotation]
    while pending:
        current = pending.pop()
        if isinstance(current, type) and issubclass(current, BaseModel):
            if current in seen:
                continue
            seen.add(current)
            for name, field in current.model_fields.items():
                names.add(name)
                if field.alias:
                    names.add(field.alias)
                pending.append(field.annotation)
        else:
            pending.extend(get_args(current))
    return names


def declared_names(route: object) -> frozenset[str]:
    """The names a route declares for its parameters and body fields."""
    if not isinstance(route, APIRoute):
        return frozenset()
    if (names := getattr(route, _CACHED, None)) is None:
        found: set[str] = set()
        dependant = route.dependant
        for params in (
            dependant.path_params,
            dependant.query_params,
            dependant.header_params,
            dependant.cookie_params,
            dependant.body_params,
        ):
            for param in params:
                found.update((param.name, param.alias))
                found |= _model_names(param.field_info.annotation)
        names = frozenset(found)
        setattr(route, _CACHED, names)
    return names


def safe_location(location: tuple, code: str, names: frozenset[str]) -> list:
    if not location or location[0] not in SOURCES:
        return []
    # The unrecognized key of an extra_forbidden error is the caller's text, never a field name.
    rest = location[1:-1] if code == "extra_forbidden" else location[1:]
    kept = [part for part in rest if type(part) is int or (isinstance(part, str) and part in names)]
    return [location[0], *kept]


async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    names = declared_names(request.scope.get("route"))
    details = []
    for error in exc.errors():
        code = error["type"]
        message = MESSAGES.get(code)
        details.append(
            {
                "loc": safe_location(tuple(error.get("loc", ())), code, names),
                "type": code if message is not None else "value_error",
                "msg": message or GENERIC,
            }
        )
    return JSONResponse(status_code=422, content={"detail": details})
