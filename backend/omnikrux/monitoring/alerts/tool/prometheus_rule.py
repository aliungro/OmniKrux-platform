"""Rules that run in Prometheus: one `PrometheusRule` per target, written through the action
pipeline (review, confirm, audit, apply) like any other change to a cluster.

The server builds every object itself from the rule and its target (`desired_object`); nothing
the browser sends reaches the cluster. A review (`review`) is a server-built plan
(`make_plan`) whose action is `create` (no object yet), `edit` (the object is there) or
`delete` (the target is leaving, or no longer runs in Prometheus), so the pipeline's rules hold:
a delete on a production cluster asks for the name, and the production warning shows on every
one. Its handler, `PrometheusRuleAction`, is not in the pipeline's `ACTIONS`: the browser can
never ask for it.

The object is named once, when the target has none yet (`omnikrux-<slug>-<hash of the target
id>`, `object_name`); afterwards the target's `tool_object` names it, so renaming a rule never
makes a second object. It goes into the namespace of the Prometheus custom resource serving the
source (`serving_prometheus`, the same answer the capability check reads), labelled to meet that
resource's `ruleSelector` (refused in words when it can't be met).

An apply first reads the rule again: when what OmniKrux would write now differs from what was
reviewed, it is refused ("This rule changed since you reviewed it."). A write whose outcome isn't
known (the cluster didn't answer) still records the object on the target, so it is never
forgotten in the cluster."""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from fastapi import HTTPException
from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.actions.pipeline import (
    CANCELLED,
    MAX_OPEN_DELETE_PLANS,
    ActionError,
    Applied,
    ApplyContext,
    ClusterRef,
    Planned,
    PlanOut,
    Target,
    _failure,
    is_conflict,
    make_plan,
)
from omnikrux.exec.debug import finish_even_if_cancelled
from omnikrux.kube.http import call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.monitoring.alerts.rule_expr import duration_text, to_prometheus_template
from omnikrux.monitoring.alerts.store import (
    HistoryKind,
    HistoryRecord,
    RuleRecord,
    TargetRecord,
    ToolObject,
    UnknownRule,
    UnknownTarget,
    mark_unread,
)
from omnikrux.monitoring.models import AlertRuleRow, AlertTargetRow, lock_first, now
from omnikrux.monitoring.sources.prometheus_operator import (
    GROUP,
    MANAGED_BY,
    TARGET_LABEL,
    rule_labels,
    serving_prometheus,
)
from omnikrux.monitoring.sources.types import SourceConfig
from omnikrux.resources.kinds import KindSpec, object_name_problem

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

KIND_KEY = f"prometheusrules.{GROUP}"
API_VERSION = f"{GROUP}/v1"
MAX_SLUG = 40
# The alert labels OmniKrux sets itself start with this (and `severity`); a channel can't set them.
OWN_LABEL_PREFIX = "omnikrux_"

Mode = Literal["upsert", "delete"]

# -- copy --------------------------------------------------------------------------------------

