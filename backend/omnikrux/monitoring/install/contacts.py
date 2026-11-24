"""OmniKrux's contact points in the Alertmanager it installed: an `AlertmanagerConfig` that routes
the alerts of each rule running in the installed tools to its contact points, and the Secret its
receivers read their addresses, keys and passwords from.

Both are written through the action pipeline (`ContactSyncAction`: review, confirm, audit,
apply) as `create`, `edit` or `delete`. The secret values come only from M4's `export_receivers`,
which refuses any Alertmanager OmniKrux didn't install (`SecretRuleRefused`), and exist only
while the Secret's body and the digest are built: the review, its diff and the audit show the
AlertmanagerConfig alone (it names Secret keys, never values), and the plan keeps only a SHA-256
digest of the whole configuration. An apply works the configuration out again and refuses when
its digest differs from the reviewed one ("Review it again").

`contact_changes` tells a rule, link, dashboard or contact-point save which installs now need a
review of their contact points; it never raises and never stops a save."""

from __future__ import annotations

import copy
import hashlib
import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import quote

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.actions.pipeline import (
    CANCELLED,
    CONFLICT,
    ActionError,
    Applied,
    ApplyContext,
    ClusterRef,
    Planned,
    Target,
    is_conflict,
)
from omnikrux.exec.debug import finish_even_if_cancelled
from omnikrux.kube.connections import kube_error_message
from omnikrux.kube.discovery import ApiResource
from omnikrux.kube.http import call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.monitoring.alerts.contact_points.export import (
    ReceiverExport,
    SecretRuleRefused,
    export_receivers,
)
from omnikrux.monitoring.alerts.contact_points.types import (
    DEFAULT_EVENTS_URL,
    TYPE_LABELS,
    SecretsUnreadable,
)
from omnikrux.monitoring.alerts.sync import AlertChange
from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.store import InstallRecord
from omnikrux.monitoring.install.values import AMC_NAME, MANAGED_BY
from omnikrux.monitoring.models import now
from omnikrux.resources.catalog import KindNotServed
from omnikrux.resources.kinds import KindSpec, generic_spec

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

GROUP = "monitoring.coreos.com"
KIND_KEY = f"alertmanagerconfigs.{GROUP}"
API_VERSION = f"{GROUP}/v1alpha1"
MANAGED_LABEL = "app.kubernetes.io/managed-by"
AMC_PATH = "/apis/" + API_VERSION + "/namespaces/{namespace}/alertmanagerconfigs"
SECRET_PATH = "/api/v1/namespaces/{namespace}/secrets"
NONE_RECEIVER = "omnikrux-none"
RULE_LABEL = "omnikrux_rule"
GROUP_BY = ["alertname", RULE_LABEL, "omnikrux_project"]
DIRECT_TLS_PORT = 465

Mode = Literal["upsert", "delete"]


class NoAlertmanager(Exception):
    """The install has no Alertmanager source: there is nowhere to send contact points."""

    def __init__(self) -> None:
        super().__init__(messages.NO_ALERTMANAGER)
        self.message = messages.NO_ALERTMANAGER


@dataclass(frozen=True)
class ReceiverLine:
    """One contact point the configuration sends to, for the review's summary."""

    contact_point_id: str
    name: str
    type_label: str
    rule_names: tuple[str, ...]


@dataclass(frozen=True)
class DesiredContacts:
    """The configuration OmniKrux wants in its Alertmanager now. `amc` is None when no rule
    routes anywhere; `secret_data` holds the values (never shown, logged or stored; only
    `digest` is kept); `skipped` names the contact points Alertmanager can't send to, and why."""

    amc: dict | None
    secret_data: Mapping[str, str] = field(repr=False)
    skipped: tuple[tuple[str, str], ...]
    rules: tuple[str, ...]
    contact_points: tuple[str, ...]
    digest: str
    receivers: tuple[ReceiverLine, ...] = ()


