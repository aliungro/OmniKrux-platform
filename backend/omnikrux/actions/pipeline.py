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
import difflib
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
from typing import Any, Literal, Protocol

import yaml
from fastapi import APIRouter, HTTPException, Request
from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException
from pydantic import BaseModel, ConfigDict, Field

from omnikrux.actions import authz
from omnikrux.actions.authz import NotAllowed
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
from omnikrux.kube.http import KUBE_ERRORS
from omnikrux.resources.catalog import KindNotServed
from omnikrux.resources.kinds import KindSpec, is_kind_key

log = logging.getLogger(__name__)

router = APIRouter()

PLAN_TTL_SECONDS = 300
DIFF_LIMIT = 64 * 1024  # bytes of unified diff kept in a plan or an audit record
DIFF_CUT = "… (diff cut at 64 KB)"
CONFLICT_STATUS = 409

EXPIRED = "This change expired or was already applied. Review it again."
CONFLICT = "{kind} {name} changed since you reviewed this change. Review it again."
TYPE_TO_CONFIRM = "Type {name} to confirm"
PRODUCTION = "This is a production cluster."
CANCELLED = "The request stopped before the cluster answered; the change may or may not be made."
ONLY_PLAN_ID = "An apply takes only the plan id and the typed confirmation."

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
# Set by the API server, so not part of what a user reviews or edits.
SERVER_FIELDS = ("managedFields", "resourceVersion", "generation", "uid", "creationTimestamp")
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
    diff: Diff | None = None
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
    jobs: Any = None  # the JobRunner (Task 6)
    audit: AuditLog
    audit_id: int
    actor: str


class ActionHandler(Protocol):
    kinds: frozenset[str] | None  # the kind keys it acts on; None: any served kind

    async def plan(self, api: ApiClient, spec: KindSpec, target: Target, params: dict) -> Planned:
        """Read the live object and work out the change. Raise ActionError to refuse."""
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


# --- YAML and diffs -----------------------------------------------------------------------


def dump_yaml(obj: Any) -> str:
    """The one YAML dump: keys in the object's order, non-ASCII text as it is."""
    return yaml.safe_dump(obj, sort_keys=False, allow_unicode=True)


def to_yaml(obj: dict) -> str:
    """The object as a user reviews it: without status and the fields the server sets."""
    out = copy.deepcopy(obj)
    out.pop("status", None)
    metadata = out.get("metadata")
    if isinstance(metadata, dict):
        for name in SERVER_FIELDS:
            metadata.pop(name, None)
    return dump_yaml(out)


def diff_text(before: str, after: str) -> str:
    """A unified diff, cut at a line boundary once it passes 64 KB."""
    text = "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True),
            after.splitlines(keepends=True),
            fromfile="before",
            tofile="after",
        )
    )
    data = text.encode()
    if len(data) <= DIFF_LIMIT:
        return text
    kept = data[:DIFF_LIMIT].decode("utf-8", "ignore")
    return kept[: kept.rfind("\n") + 1] + DIFF_CUT


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
    if spec.namespaced != bool(target.namespace):
        detail = (
            f"Choose the namespace of {spec.kind} {target.name}."
            if spec.namespaced
            else f"{spec.kind} objects have no namespace."
        )
        raise HTTPException(status_code=422, detail=detail)

    async with AsyncExitStack() as stack:
        api = await _open_api(stack, state.connections, target.cluster_id)
        try:
            planned = await handler.plan(api, spec, target, copy.deepcopy(body.params))
        except Exception as exc:
            raise _failure(exc, body.action, spec, target) from exc

    cluster = ClusterRef(
        id=info.id, name=info.name, provider=info.provider.value, environment=info.environment.value
    )
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
        confirm_text=target.name if typed else None,
        actor=actor,
    )
    plans: PlanStore = state.plans
    plan_id = plans.put(stored)
    return PlanOut(
        plan_id=plan_id,
        action=body.action,
        target=target,
        cluster=cluster,
        title=planned.title,
        summary=list(planned.summary),
        warnings=warnings,
        blocked=list(planned.blocked),
        diff=planned.diff,
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
        diff=diff_text(planned.diff.before, planned.diff.after) if planned.diff else None,
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
        await audit.finish(audit_id, "failed", exc.detail)
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
