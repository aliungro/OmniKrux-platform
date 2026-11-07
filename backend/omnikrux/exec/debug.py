"""Ephemeral debug containers and node shells: the pods and containers a shell is opened into
when the pod's own containers can't be used, or when the node itself is the thing to look at.

Both wait (polling the pod) until the new container is running, so the browser can open the
shell straight away. A node-shell pod that never starts is deleted again; one that does is
deleted when its shell session ends (see `exec.api`), and stops by itself after an hour."""

import asyncio
import logging
import secrets
import string
from collections.abc import Awaitable

from kubernetes_asyncio.client import ApiClient, CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.kube.http import read_json
from omnikrux.logs.stream import FINISHED_PHASES, container_status, state_words

log = logging.getLogger(__name__)

START_SECONDS = 60  # how long a new container may take to start
POLL_SECONDS = 0.5  # between reads of the pod while it starts
REQUEST_TIMEOUT = 15  # seconds per Kubernetes call

NODE_SHELL_NAMESPACE = "default"
NODE_SHELL_CONTAINER = "shell"
NODE_SHELL_LABEL = "omnikrux.dev/node-shell"
NODE_SHELL_DEADLINE = 3600  # seconds: the pod stops by itself even if nobody deletes it
# Into the host's mount, UTS, IPC, network and PID namespaces, through PID 1 (hostPID).
NSENTER = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh"]
STRATEGIC_MERGE = "application/strategic-merge-patch+json"
_SUFFIX_ALPHABET = string.ascii_lowercase + string.digits


class DebugError(Exception):
    """The container didn't start; `message` says why in plain words."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _suffix() -> str:
    return "".join(secrets.choice(_SUFFIX_ALPHABET) for _ in range(5))


def is_node_shell(pod: dict) -> bool:
    return ((pod.get("metadata") or {}).get("labels") or {}).get(NODE_SHELL_LABEL) == "true"


async def _read_pod(api: ApiClient, namespace: str, name: str) -> dict:
    return await read_json(
        CoreV1Api(api).read_namespaced_pod(
            name, namespace, _preload_content=False, _request_timeout=REQUEST_TIMEOUT
        )
    )


async def _wait_running(
    api: ApiClient, namespace: str, pod: str, container: str, what: str, timeout: float
) -> None:
    """Poll until `container` runs. DebugError if it stops first or takes longer than `timeout`."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        found = await _read_pod(api, namespace, pod)
        state = container_status(found, container).get("state") or {}
        if "running" in state:
            return
        phase = (found.get("status") or {}).get("phase")
        if "terminated" in state or phase in FINISHED_PHASES:
            words = state_words(state) if state else (found["status"].get("reason") or phase)
            raise DebugError(f"The {what} stopped before it started ({words}).")
        left = deadline - loop.time()
        if left <= 0:
            raise DebugError(
                f"The {what} didn't start within {timeout:g} s (last state: {state_words(state)})."
            )
        await asyncio.sleep(min(POLL_SECONDS, left))


async def add_debug_container(
    api: ApiClient,
    ns: str,
    pod: str,
    *,
    target: str | None,
    image: str,
    timeout: float | None = None,
) -> str:
    """Add an ephemeral `sh` container to the pod (sharing `target`'s process namespace when
    given), wait until it runs and return its name. It can't be removed again."""
    name = f"debug-{_suffix()}"
    container = {"name": name, "image": image, "command": ["sh"], "stdin": True, "tty": True}
    if target:
        container["targetContainerName"] = target
    # A strategic merge patch merges by name, so only the new container is sent (as kubectl
    # does); a JSON merge patch would replace the list.
    await read_json(
        CoreV1Api(api).patch_namespaced_pod_ephemeralcontainers(
            pod,
            ns,
            {"spec": {"ephemeralContainers": [container]}},
            _content_type=STRATEGIC_MERGE,
            _preload_content=False,
            _request_timeout=REQUEST_TIMEOUT,
        )
    )
    await _wait_running(api, ns, pod, name, "debug container", _timeout(timeout))
    return name


def node_shell_pod(name: str, node: str, image: str) -> dict:
    return {
        "apiVersion": "v1",
        "kind": "Pod",
        "metadata": {
            "name": name,
            "namespace": NODE_SHELL_NAMESPACE,
            "labels": {"app.kubernetes.io/managed-by": "omnikrux", NODE_SHELL_LABEL: "true"},
        },
        "spec": {
            "nodeName": node,
            "hostPID": True,
            "hostNetwork": True,
            "restartPolicy": "Never",
            "activeDeadlineSeconds": NODE_SHELL_DEADLINE,
            "tolerations": [{"operator": "Exists"}],
            "containers": [
                {
                    "name": NODE_SHELL_CONTAINER,
                    "image": image,
                    "securityContext": {"privileged": True},
                    "command": NSENTER,
                    "stdin": True,
                    "tty": True,
                }
            ],
        },
    }


async def create_node_shell_pod(
    api: ApiClient, node: str, *, image: str, timeout: float | None = None
) -> tuple[str, str, str]:
    """Start a privileged pod on `node` with a shell in the host's namespaces; wait until it runs
    and return (namespace, pod, container). If it doesn't start (or the wait is cancelled), the
    pod is deleted again."""
    name = f"omnikrux-node-shell-{_suffix()}"
    await read_json(
        CoreV1Api(api).create_namespaced_pod(
            NODE_SHELL_NAMESPACE,
            node_shell_pod(name, node, image),
            _preload_content=False,
            _request_timeout=REQUEST_TIMEOUT,
        )
    )
    try:
        await _wait_running(
            api, NODE_SHELL_NAMESPACE, name, NODE_SHELL_CONTAINER, "node shell", _timeout(timeout)
        )
    except BaseException:
        await finish_even_if_cancelled(_delete_quietly(api, NODE_SHELL_NAMESPACE, name))
        raise
    return NODE_SHELL_NAMESPACE, name, NODE_SHELL_CONTAINER


async def delete_pod(api: ApiClient, ns: str, name: str) -> None:
    """Delete the pod; one that is already gone is fine."""
    try:
        await read_json(
            CoreV1Api(api).delete_namespaced_pod(
                name, ns, _preload_content=False, _request_timeout=REQUEST_TIMEOUT
            )
        )
    except ApiException as exc:
        if exc.status != 404:
            raise


async def _delete_quietly(api: ApiClient, ns: str, name: str) -> None:
    try:
        await delete_pod(api, ns, name)
    except Exception as exc:  # noqa: BLE001 (it stops by itself after the deadline anyway)
        log.warning("Could not delete node-shell pod %s/%s (%s)", ns, name, type(exc).__name__)


async def finish_even_if_cancelled(work: Awaitable[None]) -> None:
    """Run `work` to the end even if the caller is cancelled meanwhile (a cleanup must not be
    cut short); a cancellation that arrived is raised once it is done."""
    task = asyncio.ensure_future(work)
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.done():  # the work itself was cancelled (the loop is closing)
                raise
            cancelled = True
    task.result()
    if cancelled:
        raise asyncio.CancelledError


def _timeout(timeout: float | None) -> float:
    return START_SECONDS if timeout is None else timeout