def _digest(spec: dict | None, secret_data: Mapping[str, str]) -> str:
    """SHA-256 of the canonical JSON of the AlertmanagerConfig's spec and the sorted
    (key, SHA-256 of the value) pairs: a change of any value changes it, and no value is in it."""
    pairs = [
        [key, hashlib.sha256(secret_data[key].encode()).hexdigest()] for key in sorted(secret_data)
    ]
    text = json.dumps({"spec": spec, "secrets": pairs}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode()).hexdigest()


def _ref(key: str) -> dict:
    return {"name": AMC_NAME, "key": key}


def _receiver(
    export: ReceiverExport, secret_data: dict[str, str]
) -> tuple[dict | None, str | None]:
    """The receiver of one contact point (its secret values added to `secret_data`), or the
    reason Alertmanager can't send to it."""
    name = f"cp-{export.contact_point_id}"
    settings, secrets = export.settings, export.secrets

    def secret(field: str) -> dict | None:
        value = secrets.get(field)
        if not value:
            return None
        key = f"{name}-{field}"
        secret_data[key] = value
        return _ref(key)

    receiver: dict[str, Any] = {"name": name}
    if export.type == "slack":
        receiver["slackConfigs"] = [{"apiURL": secret("webhook_url"), "sendResolved": True}]
    elif export.type == "teams":
        receiver["msteamsv2Configs"] = [{"webhookURL": secret("webhook_url"), "sendResolved": True}]
    elif export.type == "pagerduty":
        receiver["pagerdutyConfigs"] = [
            {
                "routingKey": secret("routing_key"),
                "url": settings.get("events_url") or DEFAULT_EVENTS_URL,
                "severity": "{{ .CommonLabels.severity }}",
                "sendResolved": True,
            }
        ]
    elif export.type == "webhook":
        config: dict[str, Any] = {"urlSecret": secret("url"), "sendResolved": True}
        token = secret("bearer_token")
        if token is not None:
            config["httpConfig"] = {"authorization": {"type": "Bearer", "credentials": token}}
        receiver["webhookConfigs"] = [config]
    else:  # email
        security = settings.get("security") or "starttls"
        port = settings.get("port")
        if security == "tls" and port != DIRECT_TLS_PORT:
            return None, messages.EMAIL_TLS_PORT
        to = settings.get("to") or []
        email: dict[str, Any] = {
            "to": ", ".join(str(a) for a in to),
            "from": settings.get("from_address"),
            "smarthost": f"{settings.get('host')}:{port}",
            "requireTLS": security == "starttls",
            "sendResolved": True,
        }
        if settings.get("username"):
            email["authUsername"] = settings["username"]
        password = secret("password")
        if password is not None:
            email["authPassword"] = password
        receiver["emailConfigs"] = [email]
    return _sorted(receiver), None


def _sorted(value: Any) -> Any:
    """Every mapping with its keys in order (lists keep theirs)."""
    if isinstance(value, dict):
        return {k: _sorted(value[k]) for k in sorted(value)}
    if isinstance(value, list):
        return [_sorted(v) for v in value]
    return value


