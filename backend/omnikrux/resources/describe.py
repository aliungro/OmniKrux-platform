"""A pod and its events as structured details, minus secret values, with a
`Link` to each object it points at (owner, node, service account, env sources, volumes)."""

from datetime import UTC, datetime

from pydantic import BaseModel

from omnikrux.resources.kind_rows import known_kind_key
from omnikrux.resources.kinds import KINDS
from omnikrux.resources.rows import BAD_WAITING, StatusClass, pod_status

DEFAULT_PROBE_PERIOD = 10
PROBES = (
    ("liveness", "livenessProbe"),
    ("readiness", "readinessProbe"),
    ("startup", "startupProbe"),
)


class Link(BaseModel):
    """Where a click goes: an object of `kind_key` (None namespace: a cluster-scoped kind)."""

    kind_key: str
    namespace: str | None
    name: str


def link_to(kind_key: str | None, namespace: str | None, name: object) -> Link | None:
    """A link to `name` of `kind_key`, in `namespace` unless the kind is cluster-scoped; None
    when the kind or the name isn't known."""
    if kind_key is None or not isinstance(name, str) or not name:
        return None
    spec = KINDS.get(kind_key)
    cluster_scoped = spec is not None and not spec.namespaced
    return Link(kind_key=kind_key, namespace=None if cluster_scoped else namespace, name=name)


def owner_link(ref: dict, namespace: str | None) -> Link | None:
    """The link for an ownerReference or an involvedObject, when OmniKrux can name its kind."""
    key = known_kind_key(ref.get("apiVersion"), ref.get("kind"))
    return link_to(key, namespace, ref.get("name"))


def controller_of(obj: dict) -> dict | None:
    """The controlling ownerReference, else the first one."""
    refs = (obj.get("metadata") or {}).get("ownerReferences") or []
    owners = [o for o in refs if isinstance(o, dict)]
    return next((o for o in owners if o.get("controller")), owners[0] if owners else None)


class OwnerRef(BaseModel):
    kind: str
    name: str
    # The owner's `spec.selector.matchLabels` as "k=v,k2=v2", for "All pods' logs". None for an
    # owner without one (a Node, say), or when the owner couldn't be read.
    selector: str | None = None
    link: Link | None = None


class PodInfo(BaseModel):
    name: str
    namespace: str
    status: str
    status_class: StatusClass
    node: str | None
    node_link: Link | None
    pod_ip: str | None
    host_ip: str | None
    qos: str | None
    service_account: str | None
    service_account_link: Link | None
    owner: OwnerRef | None
    started_at: str | None
    resource_version: str


class EnvVar(BaseModel):
    name: str
    value: str | None  # a literal or the pod's namespace for a metadata.namespace reference
    source: str | None
    link: Link | None = None  # the ConfigMap or Secret it is read from


class Volume(BaseModel):
    name: str
    type: str  # the volume source's field: "configMap", "secret", "emptyDir", ...
    link: Link | None  # for configMap, secret and persistentVolumeClaim volumes


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
    volumes: list[Volume]
    conditions: list[Condition]
    labels: dict[str, str]
    annotations: dict[str, str]
    events: list[EventInfo]
    events_error: str | None = None  # why `events` is empty when listing them failed


def conditions_of(obj: dict) -> list[Condition]:
    return [
        Condition(
            type=c.get("type") or "",
            status=c.get("status") or "Unknown",
            reason=c.get("reason"),
            message=c.get("message"),
        )
        for c in (obj.get("status") or {}).get("conditions") or []
        if isinstance(c, dict)
    ]


def describe_pod(pod: dict, events: list[dict]) -> PodDescribe:
    md = pod.get("metadata") or {}
    spec = pod.get("spec") or {}
    status = pod.get("status") or {}
    namespace = md.get("namespace") or ""
    return PodDescribe(
        pod=_pod_info(pod),
        containers=_containers(spec.get("containers"), status.get("containerStatuses"), namespace),
        init_containers=_containers(
            spec.get("initContainers"), status.get("initContainerStatuses"), namespace
        ),
        ephemeral_containers=_containers(
            spec.get("ephemeralContainers"),
            status.get("ephemeralContainerStatuses"),
            namespace,
            ephemeral=True,
        ),
        volumes=_volumes(spec.get("volumes"), namespace),
        conditions=conditions_of(pod),
        labels=md.get("labels") or {},
        annotations=md.get("annotations") or {},
        events=group_events(events),
    )


