"""The action pipeline: every change to a cluster is planned on the server, confirmed by the
user, written to the audit log, and only then applied, exactly as planned.

`POST /api/actions/plan` reads the live object through the action's handler and keeps the plan
(cluster, namespace, kind, name and the handler's preconditions) on the server for 300 s.
`POST /api/actions/{plan_id}/apply` takes nothing but the plan id and the typed confirmation, so
it can only ever act on what the user reviewed; the plan is used once. No audit, no change: if
the audit record can't be written, the handler is never called. Every handler's apply carries a
Kubernetes precondition, so an object that changed since the plan answers with the conflict
copy instead of being changed."""

import copy
import json
import logging
import re
import secrets
import threading
import time
from collections.abc import Callable
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal, Protocol

from fastapi import APIRouter, HTTPException, Request
from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException
from pydantic import BaseModel, ConfigDict, Field

from omnikrux.actions import authz
from omnikrux.actions.authz import NotAllowed
from omnikrux.actions.jobs import JobOut, JobRunner
from omnikrux.audit.store import (
    AuditEntry,
    AuditLog,
    AuditUnavailable,
    actor_of,
    no_audit_message,
)
from omnikrux.clusters.models import Environment
from omnikrux.exec.debug import finish_even_if_cancelled
from omnikrux.kube.connections import ClusterConnections, kube_error_message
from omnikrux.kube.http import KUBE_ERRORS, call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.resources.catalog import KindNotServed
from omnikrux.resources.kinds import (
    HELM_RELEASES,
    KindSpec,
    is_kind_key,
    object_name_problem,
    target_problem,
)
from omnikrux.resources.yaml_out import diff_text, is_secret_resource, to_yaml

log = logging.getLogger(__name__)

router = APIRouter()

PLAN_TTL_SECONDS = 300
CONFLICT_STATUS = 409

EXPIRED = "This change expired or was already applied. Review it again."
CONFLICT = "{kind} {name} changed since you reviewed this change. Review it again."
TYPE_TO_CONFIRM = "Type {name} to confirm"
PRODUCTION = "This is a production cluster."
CANCELLED = "The request stopped before the cluster answered; the change may or may not be made."
ONLY_PLAN_ID = "An apply takes only the plan id and the typed confirmation."
HELM_READ_ONLY = "Helm releases are read-only in Omnikrux. Use helm to change them."
SECRET_EDIT = (
    "Secrets can't be edited in Omnikrux: their values never reach the browser. "
    "Use kubectl to change them."
)

# Deleting or draining one of these, or anything on a production cluster, needs the name typed.
TYPED_KINDS = frozenset(
    {
        "namespaces",
        "nodes",
        "persistentvolumes",
        "persistentvolumeclaims",
        "customresourcedefinitions.apiextensions.k8s.io",
    }
)
TYPED_ACTIONS = frozenset({"delete", "drain"})
# A JSON-patch `test` op that didn't hold, as the API server words it (a 422).
_TEST_FAILED = re.compile(r"\btest(?:ing value \S+)? failed")

ActionName = Literal[
    "edit", "scale", "restart", "rollback", "delete", "cordon", "uncordon", "drain"
]


# --- what the browser sends and gets ------------------------------------------------------