async def desired_contacts(services: MonitoringServices, record: InstallRecord) -> DesiredContacts:
    """What OmniKrux's Alertmanager should hold now: the rules with a tool target (not leaving,
    the rule not deleted) on the install's Prometheus or Loki source, and their contact points,
    read through `export_receivers` (SecretRuleRefused for an Alertmanager OmniKrux didn't
    install; SecretsUnreadable, UnknownContactPoint and KeyError as it raises them).
    NoAlertmanager when the install has no Alertmanager source."""
    if record.alertmanager_source_id is None:
        raise NoAlertmanager()
    sources = {s for s in (record.prometheus_source_id, record.loki_source_id) if s is not None}
    rules = {r.id: r for r in await services.alerts.list_rules()}
    routed: dict[str, list[str]] = {}  # rule id -> its contact point ids
    for target in await services.alerts.targets():
        rule = rules.get(target.rule_id)
        if (
            rule is None
            or rule.deleted_at is not None
            or target.engine != "tool"
            or target.leaving
            or target.source_id not in sources
            or not rule.contact_point_ids
        ):
            continue
        routed[rule.id] = sorted(set(rule.contact_point_ids))
    cp_ids = sorted({cp for ids in routed.values() for cp in ids})
    exports = await export_receivers(
        services, alertmanager_source_id=record.alertmanager_source_id, contact_point_ids=cp_ids
    )
    secret_data: dict[str, str] = {}
    receivers: list[dict] = []
    skipped: list[tuple[str, str]] = []
    lines: list[ReceiverLine] = []
    sent: set[str] = set()
    for export in sorted(exports, key=lambda e: e.contact_point_id):
        receiver, reason = _receiver(export, secret_data)
        if receiver is None:
            skipped.append((export.name, reason or ""))
            continue
        receivers.append(receiver)
        sent.add(export.contact_point_id)
        names = sorted(
            (rules[r].name for r, ids in routed.items() if export.contact_point_id in ids),
            key=str.casefold,
        )
        lines.append(
            ReceiverLine(
                contact_point_id=export.contact_point_id,
                name=export.name,
                type_label=TYPE_LABELS.get(export.type, export.type),
                rule_names=tuple(names),
            )
        )
    routes = [
        {
            "receiver": f"cp-{cp}",
            "continue": True,
            "matchers": [{"name": RULE_LABEL, "value": rule_id, "matchType": "="}],
        }
        for rule_id in sorted(routed)
        for cp in routed[rule_id]
        if cp in sent
    ]
    amc: dict | None = None
    spec: dict | None = None
    if routes:
        spec = _sorted(
            {
                "route": {
                    "receiver": NONE_RECEIVER,
                    "groupBy": list(GROUP_BY),
                    "groupWait": "30s",
                    "groupInterval": "5m",
                    "repeatInterval": "4h",
                    "routes": routes,
                },
                "receivers": [{"name": NONE_RECEIVER}, *receivers],
            }
        )
        amc = {
            "apiVersion": API_VERSION,
            "kind": "AlertmanagerConfig",
            "metadata": {
                "labels": {MANAGED_LABEL: MANAGED_BY},
                "name": AMC_NAME,
                "namespace": record.namespace,
            },
            "spec": spec,
        }
    else:
        secret_data = {}
    used_rules = sorted({r for r, ids in routed.items() if any(cp in sent for cp in ids)})
    return DesiredContacts(
        amc=amc,
        secret_data=secret_data,
        skipped=tuple(skipped),
        rules=tuple(used_rules),
        contact_points=tuple(sorted(sent)) if routes else (),
        digest=_digest(spec, secret_data),
        receivers=tuple(lines) if routes else (),
    )


def problem_words(exc: Exception, record: InstallRecord) -> str:
    """Why the configuration can't be worked out, in words (never a value)."""
    if isinstance(exc, (SecretRuleRefused, SecretsUnreadable, NoAlertmanager)):
        return exc.message
    return messages.CONTACTS_UNKNOWN.format(namespace=record.namespace)


def in_sync(desired: DesiredContacts, record: InstallRecord) -> bool:
    """Whether the Alertmanager holds what OmniKrux wants (as far as its record says)."""
    if desired.amc is None:
        return record.contacts_digest is None
    return desired.digest == record.contacts_digest


async def contact_changes(services: MonitoringServices) -> list[AlertChange]:
    """One `contacts` change per install whose contact points need a review now. Never raises:
    an install whose configuration can't be worked out gives no change, keeps the words why
    (`contacts_message`) and is logged by the error's type only."""
    try:
        records = await services.installs.list()
    except Exception as exc:  # noqa: BLE001 (a save never fails over contact points)
        log.warning("Reading the installs for their contact points failed (%s)", type(exc).__name__)
        return []
    changes: list[AlertChange] = []
    for record in records:
        if record.alertmanager_source_id is None or record.state != "installed":
            continue
        try:
            change = await _change(services, record)
        except Exception as exc:  # noqa: BLE001 (as above; logged by type)
            log.warning("Checking the contact points of an install failed (%s)", type(exc).__name__)
            continue
        if change is not None:
            changes.append(change)
    return changes


