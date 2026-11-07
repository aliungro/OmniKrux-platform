"""Any object and its events, turned into what the inspector shows: fields, compact tables
(sections) and conditions, with a `Link` to each object it points at.

`describe_resource` is pure: the route reads the object, its events and the lists that
`related_lists` names (a deployment's replica sets and pods, a node's pods, a service's endpoint
slices) and hands them in. A Secret is described by its key names and sizes only: no value, plain
or base64, and not the last-applied annotation that holds them."""

from dataclasses import dataclass

from pydantic import BaseModel

from omnikrux.resources.describe import (
    Condition,
    EventInfo,
    Link,
    conditions_of,
    controller_of,
    group_events,
    link_to,
    owner_link,
)
from omnikrux.resources.kind_rows import known_kind_key
from omnikrux.resources.kinds import KindSpec
from omnikrux.resources.rows import StatusClass, pod_row
from omnikrux.resources.yaml_out import (
    is_secret_object,
    is_secret_resource,
    mask_secret,
    value_size,
)

GENERIC_NOTE = "The YAML tab shows the full object."
PODS = "pods"
REPLICASETS = "replicasets.apps"
ENDPOINT_SLICES = "endpointslices.discovery.k8s.io"
SERVICE_NAME_LABEL = "kubernetes.io/service-name"
ROLE_PREFIX = "node-role.kubernetes.io/"


class Field(BaseModel):
    label: str
    value: str | None
    link: Link | None = None


class Cell(BaseModel):
    text: str | None
    link: Link | None = None
    cls: StatusClass | None = None


class Section(BaseModel):
    title: str
    columns: list[str]
    rows: list[list[Cell]]
    note: str | None = None  # why there are no rows, or where to look instead


class SecretKey(BaseModel):
    key: str
    size: int  # bytes of the decoded value


class ResourceDescribe(BaseModel):
    kind_key: str
    kind: str
    name: str
    namespace: str | None
    uid: str
    resource_version: str
    created_at: str | None
    fields: list[Field]
    sections: list[Section]
    conditions: list[Condition]
    labels: dict[str, str]
    annotations: dict[str, str]
    owner: Link | None
    events: list[EventInfo]
    events_error: str | None = None  # why `events` is empty when listing them failed
    secret_keys: list[SecretKey] | None = None  # Secrets only: names and sizes, never values


# --- what to read besides the object -------------------------------------------------------


@dataclass(frozen=True)
class RelatedList:
    key: str  # the kind key the items go under in `related`
    path: str  # the collection to GET
    params: tuple[tuple[str, str], ...]
    what: str  # the words for a failure: "list pods in demo"


def _resource(spec: KindSpec) -> tuple[str, str]:
    return spec.group, spec.plural


WORKLOADS = {
    ("apps", "deployments"),
    ("apps", "statefulsets"),
    ("apps", "daemonsets"),
    ("apps", "replicasets"),
}


def match_labels(obj: dict) -> str | None:
    """The object's `spec.selector` as a label selector ("k=v,k2=v2"); None when it can't be said
    that way (matchExpressions) or is empty."""
    selector = (obj.get("spec") or {}).get("selector") or {}
    labels = selector.get("matchLabels") or {}
    if not isinstance(labels, dict) or not labels or selector.get("matchExpressions"):
        return None
    return ",".join(f"{k}={v}" for k, v in labels.items())


