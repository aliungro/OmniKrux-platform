"""WS /api/exec: an interactive shell in a pod's container."""

import contextlib
import json
import logging
from contextlib import AsyncExitStack
from typing import Annotated

from fastapi import APIRouter, Query, WebSocket
from kubernetes_asyncio.client import CoreV1Api

from omnikrux.exec.session import BROWSER_GONE, ExecBridge, KubeExecChannel
from omnikrux.kube.connections import ClusterConnections, kube_error_message
from omnikrux.kube.http import read_json
from omnikrux.logs.stream import (
    KUBE_ERRORS,
    REQUEST_TIMEOUT,
    any_container_names,
    container_names,
    container_status,
    pod_missing_message,
)
from omnikrux.web_security import is_cross_origin

log = logging.getLogger(__name__)

router = APIRouter()

# bash when the image has it, else sh.
DEFAULT_COMMAND = ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"]


class ExecRefused(Exception):
    """The shell can't be opened; `message` says why in plain words."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _state_words(state: dict) -> str:
    """How a container that isn't running is doing, in a word or two (Kubernetes' reason)."""
    if "waiting" in state:
        return (state["waiting"] or {}).get("reason") or "waiting"
    if "terminated" in state:
        return (state["terminated"] or {}).get("reason") or "terminated"
    return "not started"


def running_container(found: dict, pod: str, container: str | None) -> str:
    """The container to open the shell in: `container`, or the pod's first one. ExecRefused
    when it isn't in the pod or isn't running."""
    if container is None:
        regular = container_names(found)
        if not regular:
            raise ExecRefused(f"Pod {pod} has no containers.")
        container = regular[0]
    elif container not in any_container_names(found):
        raise ExecRefused(f"Container {container} isn't in pod {pod}.")
    state = container_status(found, container).get("state") or {}
    if "running" not in state:
        raise ExecRefused(
            f"Can't open a shell: container {container} isn't running ({_state_words(state)}). "
            "Start a debug container to look inside the pod."
        )
    return container


async def _check_pod(
    connections: ClusterConnections, cluster: str, namespace: str, pod: str, container: str | None
) -> str:
    """The running container to exec into. Unknown cluster: KeyError; otherwise ExecRefused."""
    async with AsyncExitStack() as stack:
        try:
            api = await stack.enter_async_context(connections.api(cluster))
        except KeyError:
            raise
        except Exception as exc:  # e.g. a missing exec plugin, said in words
            raise ExecRefused(kube_error_message(exc, "connect to the cluster")) from exc
        try:
            found = await read_json(
                CoreV1Api(api).read_namespaced_pod(
                    pod, namespace, _preload_content=False, _request_timeout=REQUEST_TIMEOUT
                )
            )
        except KUBE_ERRORS as exc:
            if getattr(exc, "status", None) == 404:
                raise ExecRefused(pod_missing_message(namespace, pod)) from exc
            raise ExecRefused(kube_error_message(exc, f"read pod {namespace}/{pod}")) from exc
    return running_container(found, pod, container)


async def _fail(websocket: WebSocket, message: str, code: int, reason: str | None = None) -> None:
    with contextlib.suppress(*BROWSER_GONE):  # the browser may already have left
        await websocket.send_text(json.dumps({"type": "error", "message": message}))
        await websocket.close(code=code, reason=reason)


@router.websocket("/api/exec")
async def exec_shell(
    websocket: WebSocket,
    cluster: str,
    namespace: str,
    pod: str,
    container: str | None = None,
    command: Annotated[list[str] | None, Query()] = None,
) -> None:
    if is_cross_origin(websocket):
        await websocket.close(code=4403, reason="Cross-origin request refused")  # HTTP 403
        return
    await websocket.accept()
    container = container or None
    command = command or DEFAULT_COMMAND
    if not namespace or not pod or not all(command):
        await _fail(websocket, "Choose a namespace and a pod (and no empty command words).", 1008)
        return
    connections: ClusterConnections = websocket.app.state.connections
    try:
        container = await _check_pod(connections, cluster, namespace, pod, container)
        try:
            channel = await KubeExecChannel.open(
                connections, cluster, namespace, pod, container, command
            )
        except KeyError:
            raise
        except Exception as exc:  # refused, unreachable, or a missing exec plugin
            if not isinstance(exc, KUBE_ERRORS):
                log.warning("exec failed to open", exc_info=exc)
            action = f"open a shell in pod {namespace}/{pod}"
            raise ExecRefused(kube_error_message(exc, action)) from exc
    except KeyError:
        await _fail(websocket, "Unknown cluster", 4404, reason="Unknown cluster")
        return
    except ExecRefused as exc:
        await _fail(websocket, exc.message, 1011)
        return
    where = f"cluster={cluster} ns={namespace} pod={pod} container={container}"
    log.info("exec opened %s", where)
    try:
        await ExecBridge(channel).run(websocket)
    finally:
        log.info("exec closed %s", where)