CREATE_TITLE = "Create PrometheusRule {name}"
UPDATE_TITLE = "Update PrometheusRule {name}"
DELETE_TITLE = "Delete PrometheusRule {name}"
CREATE_SUMMARY = (
    'Runs the alert "{rule}" in Prometheus {namespace}/{service}, so it keeps firing when '
    "OmniKrux is off."
)
UPDATE_SUMMARY = 'Changes the alert "{rule}" that runs in Prometheus {namespace}/{service}.'
DELETE_SUMMARY = 'Stops running the alert "{rule}" in Prometheus {namespace}/{service}.'
DELETE_SUMMARY_NO_SOURCE = 'Stops running the alert "{rule}" in Prometheus in {namespace}.'
CONDITION_LINE = "Alert when {sentence}, checked every {every}."
CREATE_LABEL = "Create rule"
UPDATE_LABEL = "Update rule"
DELETE_LABEL = "Delete rule"
CANT_TELL = (
    "OmniKrux can't tell which Prometheus in {namespace} answers as {service}. "
    "Run this rule in OmniKrux instead."
)
NOTHING_CHANGES = "Nothing changes: the rule in the cluster already matches."
NOT_OURS = (
    "PrometheusRule {namespace}/{name} wasn't made by OmniKrux for this rule, so OmniKrux won't "
    "change or delete it. Remove or rename that object with kubectl, then review again."
)
STALE = "This rule changed since you reviewed it. Review it again."
RACED = "PrometheusRule {name} changed while OmniKrux read it. Try again."
NOT_IN_CLUSTER = (
    "This rule's source isn't reached through a cluster, so it can't run as a PrometheusRule. "
    "Run it in OmniKrux instead."
)
SOURCE_GONE = (
    "This rule's source no longer exists, so OmniKrux can't tell where its Prometheus is. "
    "Link a Prometheus source to the project again, or run the rule in OmniKrux."
)
UNKNOWN_OUTCOME = (
    "The cluster didn't say whether it made this change. Review the rule to check what is there."
)
CREATED = "Created PrometheusRule {namespace}/{name}."
UPDATED = "Updated PrometheusRule {namespace}/{name}."
DELETED = "Deleted PrometheusRule {namespace}/{name}."
ALREADY_GONE = "PrometheusRule {namespace}/{name} was already gone."
DEFAULT_SUMMARY = "{name} is {op} {threshold}"


# -- the object --------------------------------------------------------------------------------


def object_name(rule_name: str, target_id: str) -> str:
    """`omnikrux-<slug of the rule name, at most 40>-<first 8 hex of sha256(target id)>`; a name
    without ASCII letters or digits has the slug `rule`."""
    slug = re.sub(r"[^a-z0-9]+", "-", rule_name.lower()).strip("-")[:MAX_SLUG].strip("-")
    digest = hashlib.sha256(target_id.encode()).hexdigest()[:8]
    return f"omnikrux-{slug or 'rule'}-{digest}"


def _threshold(value: float) -> str:
    return repr(float(value)).removesuffix(".0")


def _literal(text: str) -> str:
    """`text` as Go template text that prints as written (every `{{` and `}}` quoted)."""
    out: list[str] = []
    i = 0
    while i < len(text):
        if text.startswith(("{{", "}}"), i):
            out.append('{{ "' + text[i : i + 2] + '" }}')
            i += 2
        else:
            out.append(text[i])
            i += 1
    return "".join(out)


def summary_template(rule: RuleRecord) -> str:
    """The alert's `summary` annotation: the rule's message, or what the rule says and the
    value."""
    if rule.message:
        return to_prometheus_template(rule.message)
    cond = rule.condition
    words = DEFAULT_SUMMARY.format(name=rule.name, op=cond.op, threshold=_threshold(cond.threshold))
    return f"{_literal(words)} ({{{{ $value }}}})"


def rule_group(rule: RuleRecord, target: TargetRecord) -> dict:
    """The rule group a tool runs for the target (a PrometheusRule's one group, or the group a
    Loki ruler holds): `omnikrux-<target id>`, at the rule's interval, with one alert whose
    labels carry the channel's labels, then the severity, the rule and the project (by id, which
    a rename doesn't change). OmniKrux's own labels win over the channel's."""
    cond = rule.condition
    alert_labels: dict[str, str] = {}
    if rule.channel is not None:
        alert_labels.update(
            {
                str(k): str(v)
                for k, v in rule.channel.labels.items()
                if not str(k).startswith(OWN_LABEL_PREFIX)
            }
        )
    alert_labels["severity"] = rule.severity
    alert_labels["omnikrux_rule"] = rule.id
    alert_labels["omnikrux_project"] = target.project_id
    return {
        "name": group_name(target.id),
        "interval": duration_text(cond.every_seconds),
        "rules": [
            {
                "alert": rule.name,
                "expr": target.rule_text,
                "for": duration_text(cond.for_seconds),
                "labels": alert_labels,
                "annotations": {
                    "summary": summary_template(rule),
                    "omnikrux_rule": rule.id,
                },
            }
        ],
    }


