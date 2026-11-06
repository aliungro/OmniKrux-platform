"""Checks shared by every browser-facing route."""

from urllib.parse import urlsplit

from starlette.requests import HTTPConnection


def is_cross_origin(websocket: HTTPConnection) -> bool:
    """True when a browser opened this socket from another site (Origin host:port != Host).

    Browsers don't apply the same-origin policy to WebSockets, so any page could otherwise read
    every cluster's pods and logs. Clients that send no Origin (CLI tools, tests) are not browsers.
    Every WebSocket route calls this and closes with 4403 before accepting.
    """
    origin = websocket.headers.get("origin")
    if origin is None:
        return False
    host = (websocket.headers.get("host") or "").lower()
    return not host or urlsplit(origin).netloc.lower() != host
