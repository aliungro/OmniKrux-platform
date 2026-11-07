"""Scale, restart and roll back workloads.

Each apply is a JSON patch whose `test` ops hold what the plan read: the object's uid (so a
workload deleted and re-created under the same name isn't touched) and the values the change
replaces. If any of them moved since the review, the API server refuses the whole patch (a 422
naming the failed test) and the user reads the conflict copy."""

import copy
from datetime import UTC, datetime

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException
from pydantic import BaseModel

from omnikrux.actions.pipeline import ActionError, Applied, ApplyContext, Planned, Target
from omnikrux.kube.connections import kube_error_message
from omnikrux.kube.http import call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.resources.describe_any import match_labels
from omnikrux.resources.kinds import KindSpec

JSON_PATCH = "application/json-patch+json"
MAX_REPLICAS = 10_000
REVISION = "deployment.kubernetes.io/revision"
POD_TEMPLATE_HASH = "pod-template-hash"
RESTARTED_AT = "kubectl.kubernetes.io/restartedAt"

BAD_REPLICAS = "Replicas must be a whole number from 0 to 10,000."
SCALE_TO_ZERO = "Scaling to 0 stops every pod of {name}."
HPA_MANAGES = "HorizontalPodAutoscaler {hpa} manages these replicas and may change them back."
PAUSED = "This deployment is paused: the restart happens once it's resumed."
NO_EARLIER = "Deployment {name} has no earlier revision to roll back to."
NO_SUCH_REVISION = "Deployment {name} has no revision {revision}."
ALREADY_RUNS = "Deployment {name} already runs revision {revision}."
BAD_REVISION = "The revision must be a whole number from 1 up, or empty for the previous one."


def _where(target: Target) -> str:
    return f"{target.namespace}/{target.name}"


def _uid(obj: dict) -> str | None:
    return (obj.get("metadata") or {}).get("uid")


def _is_count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


async def _read(api: ApiClient, spec: KindSpec, target: Target) -> dict:
    path = spec.object_path(target.namespace, target.name)
    return await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)


async def _patch(api: ApiClient, spec: KindSpec, target: Target, ops: list[dict]) -> dict:
    path = spec.object_path(target.namespace, target.name)
    return await call_json(
        api, "PATCH", path, timeout=REQUEST_TIMEOUT, body=ops, content_type=JSON_PATCH
    )


def _test(path: str, value: object) -> dict:
    return {"op": "test", "path": path, "value": value}


# --- scale ----------------------------------------------------------------------------------


async def _hpa_warnings(api: ApiClient, spec: KindSpec, target: Target) -> list[str]:
    """The HorizontalPodAutoscalers in the namespace that scale this object, as warnings."""
    path = f"/apis/autoscaling/v2/namespaces/{target.namespace}/horizontalpodautoscalers"
    try:
        hpas = (await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)).get("items") or []
    except ApiException as exc:
        if exc.status == 404:  # the cluster serves no autoscaling/v2: nothing to warn about
            return []
        return [
            kube_error_message(exc, f"check for HorizontalPodAutoscalers in {target.namespace}")
        ]
    warnings = []
    for hpa in hpas:
        ref = (hpa.get("spec") or {}).get("scaleTargetRef") or {}
        group = (ref.get("apiVersion") or "").rpartition("/")[0]
        if (ref.get("kind"), ref.get("name"), group) == (spec.kind, target.name, spec.group):
            warnings.append(HPA_MANAGES.format(hpa=(hpa.get("metadata") or {}).get("name")))
    return warnings