def related_lists(spec: KindSpec, obj: dict) -> list[RelatedList]:
    """The lists `describe_resource` needs for this object, read through the same client.
    Label selectors only narrow what is read: ownership is checked on what comes back."""
    md = obj.get("metadata") or {}
    namespace, name = md.get("namespace") or "", md.get("name") or ""
    resource = _resource(spec)
    if resource in WORKLOADS:
        selector = match_labels(obj)
        params = (("labelSelector", selector),) if selector else ()
        keys = (REPLICASETS, PODS) if resource == ("apps", "deployments") else (PODS,)
        paths = {
            REPLICASETS: f"/apis/apps/v1/namespaces/{namespace}/replicasets",
            PODS: f"/api/v1/namespaces/{namespace}/pods",
        }
        plural = {REPLICASETS: "replica sets", PODS: "pods"}
        return [RelatedList(k, paths[k], params, f"list {plural[k]} in {namespace}") for k in keys]
    if resource == ("", "nodes"):
        params = (("fieldSelector", f"spec.nodeName={name}"),)
        return [RelatedList(PODS, "/api/v1/pods", params, f"list the pods on {name}")]
    if resource == ("", "services"):
        params = (("labelSelector", f"{SERVICE_NAME_LABEL}={name}"),)
        path = f"/apis/discovery.k8s.io/v1/namespaces/{namespace}/endpointslices"
        return [RelatedList(ENDPOINT_SLICES, path, params, f"list endpoint slices in {namespace}")]
    return []


def event_uids(spec: KindSpec, obj: dict) -> list[str]:
    """The `involvedObject.uid`s of the object's events. The kubelet records a node's events
    under the node's name, so a node is asked for by both."""
    md = obj.get("metadata") or {}
    uids = [md.get("uid") or ""]
    if _resource(spec) == ("", "nodes") and md.get("name"):
        uids.append(md["name"])
    return [u for u in dict.fromkeys(uids) if u]


# --- describe -------------------------------------------------------------------------------


def describe_resource(
    spec: KindSpec,
    obj: dict,
    events: list[dict],
    related: dict[str, list[dict]],
    related_errors: dict[str, str] | None = None,
) -> ResourceDescribe:
    """What the inspector shows for `obj` of `spec`. `related` holds the lists `related_lists`
    names, by key; a list that couldn't be read is in `related_errors` (its words) instead."""
    secret = is_secret_resource(spec) or is_secret_object(obj)
    shown = mask_secret(obj) if secret else obj  # no value, and no last-applied annotation
    md = shown.get("metadata") or {}
    namespace = md.get("namespace") if spec.namespaced else None
    owner_ref = controller_of(shown)
    owner = owner_link(owner_ref, namespace) if owner_ref else None
    fields = []
    if owner_ref:
        text = f"{owner_ref.get('kind') or ''} {owner_ref.get('name') or ''}".strip()
        fields.append(Field(label="Controlled by", value=text or None, link=owner))
    ctx = _Context(_resource(spec), namespace or "", related, related_errors or {})
    describer = _DESCRIBERS.get(ctx.resource, _generic)
    extra_fields, sections = describer(shown, ctx)
    return ResourceDescribe(
        kind_key=spec.key,
        kind=spec.kind,
        name=md.get("name") or "",
        namespace=namespace,
        uid=md.get("uid") or "",
        resource_version=md.get("resourceVersion") or "",
        created_at=md.get("creationTimestamp"),
        fields=fields + extra_fields,
        sections=sections,
        conditions=conditions_of(shown),
        labels=md.get("labels") or {},
        annotations=md.get("annotations") or {},
        owner=owner,
        events=group_events(events),
        secret_keys=_secret_keys(obj) if secret else None,
    )


@dataclass
class _Context:
    resource: tuple[str, str]  # (group, plural)
    namespace: str
    related: dict[str, list[dict]]
    errors: dict[str, str]

    def items(self, key: str) -> list[dict]:
        return [i for i in self.related.get(key) or [] if isinstance(i, dict)]

    def note(self, key: str, empty: str) -> str | None:
        """A section's note: why its list couldn't be read, else `empty` (shown when no rows)."""
        return self.errors.get(key, empty)


def _text(value: object) -> str | None:
    return None if value is None or value == "" else str(value)