class Target(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    cluster_id: str = Field(min_length=1)
    kind_key: str = Field(min_length=1)
    namespace: str | None = None  # None for cluster-scoped kinds
    name: str = Field(min_length=1)


class PlanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: ActionName
    target: Target
    params: dict = {}


class Diff(BaseModel):
    before: str
    after: str


class ClusterRef(BaseModel):
    id: str
    name: str
    provider: str
    environment: str


class PlanOut(BaseModel):
    plan_id: str
    action: str
    target: Target
    kind: str  # the target's Kind on the plan's cluster ("Deployment"), for the dialog to name
    cluster: ClusterRef  # the plan's cluster: what the dialog names, whatever is selected
    title: str
    summary: list[str]
    warnings: list[str]
    blocked: list[str]  # non-empty: the plan can't be applied
    diff: Diff | None
    confirm_text: str | None  # the text to type before applying; None: no typing
    apply_label: str
    expires_at: datetime


class ApplyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm_text: str | None = None


class ApplyOut(BaseModel):
    outcome: Literal["succeeded", "started"]  # started: a job carries on (see job_id)
    message: str
    job_id: str | None
    audit_id: int


# --- what handlers implement --------------------------------------------------------------


@dataclass(kw_only=True)
class Planned:
    title: str
    summary: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    blocked: list[str] = field(default_factory=list)
    # The object as it is now and as the change leaves it (None: it doesn't exist then). The
    # pipeline renders both sides itself with `to_yaml`, masking a Secret by the kind's resource
    # (whatever the dicts carry), so no handler hands over YAML text and no value reaches a plan
    # or an audit diff. Both None: the plan has no diff.
    before: dict | None = None
    after: dict | None = None
    typed: bool = False  # the handler asks for the name to be typed, whatever the rule says
    apply_label: str
    # The handler's own precondition data (uid, resourceVersion, the body to PUT, ...): kept on
    # the server with the plan and handed back to `apply`, never sent to the browser.
    state: dict = field(default_factory=dict)


@dataclass
class Applied:
    message: str
    job_id: str | None = None  # set when a job finishes the audit record itself


@dataclass(kw_only=True)
class ApplyContext:
    api: ApiClient  # the plan's cluster, and only that
    connections: ClusterConnections
    jobs: JobRunner | None = None  # runs what an apply leaves going (a drain)
    audit: AuditLog
    audit_id: int
    actor: str


class ActionHandler(Protocol):
    kinds: frozenset[str] | None  # the kind keys it acts on; None: any served kind

    async def plan(
        self, api: ApiClient, spec: KindSpec, target: Target, params: dict, *, cluster: ClusterRef
    ) -> Planned:
        """Read the live object and work out the change. Raise ActionError to refuse.
        `cluster` is the plan's cluster, for copy that names it."""
        ...

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        """Make exactly the planned change, with a Kubernetes precondition."""
        ...


ACTIONS: dict[str, ActionHandler] = {}


def register(name: str, handler: ActionHandler) -> None:
    ACTIONS[name] = handler


class ActionError(Exception):
    """A handler's refusal, in plain words, answered with `status`."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


# --- the plan store -----------------------------------------------------------------------


@dataclass(frozen=True)
class StoredPlan:
    action: str
    handler: ActionHandler  # the handler that planned it applies it
    target: Target
    cluster: ClusterRef
    spec: KindSpec
    planned: Planned
    diff: Diff | None  # rendered from `planned` by `render_diff`: what the user reviewed
    confirm_text: str | None
    actor: str


class PlanStore:
    """Plans by id, each kept `ttl` seconds and used once.

    `take` is the only way to use a plan: it removes the plan under a lock, so of any number of
    concurrent applies of one plan exactly one gets it."""

    def __init__(
        self, ttl: float = PLAN_TTL_SECONDS, *, clock: Callable[[], float] = time.monotonic
    ):
        self.ttl = ttl
        self._clock = clock
        self._plans: dict[str, tuple[float, StoredPlan]] = {}  # id -> (deadline, plan)
        self._lock = threading.Lock()

    def put(self, plan: StoredPlan) -> str:
        plan_id = secrets.token_urlsafe(16)
        with self._lock:
            now = self._clock()
            for old in [k for k, (deadline, _) in self._plans.items() if deadline <= now]:
                del self._plans[old]
            self._plans[plan_id] = (now + self.ttl, plan)
        return plan_id

    def peek(self, plan_id: str) -> StoredPlan | None:
        """The plan, without using it up; None when missing or expired."""
        with self._lock:
            entry = self._plans.get(plan_id)
            return entry[1] if entry is not None and entry[0] > self._clock() else None

    def take(self, plan_id: str) -> StoredPlan | None:
        """The plan, used up; None when missing, expired or already taken."""
        with self._lock:
            entry = self._plans.pop(plan_id, None)
            return entry[1] if entry is not None and entry[0] > self._clock() else None


# --- diffs --------------------------------------------------------------------------------


def render_diff(spec: KindSpec, planned: Planned) -> Diff | None:
    """Both sides of the change as the user reviews them; a Secret's values masked because the
    kind's resource is secrets, even when the handler's dicts don't say they are Secrets."""
    if planned.before is None and planned.after is None:
        return None
    secret = is_secret_resource(spec)

    def side(obj: dict | None) -> str:
        return "" if obj is None else to_yaml(obj, secret=secret)

    return Diff(before=side(planned.before), after=side(planned.after))


# --- rules --------------------------------------------------------------------------------


def needs_typed_confirmation(action: str, environment: str, kind_key: str, handler: bool) -> bool:
    return handler or (
        action in TYPED_ACTIONS
        and (environment == Environment.PRODUCTION or kind_key in TYPED_KINDS)
    )


def _kube_texts(exc: ApiException) -> list[str]:
    """The Status message and its causes' messages."""
    try:
        body = json.loads(exc.body or "")
    except (ValueError, TypeError):
        return []
    if not isinstance(body, dict):
        return []
    texts = [body.get("message")]
    causes = (
        (body.get("details") or {}).get("causes") if isinstance(body.get("details"), dict) else []
    )
    texts += [c.get("message") for c in causes or [] if isinstance(c, dict)]
    return [t for t in texts if isinstance(t, str)]


def is_conflict(exc: BaseException) -> bool:
    """The object changed since the plan: a 409 (resourceVersion or uid precondition), or a 422
    for a JSON-patch `test` op that no longer holds."""
    if not isinstance(exc, ApiException):
        return False
    if exc.status == CONFLICT_STATUS:
        return True
    return exc.status == 422 and any(_TEST_FAILED.search(t) for t in _kube_texts(exc))


JSON_PATCH = "application/json-patch+json"
_MISSING = object()


def _value_at(doc: object, pointer: str) -> object:
    """The value a JSON pointer (RFC 6901) names; _MISSING when nothing is there."""
    for raw in pointer.split("/")[1:]:
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(doc, dict) and token in doc:
            doc = doc[token]
        elif isinstance(doc, list) and token.isdigit() and int(token) < len(doc):
            doc = doc[int(token)]
        else:
            return _MISSING
    return doc


async def json_patch(api: ApiClient, path: str, ops: list[dict]) -> dict:
    """PATCH one object with JSON-patch `ops`, whose `test` ops are the apply's precondition.

    A real API server answers a patch whose `test` op fails with a bare 422 (the Status has no
    message or causes naming the test), the same as for any other refused patch. So on a 422 the
    object is read again and the `test` ops are checked against it: one that no longer holds is
    the object having changed since the review, raised as the 409 conflict."""
    try:
        return await call_json(
            api, "PATCH", path, timeout=REQUEST_TIMEOUT, body=ops, content_type=JSON_PATCH
        )
    except ApiException as exc:
        if exc.status != 422:
            raise
        try:
            live = await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)
        except KUBE_ERRORS:
            raise exc from None  # what the user reads is the patch's refusal
        if any(
            op.get("op") == "test" and _value_at(live, op.get("path", "")) != op.get("value")
            for op in ops
        ):
            raise ApiException(
                status=CONFLICT_STATUS, reason="a test of the patch no longer holds"
            ) from exc
        raise