class ScaleAction:
    kinds = frozenset({"deployments.apps", "statefulsets.apps", "replicasets.apps"})

    async def plan(self, api: ApiClient, spec: KindSpec, target: Target, params: dict) -> Planned:
        replicas = params.get("replicas")
        if not _is_count(replicas) or not 0 <= replicas <= MAX_REPLICAS:
            raise ActionError(422, BAD_REPLICAS)
        live = await _read(api, spec, target)
        current = (live.get("spec") or {}).get("replicas", 1)
        after = copy.deepcopy(live)
        after.setdefault("spec", {})["replicas"] = replicas
        warnings = [SCALE_TO_ZERO.format(name=target.name)] if replicas == 0 else []
        warnings += await _hpa_warnings(api, spec, target)
        return Planned(
            title=f"Scale {spec.kind} {target.name}",
            summary=[f"Scale {spec.kind} {_where(target)} from {current} to {replicas} replicas."],
            warnings=warnings,
            before=live,
            after=after,
            apply_label="Scale",
            state={"uid": _uid(live), "from": current, "to": replicas},
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        state = planned.state
        ops = [
            _test("/metadata/uid", state["uid"]),
            _test("/spec/replicas", state["from"]),
            {"op": "replace", "path": "/spec/replicas", "value": state["to"]},
        ]
        await _patch(ctx.api, spec, target, ops)
        return Applied(f"Scaled {spec.kind} {_where(target)} to {state['to']} replicas.")


# --- restart --------------------------------------------------------------------------------


def _strategy(spec: KindSpec, obj: dict) -> str:
    """The update strategy's type: a Deployment's `strategy`, a StatefulSet's or DaemonSet's
    `updateStrategy` (RollingUpdate when unset, as the API server defaults it)."""
    field = "strategy" if spec.kind == "Deployment" else "updateStrategy"
    return ((obj.get("spec") or {}).get(field) or {}).get("type") or "RollingUpdate"


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _restart_ops(template: dict, uid: str | None, stamp: str) -> list[dict]:
    """Set the restartedAt annotation of the pod template, as `kubectl rollout restart` does.

    When the template has no annotations yet the whole map is added, and only if the template's
    metadata is still what the plan read: an `add` of the map would replace one that appeared
    meanwhile."""
    ops = [_test("/metadata/uid", uid)]
    metadata = template.get("metadata")
    if metadata is None:
        ops += [
            _test("/spec/template", template),
            {
                "op": "add",
                "path": "/spec/template/metadata",
                "value": {"annotations": {RESTARTED_AT: stamp}},
            },
        ]
    elif metadata.get("annotations") is None:
        ops += [
            _test("/spec/template/metadata", metadata),
            {
                "op": "add",
                "path": "/spec/template/metadata/annotations",
                "value": {RESTARTED_AT: stamp},
            },
        ]
    else:
        key = RESTARTED_AT.replace("~", "~0").replace("/", "~1")
        ops.append(
            {"op": "add", "path": f"/spec/template/metadata/annotations/{key}", "value": stamp}
        )
    return ops


class RestartAction:
    kinds = frozenset({"deployments.apps", "statefulsets.apps", "daemonsets.apps"})

    async def plan(self, api: ApiClient, spec: KindSpec, target: Target, params: dict) -> Planned:
        live = await _read(api, spec, target)
        template = (live.get("spec") or {}).get("template") or {}
        after = copy.deepcopy(live)
        after_template = after.setdefault("spec", {}).setdefault("template", {})
        after_template.setdefault("metadata", {}).setdefault("annotations", {})[RESTARTED_AT] = (
            _now()
        )
        paused = spec.kind == "Deployment" and (live.get("spec") or {}).get("paused") is True
        return Planned(
            title=f"Restart {spec.kind} {target.name}",
            summary=[
                (
                    f"Restart every pod of {spec.kind} {_where(target)}, following its update "
                    f"strategy ({_strategy(spec, live)})."
                )
            ],
            warnings=[PAUSED] if paused else [],
            before=live,
            after=after,
            apply_label="Restart",
            state={"uid": _uid(live), "template": template},
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        state = planned.state
        await _patch(ctx.api, spec, target, _restart_ops(state["template"], state["uid"], _now()))
        return Applied(f"Restarting every pod of {spec.kind} {_where(target)}.")


# --- rollback -------------------------------------------------------------------------------


class Revision(BaseModel):
    revision: int
    created_at: str | None
    images: list[str]
    current: bool


def _revision_of(obj: dict) -> int | None:
    value = ((obj.get("metadata") or {}).get("annotations") or {}).get(REVISION)
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


async def replica_sets(api: ApiClient, deployment: dict) -> dict[int, dict]:
    """The deployment's ReplicaSets by revision: those it controls (by uid) that carry one."""
    md = deployment.get("metadata") or {}
    selector = match_labels(deployment)
    path = f"/apis/apps/v1/namespaces/{md.get('namespace')}/replicasets"
    query = (("labelSelector", selector),) if selector else ()
    items = (await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT, query=query)).get("items")
    found: dict[int, dict] = {}
    for rs in items or []:
        refs = (rs.get("metadata") or {}).get("ownerReferences") or []
        owned = any(r.get("controller") and r.get("uid") == md.get("uid") for r in refs)
        revision = _revision_of(rs)
        if owned and revision is not None:
            found[revision] = rs
    return found


def _current_revision(deployment: dict, sets: dict[int, dict]) -> int | None:
    return _revision_of(deployment) or (max(sets) if sets else None)


def _images(template: dict) -> list[str]:
    containers = (template.get("spec") or {}).get("containers") or []
    return [c.get("image") or "" for c in containers]


async def deployment_revisions(api: ApiClient, deployment: dict) -> list[Revision]:
    """The deployment's revisions, newest first."""
    sets = await replica_sets(api, deployment)
    current = _current_revision(deployment, sets)
    return [
        Revision(
            revision=revision,
            created_at=(rs.get("metadata") or {}).get("creationTimestamp"),
            images=_images((rs.get("spec") or {}).get("template") or {}),
            current=revision == current,
        )
        for revision, rs in sorted(sets.items(), reverse=True)
    ]


def _without_hash(template: dict) -> dict:
    """A ReplicaSet's pod template as its deployment had it: without the pod-template-hash label
    the deployment controller adds."""
    out = copy.deepcopy(template)
    labels = (out.get("metadata") or {}).get("labels")
    if isinstance(labels, dict):
        labels.pop(POD_TEMPLATE_HASH, None)
    return out


class RollbackAction:
    kinds = frozenset({"deployments.apps"})

    async def plan(self, api: ApiClient, spec: KindSpec, target: Target, params: dict) -> Planned:
        wanted = params.get("revision")
        if wanted is not None and (not _is_count(wanted) or wanted < 1):
            raise ActionError(422, BAD_REVISION)
        live = await _read(api, spec, target)
        sets = await replica_sets(api, live)
        current = _current_revision(live, sets)
        title = f"Roll back {spec.kind} {target.name}"
        if wanted is None:
            older = [r for r in sets if current is None or r < current]
            if not older:
                blocked = [NO_EARLIER.format(name=target.name)]
                return Planned(title=title, blocked=blocked, apply_label="Roll back")
            wanted = max(older)
        elif wanted not in sets:
            raise ActionError(422, NO_SUCH_REVISION.format(name=target.name, revision=wanted))
        elif wanted == current:
            blocked = [ALREADY_RUNS.format(name=target.name, revision=wanted)]
            return Planned(title=title, blocked=blocked, apply_label="Roll back")
        template = (live.get("spec") or {}).get("template") or {}
        rolled_back = _without_hash((sets[wanted].get("spec") or {}).get("template") or {})
        return Planned(
            title=title,
            summary=[
                (
                    f"Roll back {spec.kind} {_where(target)} from revision {current} to "
                    f"revision {wanted}."
                )
            ],
            before=template,
            after=rolled_back,
            apply_label="Roll back",
            state={
                "uid": _uid(live),
                "template": template,
                "rolled_back": rolled_back,
                "revision": wanted,
            },
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        state = planned.state
        ops = [
            _test("/metadata/uid", state["uid"]),
            _test("/spec/template", state["template"]),
            {"op": "replace", "path": "/spec/template", "value": state["rolled_back"]},
        ]
        await _patch(ctx.api, spec, target, ops)
        return Applied(f"Rolled back {spec.kind} {_where(target)} to revision {state['revision']}.")