async def _change(services: MonitoringServices, record: InstallRecord) -> AlertChange | None:
    try:
        desired = await desired_contacts(services, record)
    except Exception as exc:  # noqa: BLE001 (said in words on the record; logged by type)
        log.info("The contact points of an install can't be worked out (%s)", type(exc).__name__)
        words = problem_words(exc, record)
        if record.contacts_message != words:
            await services.installs.set_contacts_message(record.cluster_id, words)
        return None
    if record.contacts_message is not None:
        # What failed before is behind it: the configuration can be worked out again.
        await services.installs.set_contacts_message(record.cluster_id, None)
    if in_sync(desired, record):
        return None
    try:
        name = (await services.discovery.registry.get(record.cluster_id)).name
    except KeyError:
        name = record.cluster_id
    return AlertChange(
        target_id="",
        rule_id="",
        rule_name="",
        project_id="",
        project_name=name,
        kind="contacts",
        message=messages.CONTACTS_NEED_REVIEW.format(namespace=record.namespace),
        tool=None,
        cluster_id=record.cluster_id,
    )


# -- the review ------------------------------------------------------------------------------------


def _q(text: str) -> str:
    return quote(text, safe="")


def amc_list_path(namespace: str) -> str:
    return AMC_PATH.format(namespace=_q(namespace))


def amc_path(namespace: str) -> str:
    return f"{amc_list_path(namespace)}/{AMC_NAME}"


def secret_list_path(namespace: str) -> str:
    return SECRET_PATH.format(namespace=_q(namespace))


def secret_path(namespace: str) -> str:
    return f"{secret_list_path(namespace)}/{AMC_NAME}"


async def read_object(api: ApiClient, path: str) -> dict | None:
    """The object at `path`; None when it isn't there."""
    try:
        found = await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)
    except ApiException as exc:
        if exc.status == 404:
            return None
        raise
    return found if isinstance(found, dict) else None


def _meta(obj: dict | None) -> dict:
    md = obj.get("metadata") if obj is not None else None
    return md if isinstance(md, dict) else {}


def _ours(obj: dict) -> bool:
    labels = _meta(obj).get("labels")
    return isinstance(labels, dict) and labels.get(MANAGED_LABEL) == MANAGED_BY


def _shown(live: dict) -> dict:
    """The live AlertmanagerConfig as the review shows it (no status, no managed fields)."""
    body = copy.deepcopy(live)
    body.pop("status", None)
    _meta(body).pop("managedFields", None)
    return body


# The AlertmanagerConfig is served at monitoring.coreos.com/v1alpha1, which isn't the group's
# preferred version (v1), so the app's kind catalog (preferred versions only) never lists it.
AMC_SPEC = generic_spec(
    ApiResource(
        group=GROUP,
        version="v1alpha1",
        plural="alertmanagerconfigs",
        kind="AlertmanagerConfig",
        namespaced=True,
        verbs=frozenset({"get", "list", "create", "update", "delete"}),
        short_names=(),
    ),
    None,
)


class _Catalog:
    """The app's kind catalog, with the AlertmanagerConfig's spec when the catalog doesn't list
    it (the plan checks that the cluster serves it)."""

    def __init__(self, catalog: Any) -> None:
        self._catalog = catalog

    async def spec(self, cluster_id: str, key: str) -> KindSpec:
        try:
            return await self._catalog.spec(cluster_id, key)
        except KindNotServed:
            if key != KIND_KEY:
                raise
            return AMC_SPEC


class PlanState:
    """The app's state as `make_plan` reads it, with `_Catalog` in place of its catalog."""

    def __init__(self, state: Any) -> None:
        self._state = state
        self.catalog = _Catalog(state.catalog)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._state, name)