def _count(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _uid(obj: dict) -> str:
    return (obj.get("metadata") or {}).get("uid") or ""


def _owned_by(obj: dict, uids: set[str]) -> bool:
    refs = (obj.get("metadata") or {}).get("ownerReferences") or []
    return any(isinstance(r, dict) and r.get("uid") in uids for r in refs)


def _by_place(objs: list[dict]) -> list[dict]:
    def place(o: dict) -> tuple[str, str]:
        md = o.get("metadata") or {}
        return md.get("namespace") or "", md.get("name") or ""

    return sorted(objs, key=place)


def _selector_text(selector: object) -> str | None:
    if not isinstance(selector, dict):
        return None
    parts = [f"{k}={v}" for k, v in (selector.get("matchLabels") or {}).items()]
    for expr in selector.get("matchExpressions") or []:
        if not isinstance(expr, dict):
            continue
        values = expr.get("values") or []
        suffix = f" ({', '.join(str(v) for v in values)})" if values else ""
        parts.append(f"{expr.get('key')} {expr.get('operator')}{suffix}")
    return ",".join(parts) or None


def _images(obj: dict) -> str | None:
    containers = (((obj.get("spec") or {}).get("template") or {}).get("spec") or {}).get(
        "containers"
    )
    images = [c.get("image") for c in containers or [] if isinstance(c, dict) and c.get("image")]
    return ", ".join(images) or None


def _strategy(strategy: object) -> str | None:
    if not isinstance(strategy, dict) or not strategy.get("type"):
        return None
    rolling = strategy.get("rollingUpdate") or {}
    parts = []
    if rolling.get("maxSurge") is not None:
        parts.append(f"max surge {rolling['maxSurge']}")
    if rolling.get("maxUnavailable") is not None:
        parts.append(f"max unavailable {rolling['maxUnavailable']}")
    if rolling.get("partition"):
        parts.append(f"partition {rolling['partition']}")
    return strategy["type"] + (f" ({', '.join(parts)})" if parts else "")


def _pod_rows(pods: list[dict], *, namespace_column: bool) -> list[list[Cell]]:
    rows = []
    for pod in _by_place(pods):
        md = pod.get("metadata") or {}
        columns = pod_row(pod, "").columns
        namespace = md.get("namespace") or ""
        name = Cell(text=md.get("name") or "", link=link_to(PODS, namespace, md.get("name")))
        status = Cell(text=columns["status"], cls=columns["status_class"])
        ready, restarts = Cell(text=columns["ready"]), Cell(text=str(columns["restarts"]))
        if namespace_column:
            rows.append([name, Cell(text=namespace), status, ready, restarts])
        else:
            node = columns["node"]
            rows.append(
                [name, status, ready, restarts, Cell(text=node, link=link_to("nodes", None, node))]
            )
    return rows


# --- per kind: (fields, sections) -----------------------------------------------------------


def _replicas(resource: tuple[str, str], obj: dict) -> str:
    spec, status = obj.get("spec") or {}, obj.get("status") or {}
    desired = spec.get("replicas") if isinstance(spec.get("replicas"), int) else 1
    ready = _count(status.get("readyReplicas"))
    if resource == ("apps", "deployments"):
        updated, available = status.get("updatedReplicas"), status.get("availableReplicas")
        return (
            f"{desired} desired, {_count(updated)} updated, {ready} ready, "
            f"{_count(available)} available"
        )
    if resource == ("apps", "daemonsets"):
        counts = [
            ("desired", "desiredNumberScheduled"),
            ("current", "currentNumberScheduled"),
            ("ready", "numberReady"),
            ("updated", "updatedNumberScheduled"),
            ("available", "numberAvailable"),
        ]
        return ", ".join(f"{_count(status.get(field))} {word}" for word, field in counts)
    field = "currentReplicas" if resource == ("apps", "statefulsets") else "replicas"
    return f"{desired} desired, {_count(status.get(field))} current, {ready} ready"


def _workload(obj: dict, ctx: _Context) -> tuple[list[Field], list[Section]]:
    spec = obj.get("spec") or {}
    strategy = spec.get("strategy") or spec.get("updateStrategy")
    fields = [
        Field(label="Replicas", value=_replicas(ctx.resource, obj)),
        Field(label="Strategy", value=_strategy(strategy)),
        Field(label="Selector", value=_selector_text(spec.get("selector"))),
        Field(label="Images", value=_images(obj)),
    ]
    sections = []
    owners = {_uid(obj)} - {""}
    if ctx.resource == ("apps", "deployments"):  # its pods belong to its replica sets
        sets = sorted(
            (rs for rs in ctx.items(REPLICASETS) if _owned_by(rs, owners)),
            key=_revision,
            reverse=True,
        )
        sections.append(
            Section(
                title="Replica sets",
                columns=["Name", "Revision", "Ready", "Created"],
                rows=[_replicaset_row(rs, ctx.namespace) for rs in sets],
                note=None if sets else ctx.note(REPLICASETS, "No replica sets."),
            )
        )
        owners = {_uid(rs) for rs in sets} - {""}
    pods = [p for p in ctx.items(PODS) if _owned_by(p, owners)]
    sections.append(
        Section(
            title="Pods",
            columns=["Name", "Status", "Ready", "Restarts", "Node"],
            rows=_pod_rows(pods, namespace_column=False),
            note=None if pods else ctx.note(PODS, "No pods."),
        )
    )
    return fields, sections


def _revision(rs: dict) -> int:
    value = ((rs.get("metadata") or {}).get("annotations") or {}).get(
        "deployment.kubernetes.io/revision"
    )
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1


def _replicaset_row(rs: dict, namespace: str) -> list[Cell]:
    md, spec, status = rs.get("metadata") or {}, rs.get("spec") or {}, rs.get("status") or {}
    desired = spec.get("replicas") if isinstance(spec.get("replicas"), int) else 1
    revision = _revision(rs)
    return [
        Cell(text=md.get("name") or "", link=link_to(REPLICASETS, namespace, md.get("name"))),
        Cell(text=str(revision) if revision >= 0 else None),
        Cell(text=f"{_count(status.get('readyReplicas'))}/{desired}"),
        Cell(text=md.get("creationTimestamp")),
    ]


def _node(obj: dict, ctx: _Context) -> tuple[list[Field], list[Section]]:
    md, spec, status = obj.get("metadata") or {}, obj.get("spec") or {}, obj.get("status") or {}
    labels = md.get("labels") or {}
    roles = sorted(k[len(ROLE_PREFIX) :] for k in labels if k.startswith(ROLE_PREFIX))
    roles = [r for r in roles if r] or (
        [labels["kubernetes.io/role"]] if labels.get("kubernetes.io/role") else []
    )
    info = status.get("nodeInfo") or {}
    addresses = [
        f"{a.get('type')} {a.get('address')}"
        for a in status.get("addresses") or []
        if isinstance(a, dict) and a.get("address")
    ]
    platform = (
        f"{info['operatingSystem']}/{info['architecture']}"
        if info.get("operatingSystem") and info.get("architecture")
        else None
    )
    fields = [
        Field(label="Roles", value=", ".join(roles) or None),
        Field(label="Addresses", value=", ".join(addresses) or None),
        Field(label="OS image", value=_text(info.get("osImage"))),
        Field(label="Kernel", value=_text(info.get("kernelVersion"))),
        Field(label="Kubelet", value=_text(info.get("kubeletVersion"))),
        Field(label="Container runtime", value=_text(info.get("containerRuntimeVersion"))),
        Field(label="Platform", value=platform),
        Field(
            label="Scheduling",
            value="Cordoned: new pods aren't scheduled here"
            if spec.get("unschedulable")
            else "Schedulable",
        ),
    ]
    capacity, allocatable = status.get("capacity") or {}, status.get("allocatable") or {}
    resources = list(dict.fromkeys([*capacity, *allocatable]))
    taints = [t for t in spec.get("taints") or [] if isinstance(t, dict)]
    name = md.get("name") or ""
    pods = [p for p in ctx.items(PODS) if (p.get("spec") or {}).get("nodeName") == name]
    sections = [
        Section(
            title="Capacity",
            columns=["Resource", "Capacity", "Allocatable"],
            rows=[
                [
                    Cell(text=r),
                    Cell(text=_text(capacity.get(r))),
                    Cell(text=_text(allocatable.get(r))),
                ]
                for r in resources
            ],
            note=None if resources else "The node reports no capacity.",
        ),
        Section(
            title="Taints",
            columns=["Key", "Value", "Effect"],
            rows=[
                [
                    Cell(text=_text(t.get("key"))),
                    Cell(text=_text(t.get("value"))),
                    Cell(text=_text(t.get("effect"))),
                ]
                for t in taints
            ],
            note=None if taints else "No taints.",
        ),
        Section(
            title="Pods",
            columns=["Name", "Namespace", "Status", "Ready", "Restarts"],
            rows=_pod_rows(pods, namespace_column=True),
            note=None if pods else ctx.note(PODS, "No pods run on this node."),
        ),
    ]
    return fields, sections


def _service(obj: dict, ctx: _Context) -> tuple[list[Field], list[Section]]:
    md, spec, status = obj.get("metadata") or {}, obj.get("spec") or {}, obj.get("status") or {}
    ips = spec.get("clusterIPs") or ([spec["clusterIP"]] if spec.get("clusterIP") else [])
    external = [
        i.get("ip") or i.get("hostname")
        for i in (status.get("loadBalancer") or {}).get("ingress") or []
        if isinstance(i, dict) and (i.get("ip") or i.get("hostname"))
    ]
    external += [str(a) for a in spec.get("externalIPs") or []]
    if spec.get("externalName"):
        external.append(spec["externalName"])
    selector = spec.get("selector") or {}
    fields = [
        Field(label="Type", value=spec.get("type") or "ClusterIP"),
        Field(label="Cluster IPs", value=", ".join(ips) or None),
        Field(label="External", value=", ".join(external) or None),
        Field(label="Selector", value=",".join(f"{k}={v}" for k, v in selector.items()) or None),
        Field(label="Session affinity", value=_text(spec.get("sessionAffinity"))),
    ]
    ports = [
        [
            Cell(text=_text(p.get("name"))),
            Cell(text=_text(p.get("port"))),
            Cell(text=_text(p.get("targetPort"))),
            Cell(text=_text(p.get("nodePort"))),
            Cell(text=p.get("protocol") or "TCP"),
        ]
        for p in spec.get("ports") or []
        if isinstance(p, dict)
    ]
    name = md.get("name") or ""
    slices = [
        s
        for s in _by_place(ctx.items(ENDPOINT_SLICES))
        if ((s.get("metadata") or {}).get("labels") or {}).get(SERVICE_NAME_LABEL) == name
    ]
    endpoints = [row for s in slices for row in _endpoint_rows(s, ctx.namespace)]
    sections = [
        Section(
            title="Ports",
            columns=["Name", "Port", "Target port", "Node port", "Protocol"],
            rows=ports,
            note=None if ports else "No ports.",
        ),
        Section(
            title="Endpoints",
            columns=["Address", "Ready", "Pod", "Node", "Ports"],
            rows=endpoints,
            note=None if endpoints else ctx.note(ENDPOINT_SLICES, "No endpoints."),
        ),
    ]
    return fields, sections


def _endpoint_rows(endpoint_slice: dict, namespace: str) -> list[list[Cell]]:
    ports = ", ".join(
        f"{p['name'] + ' ' if p.get('name') else ''}{p.get('port')}/{p.get('protocol') or 'TCP'}"
        for p in endpoint_slice.get("ports") or []
        if isinstance(p, dict)
    )
    rows = []
    for endpoint in endpoint_slice.get("endpoints") or []:
        if not isinstance(endpoint, dict):
            continue
        # A missing `ready` is an unknown state, which consumers treat as ready.
        ready = (endpoint.get("conditions") or {}).get("ready") is not False
        target = endpoint.get("targetRef") or {}
        target_link = link_to(
            known_kind_key("v1", target.get("kind")),
            target.get("namespace") or namespace,
            target.get("name"),
        )
        node = endpoint.get("nodeName")
        for address in endpoint.get("addresses") or []:
            rows.append(
                [
                    Cell(text=str(address)),
                    Cell(text="Ready" if ready else "Not ready", cls="ok" if ready else "warn"),
                    Cell(text=_text(target.get("name")), link=target_link),
                    Cell(text=_text(node), link=link_to("nodes", None, node)),
                    Cell(text=ports or None),
                ]
            )
    return rows


def _configmap(obj: dict, ctx: _Context) -> tuple[list[Field], list[Section]]:
    data = obj.get("data") or {}
    binary = obj.get("binaryData") or {}
    rows = [[Cell(text=str(k)), Cell(text=None if v is None else str(v))] for k, v in data.items()]
    rows += [
        [Cell(text=str(k)), Cell(text=f"{value_size(v, encoded=True)} bytes of binary data")]
        for k, v in binary.items()
    ]
    section = Section(
        title="Data", columns=["Key", "Value"], rows=rows, note=None if rows else "No data."
    )
    return [], [section]


def _secret(obj: dict, ctx: _Context) -> tuple[list[Field], list[Section]]:
    return [Field(label="Type", value=_text(obj.get("type")))], []


def _secret_keys(obj: dict) -> list[SecretKey]:
    """Each key with the size of its value, read from the unmasked object; never the value."""
    sizes: dict[str, int] = {}
    for field, encoded in (("data", True), ("stringData", False)):
        values = obj.get(field)
        if isinstance(values, dict):
            for key, value in values.items():
                sizes[str(key)] = value_size(value, encoded=encoded)
    return [SecretKey(key=key, size=size) for key, size in sorted(sizes.items())]


def _backend(backend: object, namespace: str) -> Cell:
    if not isinstance(backend, dict):
        return Cell(text=None)
    if isinstance(service := backend.get("service"), dict):
        port = service.get("port") or {}
        number = port.get("number") if port.get("number") is not None else port.get("name")
        name = service.get("name") or ""
        text = f"{name}:{number}" if number is not None else name
        return Cell(text=text, link=link_to("services", namespace, name))
    if isinstance(resource := backend.get("resource"), dict):
        group = resource.get("apiGroup") or ""
        key = known_kind_key(f"{group}/v1" if group else "v1", resource.get("kind"))
        return Cell(
            text=f"{resource.get('kind')} {resource.get('name')}",
            link=link_to(key, namespace, resource.get("name")),
        )
    return Cell(text=None)


def _ingress(obj: dict, ctx: _Context) -> tuple[list[Field], list[Section]]:
    md, spec, status = obj.get("metadata") or {}, obj.get("spec") or {}, obj.get("status") or {}
    address = [
        i.get("ip") or i.get("hostname")
        for i in (status.get("loadBalancer") or {}).get("ingress") or []
        if isinstance(i, dict) and (i.get("ip") or i.get("hostname"))
    ]
    default = _backend(spec.get("defaultBackend"), ctx.namespace)
    fields = [
        Field(
            label="Class",
            value=spec.get("ingressClassName")
            or (md.get("annotations") or {}).get("kubernetes.io/ingress.class"),
        ),
        Field(label="Address", value=", ".join(address) or None),
        Field(label="Default backend", value=default.text, link=default.link),
    ]
    rules = []
    for rule in spec.get("rules") or []:
        if not isinstance(rule, dict):
            continue
        host = rule.get("host") or "*"
        paths = [p for p in (rule.get("http") or {}).get("paths") or [] if isinstance(p, dict)]
        if not paths:
            rules.append([Cell(text=host), Cell(text=None), Cell(text=None)])
        for path in paths:
            backend = _backend(path.get("backend"), ctx.namespace)
            rules.append([Cell(text=host), Cell(text=path.get("path") or "/"), backend])
    sections = [
        Section(
            title="Rules",
            columns=["Host", "Path", "Backend"],
            rows=rules,
            note=None if rules else "No rules: everything goes to the default backend.",
        )
    ]
    tls = [t for t in spec.get("tls") or [] if isinstance(t, dict)]
    if tls:
        sections.append(
            Section(
                title="TLS",
                columns=["Hosts", "Secret"],
                rows=[
                    [
                        Cell(text=", ".join(t.get("hosts") or []) or None),
                        Cell(
                            text=_text(t.get("secretName")),
                            link=link_to("secrets", ctx.namespace, t.get("secretName")),
                        ),
                    ]
                    for t in tls
                ],
            )
        )
    return fields, sections


def _pvc(obj: dict, ctx: _Context) -> tuple[list[Field], list[Section]]:
    spec, status = obj.get("spec") or {}, obj.get("status") or {}
    volume = spec.get("volumeName")
    fields = [
        Field(label="Status", value=_text(status.get("phase"))),
        Field(label="Volume", value=_text(volume), link=link_to("persistentvolumes", None, volume)),
        Field(label="Capacity", value=_text((status.get("capacity") or {}).get("storage"))),
        Field(
            label="Requested",
            value=_text(((spec.get("resources") or {}).get("requests") or {}).get("storage")),
        ),
        Field(label="Access modes", value=", ".join(spec.get("accessModes") or []) or None),
        Field(label="Storage class", value=_text(spec.get("storageClassName"))),
        Field(label="Volume mode", value=_text(spec.get("volumeMode"))),
    ]
    return fields, []


def _event(obj: dict, ctx: _Context) -> tuple[list[Field], list[Section]]:
    involved = obj.get("involvedObject") or obj.get("regarding") or {}
    series = obj.get("series") or {}
    source = obj.get("reportingController") or (obj.get("source") or {}).get("component")
    count = series.get("count") or obj.get("count")
    fields = [
        Field(
            label="Object",
            value=f"{involved.get('kind') or ''} {involved.get('name') or ''}".strip() or None,
            link=owner_link(involved, involved.get("namespace")),
        ),
        Field(label="Type", value=_text(obj.get("type"))),
        Field(label="Reason", value=_text(obj.get("reason"))),
        Field(label="Message", value=_text(obj.get("message") or obj.get("note"))),
        Field(label="Count", value=_text(count)),
        Field(label="First seen", value=_text(obj.get("firstTimestamp") or obj.get("eventTime"))),
        Field(
            label="Last seen",
            value=_text(
                obj.get("lastTimestamp") or series.get("lastObservedTime") or obj.get("eventTime")
            ),
        ),
        Field(label="Source", value=_text(source)),
    ]
    return fields, []


def _generic(obj: dict, ctx: _Context) -> tuple[list[Field], list[Section]]:
    md = obj.get("metadata") or {}
    fields = []
    if finalizers := md.get("finalizers"):
        fields.append(Field(label="Finalizers", value=", ".join(str(f) for f in finalizers)))
    if deleting := md.get("deletionTimestamp"):
        fields.append(Field(label="Being deleted since", value=str(deleting)))
    note = Section(title="Spec and status", columns=[], rows=[], note=GENERIC_NOTE)
    return fields, [note]


_DESCRIBERS = {
    **{resource: _workload for resource in WORKLOADS},
    ("", "nodes"): _node,
    ("", "services"): _service,
    ("", "configmaps"): _configmap,
    ("", "secrets"): _secret,
    ("networking.k8s.io", "ingresses"): _ingress,
    ("", "persistentvolumeclaims"): _pvc,
    ("", "events"): _event,
}
