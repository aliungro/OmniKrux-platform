"""A pod and its events, turned into what `kubectl describe` shows, minus secret values."""

from datetime import UTC, datetime

from pydantic import BaseModel

from omnikrux.resources.rows import BAD_WAITING, StatusClass, pod_status

DEFAULT_PROBE_PERIOD = 10
PROBES = (
    ("liveness", "livenessProbe"),
    ("readiness", "readinessProbe"),
    ("startup", "startupProbe"),
)


class OwnerRef(BaseModel):
    kind: str
    name: str
    # The owner's `spec.selector.matchLabels` as "k=v,k2=v2", for "All pods' logs". None for an
    # owner without one (a Node, say), or when the owner couldn't be read.
    selector: str | None = None


class PodInfo(BaseModel):
    name: str
    namespace: str
    status: str
    status_class: StatusClass
    node: str | None
    pod_ip: str | None
    host_ip: str | None
    qos: str | None
    service_account: str | None
    owner: OwnerRef | None
    started_at: str | None
    resource_version: str


class EnvVar(BaseModel):
    name: str
    value: str | None  # always None for anything read from a Secret
    source: str | None


class ContainerInfo(BaseModel):
    name: str
    image: str
    state: str
    state_class: StatusClass
    ready: bool
    restarts: int
    last_state: str | None
    last_finished_at: str | None
    requests: dict[str, str]
    limits: dict[str, str]
    limit_hit: list[str]
    ports: list[str]
    probes: dict[str, str]
    env: list[EnvVar]
    mounts: list[str]


class Condition(BaseModel):
    type: str
    status: str  # "True" | "False" | "Unknown"
    reason: str | None
    message: str | None


class EventInfo(BaseModel):
    type: str  # "Warning" | "Normal"
    reason: str
    message: str
    count: int
    last_seen: str | None


class PodDescribe(BaseModel):
    pod: PodInfo
    containers: list[ContainerInfo]
    init_containers: list[ContainerInfo]
    ephemeral_containers: list[ContainerInfo]
    conditions: list[Condition]
    labels: dict[str, str]
    annotations: dict[str, str]
    events: list[EventInfo]
    events_error: str | None = None  # why `events` is empty when listing them failed


def describe_pod(pod: dict, events: list[dict]) -> PodDescribe:
    md = pod.get("metadata") or {}
    spec = pod.get("spec") or {}
    status = pod.get("status") or {}
    return PodDescribe(
        pod=_pod_info(pod),
        containers=_containers(spec.get("containers"), status.get("containerStatuses")),
        init_containers=_containers(
            spec.get("initContainers"), status.get("initContainerStatuses")
        ),
        ephemeral_containers=_containers(
            spec.get("ephemeralContainers"), status.get("ephemeralContainerStatuses")
        ),
        conditions=[
            Condition(
                type=c.get("type") or "",
                status=c.get("status") or "Unknown",
                reason=c.get("reason"),
                message=c.get("message"),
            )
            for c in status.get("conditions") or []
        ],
        labels=md.get("labels") or {},
        annotations=md.get("annotations") or {},
        events=_events(events),
    )


def _pod_info(pod: dict) -> PodInfo:
    md = pod.get("metadata") or {}
    spec = pod.get("spec") or {}
    status = pod.get("status") or {}
    label, status_class = pod_status(pod)
    owners = md.get("ownerReferences") or []
    owner = next((o for o in owners if o.get("controller")), owners[0] if owners else None)
    return PodInfo(
        name=md.get("name") or "",
        namespace=md.get("namespace") or "",
        status=label,
        status_class=status_class,
        node=spec.get("nodeName"),
        pod_ip=status.get("podIP"),
        host_ip=status.get("hostIP"),
        qos=status.get("qosClass"),
        service_account=spec.get("serviceAccountName"),
        owner=OwnerRef(kind=owner.get("kind") or "", name=owner.get("name") or "")
        if owner
        else None,
        started_at=status.get("startTime"),
        resource_version=md.get("resourceVersion") or "",
    )


def _containers(specs: list[dict] | None, statuses: list[dict] | None) -> list[ContainerInfo]:
    by_name = {s.get("name"): s for s in statuses or []}
    return [_container(c, by_name.get(c.get("name")) or {}) for c in specs or []]