async def _served(api: ApiClient) -> bool:
    """Whether the cluster serves AlertmanagerConfigs at the version OmniKrux writes."""
    try:
        found = await call_json(api, "GET", f"/apis/{API_VERSION}", timeout=REQUEST_TIMEOUT)
    except ApiException as exc:
        if exc.status == 404:
            return False
        raise
    resources = found.get("resources") if isinstance(found, dict) else None
    return isinstance(resources, list) and any(
        isinstance(r, dict) and r.get("name") == "alertmanagerconfigs" for r in resources
    )


OUR_ALERTMANAGER = "omnikrux-metrics-alertmanager"  # the Alertmanager the metrics release asks for
ALERTMANAGERS_PATH = f"/apis/{GROUP}/v1/alertmanagers"
NAMESPACE_PATH = "/api/v1/namespaces/{namespace}"


def state_problem(record: InstallRecord) -> str | None:
    """Why the record's tools can't take contact points now (an install or uninstall running,
    or one that didn't finish); None when they are installed."""
    if record.state == "installed":
        return None
    if record.state == "uninstalling":
        return messages.CONTACTS_UNINSTALLING.format(namespace=record.namespace)
    if record.state == "installing":
        return messages.CONTACTS_INSTALLING.format(namespace=record.namespace)
    return messages.CONTACTS_NOT_INSTALLED.format(namespace=record.namespace)


def selector_matches(selector: Any, labels: Mapping[str, str]) -> bool:
    """Whether a label selector selects an object with `labels` (`{}` selects everything). A
    selector OmniKrux can't read is taken to select it: the check errs on the side of refusing."""
    if not isinstance(selector, dict):
        return True
    match = selector.get("matchLabels") or {}
    if not isinstance(match, dict):
        return True
    if any(labels.get(k) != v for k, v in match.items()):
        return False
    for term in selector.get("matchExpressions") or []:
        if not isinstance(term, dict):
            return True
        key, op = term.get("key"), term.get("operator")
        values = term.get("values") or []
        has = key in labels
        if op == "In" and not (has and labels[key] in values):
            return False
        if op == "NotIn" and has and labels[key] in values:
            return False
        if op == "Exists" and not has:
            return False
        if op == "DoesNotExist" and has:
            return False
    return True


async def other_readers(api: ApiClient, namespace: str) -> list[str]:
    """The Alertmanagers other than OmniKrux's that would select its AlertmanagerConfig in
    `namespace` ("{namespace}/{name}"): a config selector that matches its labels (none: it
    selects nothing; `{}`: everything) and a namespace selector that matches the namespace
    (none: only the Alertmanager's own namespace). Raises when they can't be read."""
    listed = await call_json(api, "GET", ALERTMANAGERS_PATH, timeout=REQUEST_TIMEOUT)
    items = listed.get("items") if isinstance(listed, dict) else None
    if not isinstance(items, list):
        raise TypeError("not a list of Alertmanagers")
    ours = {MANAGED_LABEL: MANAGED_BY}
    namespace_labels: dict[str, str] | None = None
    found: list[str] = []
    for item in items:
        md = _meta(item if isinstance(item, dict) else None)
        where = (md.get("namespace"), md.get("name"))
        if where == (namespace, OUR_ALERTMANAGER):
            continue
        spec = item.get("spec") if isinstance(item, dict) else None
        spec = spec if isinstance(spec, dict) else {}
        selector = spec.get("alertmanagerConfigSelector")
        if selector is None or not selector_matches(selector, ours):
            continue
        by_namespace = spec.get("alertmanagerConfigNamespaceSelector")
        if by_namespace is None:
            selects = where[0] == namespace
        else:
            if namespace_labels is None:
                namespace_labels = await _namespace_labels(api, namespace)
            selects = selector_matches(by_namespace, namespace_labels)
        if selects:
            found.append(f"{where[0]}/{where[1]}")
    return sorted(found)


