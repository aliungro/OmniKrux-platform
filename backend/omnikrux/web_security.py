"""Checks shared by every browser-facing route."""

from urllib.parse import urlsplit

from starlette.requests import HTTPConnection
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

# Requests that change something: a page on another site must not be able to send them.
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def is_cross_origin(conn: HTTPConnection) -> bool:
    """True when a browser sent this request, or opened this socket, from another site (Origin
    host:port != Host).

    Browsers don't apply the same-origin policy to WebSockets, so any page could otherwise read
    every cluster's pods and logs; and any page can send a "simple" POST without asking first,
    so it could otherwise start a privileged node shell. Clients that send no Origin (CLI tools,
    tests) are not browsers. Every WebSocket route calls this and closes with 4403 before
    accepting; `CrossOriginWriteGuard` applies it to every write under /api.
    """
    origin = conn.headers.get("origin")
    if origin is None:
        return False
    host = (conn.headers.get("host") or "").lower()
    return not host or urlsplit(origin).netloc.lower() != host


class CrossOriginWriteGuard:
    """Answers 403 to a POST, PUT, PATCH or DELETE under /api sent from another origin, before
    any route sees it. Reads and WebSockets pass through (sockets check for themselves)."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and scope["method"] in WRITE_METHODS
            and (scope["path"] == "/api" or scope["path"].startswith("/api/"))
            and is_cross_origin(HTTPConnection(scope))
        ):
            refused = JSONResponse({"detail": "Cross-origin request refused"}, status_code=403)
            await refused(scope, receive, send)
            return
        await self.app(scope, receive, send)
