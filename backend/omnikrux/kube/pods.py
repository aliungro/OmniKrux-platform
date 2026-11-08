"""A pod as the API returns it (plain JSON): reading it, and what its containers are doing."""

from kubernetes_asyncio.client import ApiClient, CoreV1Api

from omnikrux.kube.http import read_json

REQUEST_TIMEOUT = 15  # seconds for a call that answers at once: a hung cluster gets a plain answer
# (connect, read) for the log and exec sockets' calls; reading a whole log may take a while.
SLOW_REQUEST_TIMEOUT = (30, 120)
FINISHED_PHASES = ("Succeeded", "Failed")  # the pod's containers will not run again


async def read_pod(
    api: ApiClient, namespace: str, name: str, *, timeout: float | tuple[float, float]
) -> dict:
    """The pod; a non-2xx answer raises ApiException."""
    return await read_json(
        CoreV1Api(api).read_namespaced_pod(
            name, namespace, _preload_content=False, _request_timeout=timeout
        )
    )


def container_names(pod: dict) -> list[str]:
    return [c.get("name", "") for c in (pod.get("spec") or {}).get("containers") or []]


def any_container_names(pod: dict) -> list[str]:
    """Every container whose logs can be read: init, regular and ephemeral."""
    spec = pod.get("spec") or {}
    fields = ("initContainers", "containers", "ephemeralContainers")
    return [c.get("name", "") for field in fields for c in spec.get(field) or []]


def container_status(pod: dict, container: str) -> dict:
    """The container's entry in the pod's status (init, regular or ephemeral); {} if none yet."""
    status = pod.get("status") or {}
    fields = ("initContainerStatuses", "containerStatuses", "ephemeralContainerStatuses")
    for field in fields:
        for entry in status.get(field) or []:
            if entry.get("name") == container:
                return entry
    return {}


def state_words(state: dict) -> str:
    """How a container that isn't running is doing, in a word or two (Kubernetes' reason)."""
    if "waiting" in state:
        return (state["waiting"] or {}).get("reason") or "waiting"
    if "terminated" in state:
        return (state["terminated"] or {}).get("reason") or "terminated"
    return "not started"


def will_restart(pod: dict, container: str, terminated: dict) -> bool:
    """Whether the kubelet starts this terminated container again."""
    spec = pod.get("spec") or {}
    if any(c.get("name") == container for c in spec.get("ephemeralContainers") or []):
        return False
    exit_code = terminated.get("exitCode")
    for init in spec.get("initContainers") or []:
        if init.get("name") == container:
            if init.get("restartPolicy") == "Always":  # a native sidecar: always restarted,
                return True  # whatever the pod's own restart policy says
            if exit_code == 0:  # a completed init container never runs again
                return False
    policy = spec.get("restartPolicy", "Always")
    return policy == "Always" or (policy == "OnFailure" and exit_code != 0)


def pod_missing_message(namespace: str, pod: str) -> str:
    return (
        f"Pod {namespace}/{pod} not found. It may have been deleted; pick it again from the list."
    )
