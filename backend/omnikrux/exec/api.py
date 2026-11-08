"""WS /api/exec: an interactive shell in a pod's container."""

import asyncio
import contextlib
import json
import logging
from contextlib import AsyncExitStack
from typing import Annotated

from fastapi import APIRouter, Query, WebSocket

from omnikrux.actions import authz
from omnikrux.actions.authz import NotAllowed
from omnikrux.audit.store import (
    AuditEntry,
    AuditLog,
    AuditUnavailable,
    actor_of,
    no_audit_message,
)
from omnikrux.exec.debug import (
    NSENTER,
    delete_node_shell_pod,
    failure_words,
    finish_even_if_cancelled,
    is_node_shell,
)
from omnikrux.exec.session import BROWSER_GONE, ExecBridge, KubeExecChannel, SessionEnd
from omnikrux.kube.connections import ClusterConnections, kube_error_message
from omnikrux.kube.http import KUBE_ERRORS
from omnikrux.kube.pods import (
    SLOW_REQUEST_TIMEOUT,
    any_container_names,
    container_names,
    container_status,
    pod_missing_message,
    read_pod,
    state_words,
)
from omnikrux.web_security import is_cross_origin

log = logging.getLogger(__name__)

router = APIRouter()

# bash when the image has it, else sh.
DEFAULT_COMMAND = ["/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"]
CONSOLE_STOPPED = SessionEnd("ended", "The console closed the shell.")