def _container(spec: dict, status: dict) -> ContainerInfo:
    state, state_class = _state(status.get("state") or {}, bool(status.get("ready")))
    last = status.get("lastState") or {}
    terminations = [(status.get("state") or {}).get("terminated"), last.get("terminated")]
    resources = spec.get("resources") or {}
    return ContainerInfo(
        name=spec.get("name") or "",
        image=spec.get("image") or "",
        state=state,
        state_class=state_class,
        ready=bool(status.get("ready")),
        restarts=status.get("restartCount") or 0,
        last_state=_state(last, False)[0] if last else None,
        last_finished_at=(last.get("terminated") or {}).get("finishedAt"),
        requests={k: str(v) for k, v in (resources.get("requests") or {}).items()},
        limits={k: str(v) for k, v in (resources.get("limits") or {}).items()},
        limit_hit=["memory"]
        if any((t or {}).get("reason") == "OOMKilled" for t in terminations)
        else [],
        ports=[
            f"{p.get('containerPort')}/{p.get('protocol') or 'TCP'}"
            for p in spec.get("ports") or []
        ],
        probes={
            kind: _probe(spec[field]) for kind, field in PROBES if isinstance(spec.get(field), dict)
        },
        env=_env(spec),
        mounts=[
            f"{m.get('mountPath')} from {m.get('name')}{' (ro)' if m.get('readOnly') else ''}"
            for m in spec.get("volumeMounts") or []
        ],
    )


def _state(state: dict, ready: bool) -> tuple[str, StatusClass]:
    if (waiting := state.get("waiting")) is not None:
        reason = waiting.get("reason")
        if not reason:
            return "Waiting", "warn"
        return f"Waiting: {reason}", "bad" if reason in BAD_WAITING else "warn"
    if (terminated := state.get("terminated")) is not None:
        code = terminated.get("exitCode")
        reason = terminated.get("reason") or ("Completed" if code == 0 else "Error")
        text = f"Terminated: {reason}" + (f" (exit {code})" if code is not None else "")
        return text, "done" if code == 0 else "bad"
    if "running" in state:
        return "Running", "ok" if ready else "warn"
    return "Waiting", "warn"


def _probe(probe: dict) -> str:
    every = f"every {probe.get('periodSeconds') or DEFAULT_PROBE_PERIOD}s"
    if (http := probe.get("httpGet")) is not None:
        return f"GET :{http.get('port')}{http.get('path') or '/'} {every}"
    if (tcp := probe.get("tcpSocket")) is not None:
        return f"TCP :{tcp.get('port')} {every}"
    if (grpc := probe.get("grpc")) is not None:
        return f"gRPC :{grpc.get('port')} {every}"
    if (exec_ := probe.get("exec")) is not None:
        return f"exec {' '.join(exec_.get('command') or [])} {every}"
    return every


def _env(spec: dict) -> list[EnvVar]:
    out: list[EnvVar] = []
    for e in spec.get("env") or []:
        name = e.get("name") or ""
        ref = e.get("valueFrom")
        if not ref:
            out.append(EnvVar(name=name, value=e.get("value") or "", source=None))
            continue
        # A reference never carries a value to the browser, whatever else the entry holds.
        out.append(EnvVar(name=name, value=None, source=_env_source(ref)))
    for e in spec.get("envFrom") or []:
        if (secret := e.get("secretRef")) is not None:
            source = f"Secret {secret.get('name')}"
        elif (config := e.get("configMapRef")) is not None:
            source = f"ConfigMap {config.get('name')}"
        else:
            continue
        out.append(EnvVar(name="(all keys)", value=None, source=source))
    return out


def _env_source(ref: dict) -> str | None:
    if (secret := ref.get("secretKeyRef")) is not None:
        return f"Secret {secret.get('name')} key {secret.get('key')}"
    if (config := ref.get("configMapKeyRef")) is not None:
        return f"ConfigMap {config.get('name')} key {config.get('key')}"
    if (field := ref.get("fieldRef")) is not None:
        return f"Field {field.get('fieldPath')}"
    if (resource := ref.get("resourceFieldRef")) is not None:
        return f"Resource {resource.get('resource')}"
    return None


def _when(stamp: str | None) -> datetime | None:
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        moment = datetime.fromisoformat(stamp)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _latest(stamps: list[str | None]) -> str | None:
    known = [s for s in stamps if _when(s) is not None]
    return max(known, key=_when) if known else None


def _events(events: list[dict]) -> list[EventInfo]:
    """Group by (type, reason, message), summing counts; Warnings first, then newest first."""
    groups: dict[tuple[str, str, str], EventInfo] = {}
    for ev in events:
        key = (ev.get("type") or "Normal", ev.get("reason") or "", ev.get("message") or "")
        series = ev.get("series") or {}
        count = max(ev.get("count") or 0, series.get("count") or 0) or 1
        seen = _latest(
            [ev.get("lastTimestamp"), series.get("lastObservedTime"), ev.get("eventTime")]
        )
        if (group := groups.get(key)) is None:
            groups[key] = EventInfo(
                type=key[0], reason=key[1], message=key[2], count=count, last_seen=seen
            )
        else:
            group.count += count
            group.last_seen = _latest([group.last_seen, seen])
    never = datetime.min.replace(tzinfo=UTC)
    newest_first = sorted(groups.values(), key=lambda e: _when(e.last_seen) or never, reverse=True)
    return sorted(newest_first, key=lambda e: e.type != "Warning")  # stable: keeps newest first