def _where(target: Target) -> str:
    return f"{target.namespace}/{target.name}" if target.namespace else target.name


def _failure(exc: Exception, action: str, spec: KindSpec, target: Target) -> HTTPException:
    """A handler's failure as a plain HTTP answer."""
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, ActionError):
        return HTTPException(status_code=exc.status, detail=exc.message)
    if is_conflict(exc):
        return HTTPException(
            status_code=CONFLICT_STATUS, detail=CONFLICT.format(kind=spec.kind, name=target.name)
        )
    status = 502
    if isinstance(exc, ApiException) and exc.status in (403, 404):
        status = exc.status
    elif isinstance(exc, ApiException) and exc.status in (400, 422):
        status = 422
    elif not isinstance(exc, KUBE_ERRORS):
        log.warning("Could not %s %s (%s)", action, spec.key, type(exc).__name__)
    words = f"{action} {spec.kind} {_where(target)}"
    return HTTPException(status_code=status, detail=kube_error_message(exc, words))


async def _authorize(actor: str, action: str, target: Target) -> None:
    try:
        await authz.authorize(
            actor, action, target.cluster_id, target.namespace, target.kind_key, target.name
        )
    except NotAllowed as exc:
        raise HTTPException(status_code=403, detail=exc.message) from exc


async def _open_api(stack: AsyncExitStack, connections: ClusterConnections, cluster_id: str):
    try:
        return await stack.enter_async_context(connections.api(cluster_id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown cluster") from exc
    except Exception as exc:  # e.g. a missing exec plugin, said in words
        detail = kube_error_message(exc, "connect to the cluster")
        raise HTTPException(status_code=502, detail=detail) from exc


# --- routes -------------------------------------------------------------------------------


@router.post("/api/actions/plan")
async def plan_action(body: PlanIn, request: Request) -> PlanOut:
    state = request.app.state
    target = body.target
    handler = ACTIONS.get(body.action)
    if handler is None:
        raise HTTPException(status_code=422, detail=f"Omnikrux can't {body.action} yet.")
    if not is_kind_key(target.kind_key) or (
        handler.kinds is not None and target.kind_key not in handler.kinds
    ):
        raise HTTPException(status_code=422, detail=f"Can't {body.action} {target.kind_key}.")
    # Refused here, whatever a handler would do: helm-releases are Helm's Secrets, and an edit
    # of a Secret would be made from masked YAML.
    if target.kind_key == HELM_RELEASES:
        raise HTTPException(status_code=422, detail=HELM_READ_ONLY)
    if body.action == "edit" and target.kind_key == "secrets":
        raise HTTPException(status_code=422, detail=SECRET_EDIT)
    # Handlers join names into API paths: nothing but a Kubernetes name gets that far.
    if (problem := object_name_problem(target.name, target.namespace)) is not None:
        raise HTTPException(status_code=422, detail=problem)
    actor = actor_of(request)
    await _authorize(actor, body.action, target)
    try:
        info = await state.registry.get(target.cluster_id)
        spec: KindSpec = await state.catalog.spec(target.cluster_id, target.kind_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown cluster") from exc
    except KindNotServed as exc:
        raise HTTPException(status_code=404, detail=exc.message) from exc
    except Exception as exc:  # unreachable, or discovery failed: said in words
        detail = kube_error_message(exc, "read which kinds the cluster serves")
        raise HTTPException(status_code=502, detail=detail) from exc
    if (problem := target_problem(spec, target.name, target.namespace)) is not None:
        raise HTTPException(status_code=422, detail=problem)

    cluster = ClusterRef(
        id=info.id, name=info.name, provider=info.provider.value, environment=info.environment.value
    )
    async with AsyncExitStack() as stack:
        api = await _open_api(stack, state.connections, target.cluster_id)
        try:
            params = copy.deepcopy(body.params)
            planned = await handler.plan(api, spec, target, params, cluster=cluster)
        except Exception as exc:
            raise _failure(exc, body.action, spec, target) from exc

    typed = needs_typed_confirmation(body.action, cluster.environment, spec.key, planned.typed)
    warnings = list(planned.warnings)
    if cluster.environment == Environment.PRODUCTION and PRODUCTION not in warnings:
        warnings.insert(0, PRODUCTION)
    stored = StoredPlan(
        action=body.action,
        handler=handler,
        target=target,
        cluster=cluster,
        spec=spec,
        planned=planned,
        diff=render_diff(spec, planned),
        confirm_text=target.name if typed else None,
        actor=actor,
    )
    plans: PlanStore = state.plans
    plan_id = plans.put(stored)
    return PlanOut(
        plan_id=plan_id,
        action=body.action,
        target=target,
        kind=spec.kind,
        cluster=cluster,
        title=planned.title,
        summary=list(planned.summary),
        warnings=warnings,
        blocked=list(planned.blocked),
        diff=stored.diff,
        confirm_text=stored.confirm_text,
        apply_label=planned.apply_label,
        expires_at=datetime.now(UTC) + timedelta(seconds=plans.ttl),
    )


@router.post("/api/actions/{plan_id}/apply")
async def apply_action(plan_id: str, body: ApplyIn, request: Request) -> ApplyOut:
    if request.query_params:  # nothing about the target can come from the browser
        raise HTTPException(status_code=422, detail=ONLY_PLAN_ID)
    state = request.app.state
    plans: PlanStore = state.plans
    actor = actor_of(request)
    # Checked before the plan is used up, so a typo doesn't cost the user their review.
    seen = plans.peek(plan_id)
    if seen is None or seen.actor != actor:
        raise HTTPException(status_code=404, detail=EXPIRED)
    if seen.planned.blocked:
        raise HTTPException(status_code=422, detail=" ".join(seen.planned.blocked))
    if seen.confirm_text is not None and body.confirm_text != seen.confirm_text:
        raise HTTPException(status_code=422, detail=TYPE_TO_CONFIRM.format(name=seen.confirm_text))
    await _authorize(actor, seen.action, seen.target)
    stored = plans.take(plan_id)  # the one use: of concurrent applies, exactly one gets it
    if stored is None:
        raise HTTPException(status_code=404, detail=EXPIRED)

    target, spec, planned = stored.target, stored.spec, stored.planned
    audit: AuditLog = state.audit
    entry = AuditEntry(
        actor=actor,
        action=stored.action,
        cluster_id=target.cluster_id,
        namespace=target.namespace,
        kind=target.kind_key,
        name=target.name,
        details={"title": planned.title, "summary": list(planned.summary)},
        diff=diff_text(stored.diff.before, stored.diff.after) if stored.diff else None,
    )
    try:
        audit_id = await audit.begin(entry)
    except AuditUnavailable as exc:  # no audit, no change
        raise HTTPException(status_code=503, detail=no_audit_message(exc)) from exc

    try:
        async with AsyncExitStack() as stack:
            api = await _open_api(stack, state.connections, target.cluster_id)
            ctx = ApplyContext(
                api=api,
                connections=state.connections,
                jobs=getattr(state, "jobs", None),
                audit=audit,
                audit_id=audit_id,
                actor=actor,
            )
            try:
                applied = await stored.handler.apply(ctx, target, spec, planned)
            except Exception as exc:
                raise _failure(exc, stored.action, spec, target) from exc
    except HTTPException as exc:
        await audit.finish(audit_id, "failed", str(exc.detail))
        raise
    except BaseException:  # cancelled mid-apply: whether the change landed isn't known
        await finish_even_if_cancelled(audit.finish(audit_id, "unknown", CANCELLED))
        raise

    if applied.job_id is not None:  # the job finishes the record
        return ApplyOut(
            outcome="started", message=applied.message, job_id=applied.job_id, audit_id=audit_id
        )
    await audit.finish(audit_id, "succeeded", applied.message)
    return ApplyOut(outcome="succeeded", message=applied.message, job_id=None, audit_id=audit_id)


# --- jobs ---------------------------------------------------------------------------------

NO_SUCH_JOB = "This job isn't known: it ended more than an hour ago, or the console restarted."


def _jobs(request: Request) -> JobRunner:
    jobs = getattr(request.app.state, "jobs", None)
    if jobs is None:
        raise HTTPException(status_code=404, detail=NO_SUCH_JOB)
    return jobs


@router.get("/api/actions/jobs/{job_id}")
async def get_job(job_id: str, request: Request) -> JobOut:
    try:
        return _jobs(request).get(job_id, actor=actor_of(request))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=NO_SUCH_JOB) from exc


@router.post("/api/actions/jobs/{job_id}/cancel")
async def cancel_job(job_id: str, request: Request) -> JobOut:
    """Stop a running job; what it already did stays done (a drain's node stays cordoned)."""
    try:
        return await _jobs(request).cancel(job_id, actor=actor_of(request))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=NO_SUCH_JOB) from exc