class ExecRefused(Exception):
    """The shell can't be opened; `message` says why in plain words."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


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
            f"Can't open a shell: container {container} isn't running ({state_words(state)}). "
            "Start a debug container to look inside the pod."
        )
    return container


async def _read_pod(
    connections: ClusterConnections, cluster: str, namespace: str, pod: str
) -> dict:
    """The pod to exec into. Unknown cluster: KeyError; otherwise ExecRefused."""
    async with AsyncExitStack() as stack:
        try:
            api = await stack.enter_async_context(connections.api(cluster))
        except KeyError:
            raise
        except Exception as exc:  # e.g. a missing exec plugin, said in words
            raise ExecRefused(kube_error_message(exc, "connect to the cluster")) from exc
        try:
            return await read_pod(api, namespace, pod, timeout=SLOW_REQUEST_TIMEOUT)
        except KUBE_ERRORS as exc:
            if getattr(exc, "status", None) == 404:
                raise ExecRefused(pod_missing_message(namespace, pod)) from exc
            raise ExecRefused(kube_error_message(exc, f"read pod {namespace}/{pod}")) from exc


async def _open_channel(
    connections: ClusterConnections,
    cluster: str,
    namespace: str,
    pod: str,
    container: str,
    command: list[str],
) -> KubeExecChannel:
    """Unknown cluster: KeyError; otherwise ExecRefused."""
    try:
        return await KubeExecChannel.open(connections, cluster, namespace, pod, container, command)
    except KeyError:
        raise
    except Exception as exc:  # refused, unreachable, or a missing exec plugin
        if not isinstance(exc, KUBE_ERRORS):
            log.warning("exec failed to open", exc_info=exc)
        action = f"open a shell in pod {namespace}/{pod}"
        raise ExecRefused(kube_error_message(exc, action)) from exc


async def _delete_node_shell(
    connections: ClusterConnections, audit: AuditLog, cluster: str, namespace: str, pod: str
) -> None:
    """Delete the node-shell pod and finish its `node_shell` audit record (begun when the pod
    was created) with how that went."""
    where = {"action": "node_shell", "cluster_id": cluster, "namespace": namespace, "name": pod}
    try:
        async with connections.api(cluster) as api:
            deleted = await delete_node_shell_pod(api, namespace, pod)
    except Exception as exc:  # noqa: BLE001 (it stops by itself after its deadline anyway)
        log.warning(
            "Could not delete node-shell pod %s/%s (%s)", namespace, pod, failure_words(exc)
        )
        message = kube_error_message(exc, f"delete node-shell pod {namespace}/{pod}")
        await audit.finish_open(**where, outcome="failed", message=message)
        return
    if deleted:
        log.info("node-shell pod deleted cluster=%s ns=%s pod=%s", cluster, namespace, pod)
        await audit.finish_open(**where, outcome="ended", message="Pod deleted")
    else:
        log.info(
            "node-shell pod cleanup: nothing matched cluster=%s ns=%s pod=%s "
            "(already gone, or not a node-shell pod)",
            cluster,
            namespace,
            pod,
        )
        await audit.finish_open(**where, outcome="ended", message="No pod was left to delete")


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
    cleanup_pod: bool = False,
) -> None:
    """`cleanup_pod`: delete the pod when the session ends, however it ends (node-shell pods
    only). Without `command`, a node-shell pod gets a shell on the node (`NSENTER`), any other
    pod `DEFAULT_COMMAND`."""
    if is_cross_origin(websocket):
        await websocket.close(code=4403, reason="Cross-origin request refused")  # HTTP 403
        return
    await websocket.accept()
    container = container or None
    if not namespace or not pod or (command is not None and not all(command)):
        await _fail(websocket, "Choose a namespace and a pod (and no empty command words).", 1008)
        return
    connections: ClusterConnections = websocket.app.state.connections
    audit: AuditLog = websocket.app.state.audit
    actor = actor_of(websocket)
    cleanup = cleanup_pod
    try:
        try:
            await authz.authorize(actor, "shell", cluster, namespace, "pods", pod)
        except NotAllowed as exc:  # a node-shell pod asked to be cleaned up still goes
            await _fail(websocket, exc.message, 4403)
            return
        try:
            found = await _read_pod(connections, cluster, namespace, pod)
        except KeyError:
            cleanup = False  # no such cluster: nothing to delete there
            await _fail(websocket, "Unknown cluster", 4404, reason="Unknown cluster")
            return
        except ExecRefused as exc:  # the delete below still only matches a node-shell pod
            await _fail(websocket, exc.message, 1011)
            return
        if cleanup_pod and not is_node_shell(found):
            cleanup = False
            message = (
                "Only node-shell pods are deleted when their session ends, "
                f"and pod {namespace}/{pod} isn't one. Open the shell without cleanup."
            )
            await _fail(websocket, message, 1008)
            return
        command = command or (NSENTER if is_node_shell(found) else DEFAULT_COMMAND)
        entry = AuditEntry(
            actor=actor,
            action="shell",
            cluster_id=cluster,
            namespace=namespace,
            kind="pods",
            name=pod,
        )
        await _session(websocket, connections, audit, entry, found, container, command)
    finally:
        if cleanup:  # whichever side closed, or if the session failed or was cancelled
            await finish_even_if_cancelled(
                _delete_node_shell(connections, audit, cluster, namespace, pod)
            )


async def _session(
    websocket: WebSocket,
    connections: ClusterConnections,
    audit: AuditLog,
    entry: AuditEntry,
    found: dict,
    container: str | None,
    command: list[str],
) -> None:
    """Open the shell in the read pod and relay until it ends; a refusal is sent as an error.

    The record is written before the channel opens, because opening it starts `command` in the
    container: no audit, no change. What is typed is not recorded."""
    cluster, namespace, pod = entry.cluster_id, entry.namespace or "", entry.name or ""
    try:
        container = running_container(found, pod, container)
    except ExecRefused as exc:  # nothing was started: no record
        await _fail(websocket, exc.message, 1011)
        return
    entry.details = {"container": container, "command": command}
    try:
        audit_id = await audit.begin(entry)
    except AuditUnavailable as exc:
        await _fail(websocket, no_audit_message(exc), 1011)
        return
    try:
        channel = await _open_channel(connections, cluster, namespace, pod, container, command)
    except KeyError:
        await audit.finish(audit_id, "failed", "Unknown cluster")
        await _fail(websocket, "Unknown cluster", 4404, reason="Unknown cluster")
        return
    except ExecRefused as exc:
        await audit.finish(audit_id, "failed", exc.message)
        await _fail(websocket, exc.message, 1011)
        return
    except BaseException:  # cancelled while opening: the console is stopping
        await finish_even_if_cancelled(
            audit.finish(audit_id, CONSOLE_STOPPED.outcome, CONSOLE_STOPPED.message)
        )
        raise
    where = f"cluster={cluster} ns={namespace} pod={pod} container={container}"
    log.info("exec opened %s", where)
    try:
        end = await ExecBridge(channel).run(websocket)
    except asyncio.CancelledError:  # the console is stopping
        end = CONSOLE_STOPPED
        raise
    except Exception as exc:
        end = SessionEnd("failed", f"The shell session failed ({type(exc).__name__}).")
        raise
    finally:
        log.info("exec closed %s", where)
        await finish_even_if_cancelled(audit.finish(audit_id, end.outcome, end.message))
