from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel

StatusClass = Literal["ok", "warn", "bad", "done"]

_BAD_WAITING = {
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
    created_at: datetime
    columns: dict[str, Any]


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(UTC)


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
            return reason, "bad" if reason in _BAD_WAITING else "warn"

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


def pod_row(pod: dict, cluster_id: str) -> ResourceRow:
    md = pod.get("metadata") or {}
    status = pod.get("status") or {}
    containers = status.get("containerStatuses") or []
    label, status_class = pod_status(pod)
    finished = [
        f
        for cs in containers
        if (f := (((cs.get("lastState") or {}).get("terminated")) or {}).get("finishedAt"))
    ]
    last_restart = max(finished, key=_parse_ts) if finished else None
    return ResourceRow(
        uid=md.get("uid", ""),
        cluster_id=cluster_id,
        kind="Pod",
        namespace=md.get("namespace"),
        name=md.get("name", ""),
        created_at=_parse_ts(md["creationTimestamp"]),
        columns={
            "status": label,
            "status_class": status_class,
            "ready": f"{sum(1 for cs in containers if cs.get('ready'))}/{len(containers)}",
            "restarts": sum(cs.get("restartCount", 0) for cs in containers),
            "node": (pod.get("spec") or {}).get("nodeName"),
            "last_restart_at": last_restart,
        },
    )
