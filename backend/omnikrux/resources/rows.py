from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel

from omnikrux.resources.quantity import parse_bytes, parse_cpu_m

StatusClass = Literal["ok", "warn", "bad", "done"]

BAD_WAITING = {
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "CreateContainerConfigError",
    "CreateContainerError",
    "InvalidImageName",
    "RunContainerError",
}


class ResourceRow(BaseModel):
    uid: str
    cluster_id: str
    kind: str
    namespace: str | None
    name: str
    created_at: datetime | None
    columns: dict[str, Any]
    labels: dict[str, str] = {}


def parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(UTC)


def base_row(obj: dict, cluster_id: str, kind: str) -> ResourceRow:
    """The row every kind can have: identity, age, labels and the resource version (the inspector
    reloads its details, and drops a revealed Secret value, when it changes); the caller adds its
    other columns."""
    md = obj.get("metadata") or {}
    return ResourceRow(
        uid=md.get("uid", ""),
        cluster_id=cluster_id,
        kind=kind,
        namespace=md.get("namespace"),
        name=md.get("name", ""),
        created_at=parse_ts(md["creationTimestamp"]) if md.get("creationTimestamp") else None,
        columns={"resource_version": md.get("resourceVersion")},
        labels=md.get("labels") or {},
    )


def pod_status(pod: dict) -> tuple[str, StatusClass]:
    if (pod.get("metadata") or {}).get("deletionTimestamp"):
        return "Terminating", "warn"
    status = pod.get("status") or {}

    for cs in status.get("initContainerStatuses") or []:
        state = cs.get("state") or {}
        reason = (state.get("waiting") or {}).get("reason")
        if reason and reason != "PodInitializing":
            return f"Init:{reason}", "bad"
        terminated = state.get("terminated")
        if terminated and terminated.get("exitCode", 0) != 0:
            return "Init:Error", "bad"

    containers = status.get("containerStatuses") or []
    for cs in containers:
        reason = ((cs.get("state") or {}).get("waiting") or {}).get("reason")
        if reason:
            return reason, "bad" if reason in BAD_WAITING else "warn"

    phase = status.get("phase")
    if phase != "Succeeded":
        for cs in containers:
            reason = ((cs.get("state") or {}).get("terminated") or {}).get("reason")
            if reason:
                return reason, "bad"

    if phase == "Succeeded":
        return "Completed", "done"
    if phase == "Failed":
        return status.get("reason") or "Failed", "bad"
    if phase == "Pending":
        return status.get("reason") or "Pending", "warn"
    if phase == "Running":
        if all(cs.get("ready") for cs in containers):
            return "Running", "ok"
        return "Not ready", "warn"
    return "Unknown", "warn"


def _quantity(value: Any, parse: Callable[[str], int]) -> int | None:
    try:
        return parse(value)
    except ValueError:
        return None


def _resources(pod: dict) -> dict[str, Any]:
    """Requests and limits summed over the regular containers (init containers run first and
    don't add up). A container without a request adds nothing; without a limit, the pod has no
    limit (None). A quantity that can't be read makes its sum None: never a made-up number."""
    containers = (pod.get("spec") or {}).get("containers") or []
    out: dict[str, Any] = {"images": [c["image"] for c in containers if c.get("image")]}
    for prefix, suffix, parse in (("cpu", "m", parse_cpu_m), ("memory", "b", parse_bytes)):
        for field in ("requests", "limits"):
            raw = [((c.get("resources") or {}).get(field) or {}).get(prefix) for c in containers]
            values = [None if v is None else _quantity(v, parse) for v in raw]
            if field == "requests":
                unreadable = any(v is None and r is not None for v, r in zip(values, raw))
                out[f"{prefix}_request_{suffix}"] = (
                    None if unreadable else sum(v or 0 for v in values)
                )
            else:
                out[f"{prefix}_limit_{suffix}"] = (
                    None if not values or None in values else sum(values)
                )
    return out


def container_states(pod: dict) -> list[dict]:
    """Spec-ordered container health, with ordinary init containers only while active."""
    spec, status = pod.get("spec") or {}, pod.get("status") or {}
    result = []
    for init, spec_key, status_key in (
        (True, "initContainers", "initContainerStatuses"),
        (False, "containers", "containerStatuses"),
    ):
        statuses = {cs.get("name"): cs for cs in status.get(status_key) or []}
        for container in spec.get(spec_key) or []:
            name = container["name"]
            cs = statuses.get(name) or {}
            state = cs.get("state") or {}
            label, reason = "waiting", None
            sidecar = init and container.get("restartPolicy") == "Always"
            if "running" in state:
                label = "ready" if cs.get("ready") and (not init or sidecar) else "running"
            elif "waiting" in state:
                reason = (state["waiting"] or {}).get("reason")
                label = "failing" if reason in BAD_WAITING else "waiting"
            elif "terminated" in state:
                terminated = state["terminated"] or {}
                code = terminated.get("exitCode", 0)
                label = "done" if code == 0 else "failing"
                reason = terminated.get("reason") or (
                    "Completed" if code == 0 else f"Exit code {code}"
                )
            if init and not sidecar and label not in {"running", "failing"}:
                continue
            result.append(
                {
                    "name": name,
                    "init": init,
                    "state": label,
                    "reason": reason,
                    "restarts": cs.get("restartCount") or 0,
                }
            )
    return result


def pod_row(pod: dict, cluster_id: str) -> ResourceRow:
    status = pod.get("status") or {}
    containers = status.get("containerStatuses") or []
    label, status_class = pod_status(pod)
    finished = [
        f
        for cs in containers
        if (f := (((cs.get("lastState") or {}).get("terminated")) or {}).get("finishedAt"))
    ]
    last_restart = max(finished, key=parse_ts) if finished else None
    row = base_row(pod, cluster_id, "Pod")
    row.columns.update(
        {
            "status": label,
            "status_class": status_class,
            "ready": f"{sum(1 for cs in containers if cs.get('ready'))}/{len(containers)}",
            "restarts": sum((cs.get("restartCount") or 0) for cs in containers),
            "node": (pod.get("spec") or {}).get("nodeName"),
            "last_restart_at": last_restart,
            "containers": container_states(pod),
            **_resources(pod),
        }
    )
    return row