def group_name(target_id: str) -> str:
    """The name of the rule group that holds a target's rule in its tool."""
    return f"omnikrux-{target_id}"


def desired_object(
    rule: RuleRecord, target: TargetRecord, *, namespace: str, name: str, labels: dict[str, str]
) -> dict:
    """The PrometheusRule OmniKrux writes for the target: `labels` (what the Prometheus's
    `ruleSelector` needs) and OmniKrux's own on the object; its one group is `rule_group`."""
    return {
        "apiVersion": API_VERSION,
        "kind": "PrometheusRule",
        "metadata": {
            "name": name,
            "namespace": namespace,
            "labels": {**labels, MANAGED_BY: "omnikrux", TARGET_LABEL: target.id},
        },
        "spec": {"groups": [rule_group(rule, target)]},
    }


def object_hash(obj: dict) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode()).hexdigest()


def sentence(rule: RuleRecord) -> str:
    """ "any series is above 0.3 for 5 min" (no "for" when it fires at once)."""
    cond = rule.condition
    subject = "the total" if cond.of == "total" else "any series"
    text = f"{subject} is {cond.op} {_threshold(cond.threshold)}"
    if cond.for_seconds:
        text += f" for {_words(cond.for_seconds)}"
    return text


def _words(seconds: int) -> str:
    if seconds % 3600 == 0:
        return f"{seconds // 3600} h"
    if seconds % 60 == 0:
        return f"{seconds // 60} min"
    return f"{seconds} s"


# -- what a target needs -----------------------------------------------------------------------


def wanted_mode(target: TargetRecord) -> Mode | None:
    """`upsert` while the target runs in Prometheus; `delete` when it has (or may have) a
    PrometheusRule but no longer runs there (leaving, or moved to OmniKrux); None: nothing to do
    in a cluster."""
    if not target.leaving and target.engine == "tool" and target.tool_kind == "prometheus_rule":
        return "upsert"
    if target.tool_object is not None:
        return "delete" if target.tool_object.kind == "prometheus_rule" else None
    if target.tool_kind == "prometheus_rule" and target.applied_version is not None:
        return "delete"
    return None


@dataclass(frozen=True)
class Where:
    """Where a target's PrometheusRule is (or goes), and the Prometheus it runs in."""

    cluster_id: str
    namespace: str
    name: str
    source_id: str
    source_namespace: str | None
    source_service: str | None


class TransientRefusal(HTTPException):
    """A review refused for a passing reason (too many open reviews, or the object or the rule
    moved while it was read): the target stays as it was, and trying again works."""


def _object_path(namespace: str, name: str) -> str:
    return f"/apis/{GROUP}/v1/namespaces/{namespace}/prometheusrules/{name}"


async def _read(api: ApiClient, path: str) -> dict | None:
    """The object; None when it isn't there."""
    try:
        return await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)
    except ApiException as exc:
        if exc.status == 404:
            return None
        raise


