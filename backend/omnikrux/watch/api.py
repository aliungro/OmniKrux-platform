import asyncio
import json
import logging
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from omnikrux.watch.hub import Subscription

logger = logging.getLogger(__name__)

router = APIRouter()


def _cross_origin(websocket: WebSocket) -> bool:
    """True when a browser opened this socket from another site (Origin host:port != Host).

    Browsers don't apply the same-origin policy to WebSockets, so any page could otherwise read
    every cluster's pods. Clients that send no Origin (CLI tools, tests) are not browsers.
    """
    origin = websocket.headers.get("origin")
    if origin is None:
        return False
    host = (websocket.headers.get("host") or "").lower()
    return not host or urlsplit(origin).netloc.lower() != host


@router.websocket("/api/watch")
async def watch(websocket: WebSocket, kind: str) -> None:
    if _cross_origin(websocket):
        await websocket.close(code=4403, reason="Cross-origin request refused")  # before accept: HTTP 403
        return
    await websocket.accept()
    try:
        sub = await websocket.app.state.hub.subscribe(kind)
    except KeyError:
        await websocket.close(code=4404, reason="Unknown kind")
        return
    try:
        sender = asyncio.create_task(_send_all(websocket, sub))
        receiver = asyncio.create_task(_until_disconnect(websocket))
        tasks = (sender, receiver)
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.wait(tasks)  # never raises the tasks' exceptions or swallows our cancellation
        for task in tasks:
            if not task.cancelled() and (exc := task.exception()) and not isinstance(exc, WebSocketDisconnect):
                logger.warning("watch socket for %s failed", kind, exc_info=exc)
    finally:
        await sub.close()


async def _send_all(websocket: WebSocket, sub: Subscription) -> None:
    async for msg in sub:
        await websocket.send_text(json.dumps(msg))


async def _until_disconnect(websocket: WebSocket) -> None:
    """Return once the client goes away; incoming messages are ignored."""
    while (await websocket.receive())["type"] != "websocket.disconnect":
        pass