# A volume source's field -> the kind it points at and the field that names the object.
VOLUME_LINKS = {
    "configMap": ("configmaps", "name"),
    "secret": ("secrets", "secretName"),
    "persistentVolumeClaim": ("persistentvolumeclaims", "claimName"),
}


def _volumes(volumes: list[dict] | None, namespace: str) -> list[Volume]:
    out = []
    for volume in volumes or []:
        if not isinstance(volume, dict):
            continue
        source = next((k for k in volume if k != "name"), "unknown")
        link = None
        if source in VOLUME_LINKS and isinstance(volume[source], dict):
            key, field = VOLUME_LINKS[source]
            link = link_to(key, namespace, volume[source].get(field))
        out.append(Volume(name=volume.get("name") or "", type=source, link=link))
    return out


def _pod_info(pod: dict) -> PodInfo:
    md = pod.get("metadata") or {}
    spec = pod.get("spec") or {}
    status = pod.get("status") or {}
    label, status_class = pod_status(pod)
    owner = controller_of(pod)
    namespace = md.get("namespace") or ""
    return PodInfo(
        name=md.get("name") or "",
        namespace=md.get("namespace") or "",
        status=label,
        status_class=status_class,
        node=spec.get("nodeName"),
        node_link=link_to("nodes", None, spec.get("nodeName")),
        pod_ip=status.get("podIP"),
        host_ip=status.get("hostIP"),
        qos=status.get("qosClass"),
        service_account=spec.get("serviceAccountName"),
        service_account_link=link_to("serviceaccounts", namespace, spec.get("serviceAccountName")),
        owner=OwnerRef(
            kind=owner.get("kind") or "",
            name=owner.get("name") or "",
            link=owner_link(owner, namespace),
        )
        if owner
        else None,
        started_at=status.get("startTime"),
        resource_version=md.get("resourceVersion") or "",
    )


def _containers(
    specs: list[dict] | None,
    statuses: list[dict] | None,
    namespace: str,
    *,
    ephemeral: bool = False,
) -> list[ContainerInfo]:
    by_name = {s.get("name"): s for s in statuses or []}
    return [
        _container(c, by_name.get(c.get("name")) or {}, namespace, ephemeral) for c in specs or []
    ]


def _container(spec: dict, status: dict, namespace: str, ephemeral: bool) -> ContainerInfo:
    # Ephemeral containers have no probes and never report ready: running is as good as it gets.
    healthy = ephemeral or bool(status.get("ready"))
    state, state_class = _state(status.get("state") or {}, healthy)
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
        env=_env(spec, namespace),
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
        reason = terminated.get("reason")  # said only when Kubernetes gives one
        text = "Terminated" + (f": {reason}" if reason else "")
        text += f" (exit {code})" if code is not None else ""
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


def _env(spec: dict, namespace: str) -> list[EnvVar]:
    out: list[EnvVar] = []
    for e in spec.get("env") or []:
        name = e.get("name") or ""
        ref = e.get("valueFrom")
        if not ref:
            out.append(EnvVar(name=name, value=e.get("value") or "", source=None))
            continue
        out.append(_env_reference(name, ref, namespace))
    for e in spec.get("envFrom") or []:
        if (secret := e.get("secretRef")) is not None:
            source = f"Secret {secret.get('name')}"
            link = link_to("secrets", namespace, secret.get("name"))
        elif (config := e.get("configMapRef")) is not None:
            source = f"ConfigMap {config.get('name')}"
            link = link_to("configmaps", namespace, config.get("name"))
        else:
            continue
        if prefix := e.get("prefix"):
            source += f" (prefix {prefix})"
        out.append(EnvVar(name="(all keys)", value=None, source=source, link=link))
    return out


def _env_reference(name: str, ref: dict, namespace: str) -> EnvVar:
    value, source, link = None, None, None
    if (secret := ref.get("secretKeyRef")) is not None:
        source = f"Secret {secret.get('name')} key {secret.get('key')}"
        link = link_to("secrets", namespace, secret.get("name"))
    elif (config := ref.get("configMapKeyRef")) is not None:
        source = f"ConfigMap {config.get('name')} key {config.get('key')}"
        link = link_to("configmaps", namespace, config.get("name"))
    elif (field := ref.get("fieldRef")) is not None:
        path = field.get("fieldPath")
        source = f"Field {path}"
        if path == "metadata.namespace":
            value = namespace or None
    elif (resource := ref.get("resourceFieldRef")) is not None:
        source = f"Resource {resource.get('resource')}"
    return EnvVar(name=name, value=value, source=source, link=link)


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


def group_events(events: list[dict]) -> list[EventInfo]:
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