class PrometheusRuleAction:
    """The pipeline handler for a target's PrometheusRule. `params` are made by the server
    (`review`): `target_id`, `mode` ("upsert" or "delete"), `rule_version`, `source_namespace`
    and `source_service`."""

    kinds = frozenset({KIND_KEY})

    def __init__(self, services: MonitoringServices) -> None:
        self._services = services

    # -- reviews -------------------------------------------------------------------------------

    async def where(self, target: TargetRecord, rule: RuleRecord, mode: Mode) -> Where:
        """Where the target's object is or goes; HTTPException when that can't be worked out."""
        obj = target.tool_object
        source: SourceConfig | None = None
        source_id = target.source_id
        if mode == "delete" and obj is not None:
            source_id = obj.source_id
        if source_id is not None:
            try:
                source = await self._services.sources.get(source_id)
            except KeyError:
                source = None
        place = source.cluster if source is not None else None
        if mode == "delete" and obj is not None and obj.cluster_id is not None:
            same = place is not None and place.cluster_id == obj.cluster_id
            return Where(
                cluster_id=obj.cluster_id,
                namespace=obj.namespace,
                name=obj.name,
                source_id=obj.source_id,
                source_namespace=place.namespace if same and place else None,
                source_service=place.service if same and place else None,
            )
        if source is None:
            raise HTTPException(status_code=409, detail=SOURCE_GONE)
        if place is None:
            raise HTTPException(status_code=409, detail=NOT_IN_CLUSTER)
        if obj is not None and obj.cluster_id == place.cluster_id:
            namespace, name = obj.namespace, obj.name  # named once: a rename keeps the object
        else:
            namespace, name = place.namespace, object_name(rule.name, target.id)
        return Where(
            cluster_id=place.cluster_id,
            namespace=namespace,
            name=name,
            source_id=source.id,
            source_namespace=place.namespace,
            source_service=place.service,
        )

    async def review(
        self, state, *, actor: str, target: TargetRecord, rule: RuleRecord, mode: Mode
    ) -> PlanOut | None:
        """The plan for the target's PrometheusRule; None when there is nothing to review: a
        delete finds the object gone already (the target is done with), or the object in the
        cluster already is what OmniKrux would write (the target is in sync). HTTPException in
        the pipeline's words."""
        where = await self.where(target, rule, mode)
        if (problem := object_name_problem(where.name, where.namespace)) is not None:
            raise HTTPException(status_code=422, detail=problem)
        exists = await self._exists(state, where)
        if mode == "delete" and exists is False:
            await self.removed(target, where, already_gone=True)
            return None
        if mode == "delete":
            action = "delete"
        else:
            known = exists if exists is not None else target.tool_object is not None
            action = "edit" if known else "create"
        try:
            plan = await make_plan(
                state,
                actor=actor,
                action=action,
                handler=self,
                target=Target(
                    cluster_id=where.cluster_id,
                    kind_key=KIND_KEY,
                    namespace=where.namespace,
                    name=where.name,
                ),
                params={
                    "target_id": target.id,
                    "mode": mode,
                    "rule_version": rule.version,
                    "source_namespace": where.source_namespace,
                    "source_service": where.source_service,
                    "exists": None if mode == "delete" else action == "edit",
                },
                limit=MAX_OPEN_DELETE_PLANS if action == "delete" else None,
            )
        except HTTPException as exc:
            # Too many open reviews, or the object or rule moved while it was read: nothing is
            # wrong with the rule, and trying again works.
            if exc.status_code == 429 or exc.detail in (RACED.format(name=where.name), STALE):
                raise TransientRefusal(exc.status_code, exc.detail) from exc
            raise
        stored = state.plans.peek(plan.plan_id)
        if stored is not None and stored.planned.state.get("unchanged"):
            state.plans.discard(plan.plan_id, actor)
            if await self._settle(target, rule.version, where):
                return None
            raise TransientRefusal(409, STALE)  # the rule changed while it was read
        return plan

    async def _exists(self, state, where: Where) -> bool | None:
        """Whether the object is there; None when the cluster can't tell now (the plan reads it
        again and says why)."""
        try:
            async with state.connections.api(where.cluster_id) as api:
                found = await _read(api, _object_path(where.namespace, where.name))
        except Exception:  # noqa: BLE001 (the plan reads again and answers in words)
            return None
        return found is not None

    async def _load(self, target_id: str) -> tuple[TargetRecord, RuleRecord]:
        try:
            target = await self._services.alerts.get_target(target_id)
            rule = await self._services.alerts.get_rule(target.rule_id)
        except (UnknownTarget, UnknownRule):
            raise ActionError(409, STALE) from None
        return target, rule

    # -- the pipeline's handler ----------------------------------------------------------------

    async def plan(
        self, api: ApiClient, spec: KindSpec, target: Target, params: dict, *, cluster: ClusterRef
    ) -> Planned:
        record, rule = await self._load(params["target_id"])
        mode: Mode = params["mode"]
        if rule.version != params["rule_version"] or wanted_mode(record) != mode:
            raise ActionError(409, STALE)
        ns, svc = params.get("source_namespace"), params.get("source_service")
        live = await _read(api, spec.object_path(target.namespace, target.name))
        state = {
            "target_id": record.id,
            "mode": mode,
            "rule_version": rule.version,
            "source_id": (
                record.tool_object.source_id
                if record.tool_object is not None and mode == "delete"
                else record.source_id
            ),
        }
        if mode == "delete":
            return self._delete_plan(target, rule, record, live, ns, svc, state)
        if (live is not None) != params.get("exists"):
            raise ActionError(409, RACED.format(name=target.name))
        title = (UPDATE_TITLE if live is not None else CREATE_TITLE).format(name=target.name)
        first = UPDATE_SUMMARY if live is not None else CREATE_SUMMARY
        summary = [
            first.format(rule=rule.name, namespace=ns, service=svc),
            CONDITION_LINE.format(
                sentence=sentence(rule), every=_words(rule.condition.every_seconds)
            ),
        ]
        label = UPDATE_LABEL if live is not None else CREATE_LABEL

        def refused(reason: str) -> Planned:
            return Planned(
                title=title, summary=summary, blocked=[reason], apply_label=label, state=state
            )

        if live is not None and not self._ours(live, record):
            return refused(NOT_OURS.format(namespace=target.namespace, name=target.name))
        prometheus = await serving_prometheus(lambda path: _read(api, path), ns, svc)
        if prometheus is None:
            return refused(CANT_TELL.format(namespace=ns, service=svc))
        labels, problem = await rule_labels(
            lambda path: _read(api, path), prometheus, target.namespace or ""
        )
        if problem is not None:
            return refused(problem)
        desired = desired_object(
            rule, record, namespace=target.namespace, name=target.name, labels=labels
        )
        state |= {"labels": labels, "hash": object_hash(desired), "exists": live is not None}
        if live is None:
            state["body"] = desired
            return Planned(
                title=title,
                summary=summary,
                before=None,
                after=desired,
                apply_label=label,
                state=state,
            )
        body = copy.deepcopy(live)
        body.pop("status", None)
        md = body.setdefault("metadata", {})
        md.pop("managedFields", None)
        md["labels"] = {**(md.get("labels") or {}), **desired["metadata"]["labels"]}
        body["apiVersion"], body["kind"], body["spec"] = (
            API_VERSION,
            "PrometheusRule",
            desired["spec"],
        )
        live_md = live.get("metadata") or {}
        state |= {
            "body": body,
            "resourceVersion": live_md.get("resourceVersion"),
            "uid": live_md.get("uid"),
        }
        wanted_labels = desired["metadata"]["labels"].items()
        if (
            live.get("spec") == desired["spec"]
            and wanted_labels <= (live_md.get("labels") or {}).items()
        ):
            state["unchanged"] = True
            return Planned(
                title=title,
                summary=summary,
                blocked=[NOTHING_CHANGES],
                before=live,
                after=body,
                apply_label=label,
                state=state,
            )
        return Planned(
            title=title, summary=summary, before=live, after=body, apply_label=label, state=state
        )

    def _delete_plan(
        self,
        target: Target,
        rule: RuleRecord,
        record: TargetRecord,
        live: dict | None,
        ns: str | None,
        svc: str | None,
        state: dict,
    ) -> Planned:
        if live is None:
            raise ActionError(409, RACED.format(name=target.name))
        if ns is not None and svc is not None:
            line = DELETE_SUMMARY.format(rule=rule.name, namespace=ns, service=svc)
        else:
            line = DELETE_SUMMARY_NO_SOURCE.format(rule=rule.name, namespace=target.namespace)
        md = live.get("metadata") or {}
        state |= {"uid": md.get("uid"), "resourceVersion": md.get("resourceVersion")}
        blocked = []
        if not self._ours(live, record):
            blocked.append(NOT_OURS.format(namespace=target.namespace, name=target.name))
        return Planned(
            title=DELETE_TITLE.format(name=target.name),
            summary=[line],
            blocked=blocked,
            before=live,
            after=None,
            apply_label=DELETE_LABEL,
            state=state,
        )

    @staticmethod
    def _ours(live: dict, record: TargetRecord) -> bool:
        labels = (live.get("metadata") or {}).get("labels") or {}
        return labels.get(TARGET_LABEL) == record.id

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        state = planned.state
        mode: Mode = state["mode"]
        record, rule = await self._load(state["target_id"])
        if rule.version != state["rule_version"] or wanted_mode(record) != mode:
            raise ActionError(409, STALE)
        if mode == "upsert":
            desired = desired_object(
                rule, record, namespace=target.namespace, name=target.name, labels=state["labels"]
            )
            if object_hash(desired) != state["hash"]:
                raise ActionError(409, STALE)
        where = Where(
            cluster_id=target.cluster_id,
            namespace=target.namespace or "",
            name=target.name,
            source_id=state["source_id"] or "",
            source_namespace=None,
            source_service=None,
        )
        action = "delete" if mode == "delete" else ("edit" if state["exists"] else "create")
        path = spec.object_path(target.namespace, target.name)
        gone_already = False
        try:
            if mode == "delete":
                body = {"preconditions": {"uid": state["uid"]}}
                try:
                    await call_json(ctx.api, "DELETE", path, timeout=REQUEST_TIMEOUT, body=body)
                except ApiException as exc:
                    if exc.status != 404:  # gone already: that is what was asked
                        raise
                    gone_already = True
            elif state["exists"]:
                body = copy.deepcopy(state["body"])
                body["metadata"]["resourceVersion"] = state["resourceVersion"]
                await call_json(ctx.api, "PUT", path, timeout=REQUEST_TIMEOUT, body=body)
            else:
                await call_json(
                    ctx.api,
                    "POST",
                    spec.list_path(target.namespace),
                    timeout=REQUEST_TIMEOUT,
                    body=state["body"],
                )
        except BaseException as exc:
            await finish_even_if_cancelled(
                self._failed(record, rule, where, exc, action, spec, target, state)
            )
            raise
        if mode == "delete":
            await self.removed(record, where, already_gone=gone_already)
            template = ALREADY_GONE if gone_already else DELETED
            return Applied(template.format(namespace=target.namespace, name=target.name))
        template = UPDATED if state["exists"] else CREATED
        message = template.format(namespace=target.namespace, name=target.name)
        try:
            # The rule may have been saved while the cluster wrote: then what is there is the
            # reviewed version, and the target needs a review of the newer one.
            await self._settle(record, rule.version, where)
            await self._history(record, "applied", message)
        except UnknownTarget:
            log.warning("Alert target %s went while its PrometheusRule was applied", record.id)
        return Applied(message)

    # -- what the target records ---------------------------------------------------------------

    @staticmethod
    def _object(where: Where) -> ToolObject:
        return ToolObject(
            kind="prometheus_rule",
            source_id=where.source_id,
            cluster_id=where.cluster_id,
            namespace=where.namespace,
            name=where.name,
        )

    async def _settle(self, target: TargetRecord, rule_version: int, where: Where) -> bool:
        """The cluster holds the object for `rule_version` of the rule: record it on the target
        and say whether the target is in sync. In one transaction that holds the write lock, so a
        save of the rule either landed before (seen here: the target needs a review of the newer
        version) or lands after (and its own hand-off marks the target for review). The target
        is in sync only while the rule is still at that version and the target still runs in
        Prometheus with the same rule text. UnknownTarget."""
        alerts = self._services.alerts
        async with self._services.sessionmaker.begin() as session:
            await lock_first(session)
            rule_row = await session.get(AlertRuleRow, target.rule_id)
            row = await session.get(AlertTargetRow, target.id)
            if row is None:
                raise UnknownTarget(target.id)
            same = (
                rule_row is not None
                and rule_row.deleted_at is None
                and rule_row.version == rule_version
                and not row.leaving
                and row.engine == "tool"
                and row.tool_kind == "prometheus_rule"
                and row.rule_text == target.rule_text
            )
            mark_unread(row, now())
            await alerts.set_tool(
                target.id,
                tool_state="in_sync" if same else "needs_review",
                tool_message=None,
                tool_object=self._object(where),
                applied_version=rule_version,
                session=session,
            )
        return same

    async def removed(self, target: TargetRecord, where: Where, *, already_gone: bool) -> None:
        """The target's PrometheusRule is gone (`already_gone`: before OmniKrux deleted it): a
        leaving target goes (and a deleted rule left without targets with it); one that now runs
        in OmniKrux forgets its object."""
        template = ALREADY_GONE if already_gone else DELETED
        try:
            await self._history(
                target, "removed", template.format(namespace=where.namespace, name=where.name)
            )
            if target.leaving:
                await self._services.alert_sync.forget_target(target)
            else:
                await self._services.alerts.set_tool(
                    target.id,
                    tool_state=None,
                    tool_message=None,
                    tool_object=None,
                    applied_version=None,
                )
        except UnknownTarget:
            pass

    async def _history(self, target: TargetRecord, kind: HistoryKind, message: str) -> None:
        await self._services.alerts.add_history(
            [
                HistoryRecord(
                    id=None,
                    target_id=target.id,
                    rule_id=target.rule_id,
                    project_id=target.project_id,
                    at=now(),
                    kind=kind,
                    message=message,
                )
            ]
        )

    async def _failed(
        self,
        record: TargetRecord,
        rule: RuleRecord,
        where: Where,
        exc: BaseException,
        action: str,
        spec: KindSpec,
        target: Target,
        state: dict,
    ) -> None:
        """The apply failed: the target reads "failed" with the pipeline's words, and the
        history says so; when the object changed in the cluster since the review (a conflict),
        it needs a review again instead. When the outcome isn't known (no answer, a timeout, a
        cancel, or a 5xx: the API server may have committed the write anyway), the object is
        recorded as possibly applied, so it is never forgotten in the cluster, and the target
        needs a review, which reads what is there."""
        if isinstance(exc, Exception):
            message = str(_failure(exc, action, spec, target).detail)
        else:
            message = CANCELLED
        if isinstance(exc, ApiException):
            unknown = exc.status is None or exc.status >= 500
        else:
            unknown = not isinstance(exc, ActionError)
        extra: dict = {}
        if unknown and state["mode"] == "upsert":
            extra = {"tool_object": self._object(where), "applied_version": rule.version}
        if is_conflict(exc):
            tool_state, tool_message = "needs_review", None
        elif unknown:
            tool_state, tool_message = "needs_review", UNKNOWN_OUTCOME
        else:
            tool_state, tool_message = "failed", message
        try:
            await self._services.alerts.set_tool(
                record.id, tool_state=tool_state, tool_message=tool_message, **extra
            )
            await self._history(record, "apply_failed", message)
        except UnknownTarget:
            pass
        except Exception as err:  # noqa: BLE001 (the apply's own failure is what is answered)
            log.warning("Recording a failed PrometheusRule apply failed (%s)", type(err).__name__)