async def _namespace_labels(api: ApiClient, namespace: str) -> dict[str, str]:
    path = NAMESPACE_PATH.format(namespace=_q(namespace))
    obj = await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)
    labels = _meta(obj).get("labels") if isinstance(obj, dict) else None
    out = {str(k): str(v) for k, v in labels.items()} if isinstance(labels, dict) else {}
    # Kubernetes sets this label on every namespace itself.
    out["kubernetes.io/metadata.name"] = namespace
    return out


async def reader_problems(api: ApiClient, namespace: str) -> list[str]:
    """Why the contact points can't go to `namespace`'s Alertmanager now: another
    Alertmanager would read them, or that can't be checked (in words; never proceeds)."""
    try:
        readers = await other_readers(api, namespace)
    except Exception as exc:  # noqa: BLE001 (can't check: refused in words; logged by type)
        log.info("Checking which Alertmanagers read contact points failed (%s)", type(exc).__name__)
        words = kube_error_message(exc, messages.CONTACTS_LIST_ALERTMANAGERS_STEP).rstrip(".")
        return [messages.CONTACTS_ALERTMANAGERS_UNCHECKED.format(words=words)]
    return [
        messages.CONTACTS_OTHER_ALERTMANAGER.format(where=where, namespace=namespace)
        for where in readers
    ]


def _apply_words(exc: Exception, action: str, target: Target) -> str:
    """A failed apply in the pipeline's words (never a value), for the install record."""
    if isinstance(exc, ActionError):
        return exc.message
    detail = getattr(exc, "detail", None)
    if isinstance(detail, str):
        return detail
    if is_conflict(exc):
        return CONFLICT.format(kind="AlertmanagerConfig", name=target.name)
    return kube_error_message(exc, f"{action} AlertmanagerConfig {target.namespace}/{target.name}")


def _and(words: Sequence[str]) -> str:
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " and " + words[-1]


