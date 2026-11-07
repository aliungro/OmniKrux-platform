import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect

from omnikrux.watch.hub import Subscription
from omnikrux.web_security import is_cross_origin

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket("/api/watch")
async def watch(websocket: WebSocket, kind: str) -> None:
    if is_cross_origin(websocket):
        await websocket.close(
            code=4403, reason="Cross-origin request refused"
        )  # before accept: HTTP 403
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
            await asyncio.wait(
                tasks
            )  # never raises the tasks' exceptions or swallows our cancellation
        for task in tasks:
            if (
                not task.cancelled()
                and (exc := task.exception())
                and not isinstance(exc, WebSocketDisconnect)
            ):
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