class ContactSyncAction:
    """The pipeline handler for OmniKrux's AlertmanagerConfig and its Secret in the namespace it
    installed into. `params` are made by the server (`api.sync_contacts`): `mode` ("upsert" or
    "delete") and `exists` (whether the AlertmanagerConfig was there when the route looked). Not
    in the pipeline's `ACTIONS`: the browser can never ask for it."""

    kinds = frozenset({KIND_KEY})

    def __init__(self, services: MonitoringServices) -> None:
        self._services = services

    async def _record(self, cluster_id: str) -> InstallRecord:
        record = await self._services.installs.get(cluster_id)
        if record is None or record.alertmanager_source_id is None:
            raise ActionError(409, messages.NO_ALERTMANAGER)
        if (problem := state_problem(record)) is not None:
            raise ActionError(409, problem)
        return record

    async def _desired(self, record: InstallRecord) -> DesiredContacts:
        try:
            return await desired_contacts(self._services, record)
        except (SecretRuleRefused, SecretsUnreadable, NoAlertmanager, KeyError) as exc:
            raise ActionError(409, problem_words(exc, record)) from None

    async def plan(
        self, api: ApiClient, spec: KindSpec, target: Target, params: dict, *, cluster: ClusterRef
    ) -> Planned:
        record = await self._record(cluster.id)
        namespace = target.namespace or record.namespace
        desired = await self._desired(record)
        mode: Mode = params["mode"]
        if not await _served(api):
            raise ActionError(404, KindNotServed(KIND_KEY).message)
        live = await read_object(api, amc_path(namespace))
        secret = await read_object(api, secret_path(namespace))
        raced = ActionError(409, messages.CONTACTS_RACED.format(namespace=namespace))
        if mode == "delete":
            if desired.amc is not None or (live is None and secret is None):
                raise raced
        elif desired.amc is None or (live is not None) != bool(params.get("exists")):
            raise raced

        blocked = [
            messages.CONTACTS_NOT_OURS.format(kind=kind, namespace=namespace)
            for kind, obj in (("AlertmanagerConfig", live), ("Secret", secret))
            if obj is not None and not _ours(obj)
        ]
        state = {
            "mode": mode,
            "digest": desired.digest,
            "exists": {"amc": live is not None, "secret": secret is not None},
            "resourceVersions": {
                "amc": _meta(live).get("resourceVersion"),
                "secret": _meta(secret).get("resourceVersion"),
            },
            "uids": {"amc": _meta(live).get("uid"), "secret": _meta(secret).get("uid")},
        }
        if mode == "delete":
            # Nothing leaves OmniKrux in a removal: no other Alertmanager to check.
            return Planned(
                title=messages.CONTACTS_DELETE_TITLE.format(namespace=namespace),
                summary=[messages.CONTACTS_DELETE_SUMMARY.format(cluster=cluster.name)],
                blocked=blocked,
                before=_shown(live) if live is not None else None,
                after=None,
                apply_label=messages.CONTACTS_REMOVE_LABEL,
                state=state,
            )
        assert desired.amc is not None
        summary = [messages.CONTACTS_SUMMARY.format(cluster=cluster.name)]
        summary += [
            messages.CONTACTS_LINE.format(
                name=line.name, type=line.type_label, rules=_and(list(line.rule_names))
            )
            for line in desired.receivers
        ]
        summary.append(messages.CONTACTS_SECRET_LINE.format(k=len(desired.secret_data)))
        warnings = [
            messages.CONTACTS_SKIPPED.format(name=name, reason=reason)
            for name, reason in desired.skipped
        ]
        blocked += await reader_problems(api, namespace)
        n = len(desired.contact_points)
        if live is None:
            if n == 1:
                title = messages.CONTACTS_CREATE_TITLE_ONE.format(namespace=namespace)
            else:
                title = messages.CONTACTS_CREATE_TITLE.format(n=n, namespace=namespace)
            label, before, after = messages.CONTACTS_APPLY_LABEL, None, desired.amc
        else:
            title = messages.CONTACTS_UPDATE_TITLE.format(namespace=namespace)
            label = messages.CONTACTS_UPDATE_LABEL
            before, after = _shown(live), _updated(live, desired.amc)
        state["body"] = after  # exactly what the apply writes (it names Secret keys, no values)
        return Planned(
            title=title,
            summary=summary,
            warnings=warnings,
            blocked=blocked,
            before=before,
            after=after,
            apply_label=label,
            state=state,
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        """Work the configuration out again (refused when it isn't what was reviewed), then write
        the Secret before the AlertmanagerConfig that reads it, or remove the AlertmanagerConfig
        before its Secret. The install record keeps the digest of what was applied, or the words
        of what failed."""
        # Held from the check of the record's state to the last write: no install or uninstall
        # begins meanwhile (`InstallStore.begin` and `begin_uninstall` wait for it).
        async with self._services.installs.held(target.cluster_id):
            return await self._apply(ctx, target, planned.state)

    async def _apply(self, ctx: ApplyContext, target: Target, state: dict) -> Applied:
        record = await self._record(target.cluster_id)
        namespace = target.namespace or record.namespace
        desired = await self._desired(record)
        if desired.digest != state["digest"]:
            raise ActionError(409, messages.CONTACTS_STALE)
        mode: Mode = state["mode"]
        if mode == "upsert" and (problems := await reader_problems(ctx.api, namespace)):
            raise ActionError(409, " ".join(problems))
        action = "delete" if mode == "delete" else ("edit" if state["exists"]["amc"] else "create")
        try:
            if mode == "delete":
                await self._remove(ctx.api, namespace, state)
            else:
                await self._write_secret(ctx.api, namespace, desired, state)
                await self._write_amc(ctx.api, namespace, state)
        except BaseException as exc:
            if isinstance(exc, Exception):
                words = _apply_words(exc, action, target)
            else:
                words = CANCELLED
            await finish_even_if_cancelled(self._failed(record, words))
            raise
        await self._services.installs.set_contacts(
            record.cluster_id,
            digest=None if mode == "delete" else desired.digest,
            message=None,
            at=now(),
        )
        return Applied(messages.CONTACTS_UPDATED.format(namespace=namespace))

    async def _failed(self, record: InstallRecord, words: str) -> None:
        try:
            await self._services.installs.set_contacts_message(record.cluster_id, words)
        except Exception as err:  # noqa: BLE001 (the apply's own failure is what is answered)
            log.warning("Recording a failed contact-point apply failed (%s)", type(err).__name__)

    async def _write_secret(
        self, api: ApiClient, namespace: str, desired: DesiredContacts, state: dict
    ) -> None:
        body: dict[str, Any] = {
            "apiVersion": "v1",
            "kind": "Secret",
            "metadata": {
                "name": AMC_NAME,
                "namespace": namespace,
                "labels": {MANAGED_LABEL: MANAGED_BY},
            },
            "type": "Opaque",
            "stringData": dict(desired.secret_data),
        }
        try:
            if state["exists"]["secret"]:
                body["metadata"]["resourceVersion"] = state["resourceVersions"]["secret"]
                await call_json(
                    api, "PUT", secret_path(namespace), timeout=REQUEST_TIMEOUT, body=body
                )
            else:
                await call_json(
                    api, "POST", secret_list_path(namespace), timeout=REQUEST_TIMEOUT, body=body
                )
        except Exception as exc:  # noqa: BLE001 (raised again in the pipeline's words)
            raise _secret_failure(exc, namespace, messages.CONTACTS_WRITE_SECRET_STEP) from None

    async def _write_amc(self, api: ApiClient, namespace: str, state: dict) -> None:
        body = copy.deepcopy(state["body"])
        if state["exists"]["amc"]:
            body["metadata"]["resourceVersion"] = state["resourceVersions"]["amc"]
            await call_json(api, "PUT", amc_path(namespace), timeout=REQUEST_TIMEOUT, body=body)
        else:
            await call_json(
                api, "POST", amc_list_path(namespace), timeout=REQUEST_TIMEOUT, body=body
            )

    async def _remove(self, api: ApiClient, namespace: str, state: dict) -> None:
        if state["exists"]["amc"]:
            await _delete(api, amc_path(namespace), state["uids"]["amc"])
        if state["exists"]["secret"]:
            try:
                await _delete(api, secret_path(namespace), state["uids"]["secret"])
            except Exception as exc:  # noqa: BLE001 (raised again in the pipeline's words)
                raise _secret_failure(
                    exc, namespace, messages.CONTACTS_DELETE_SECRET_STEP
                ) from None


def _updated(live: dict, amc: dict) -> dict:
    """The live AlertmanagerConfig with OmniKrux's spec and label (what an update writes)."""
    body = _shown(live)
    md = body.setdefault("metadata", {})
    md["labels"] = {**(md.get("labels") or {}), **amc["metadata"]["labels"]}
    body["apiVersion"], body["kind"], body["spec"] = API_VERSION, "AlertmanagerConfig", amc["spec"]
    return body


async def _delete(api: ApiClient, path: str, uid: str | None) -> None:
    """Delete by uid (one made since the review is never removed); gone already is fine."""
    body = {"preconditions": {"uid": uid}} if uid else None
    try:
        await call_json(api, "DELETE", path, timeout=REQUEST_TIMEOUT, body=body)
    except ApiException as exc:
        if exc.status != 404:
            raise


def _secret_failure(exc: Exception, namespace: str, step: str) -> ActionError:
    """A Secret step's failure in words (the pipeline's, never a value)."""
    if isinstance(exc, ActionError):
        return exc
    if is_conflict(exc):
        name = f"{namespace}/{AMC_NAME}"
        return ActionError(409, CONFLICT.format(kind="Secret", name=name))
    status = exc.status if isinstance(exc, ApiException) and exc.status in (403, 404) else 502
    if isinstance(exc, ApiException) and exc.status in (400, 422):
        status = 422
    return ActionError(status or 502, kube_error_message(exc, step.format(namespace=namespace)))
