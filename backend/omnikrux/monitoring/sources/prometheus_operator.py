"""Which Prometheus resource (Prometheus Operator) runs a Prometheus source, and whether OmniKrux
can add rules to it. One place for both questions, so the capability check (what the rule form
offers) and the PrometheusRule review (what is written) never disagree.

A Service is run by a Prometheus resource when its selector names that resource through the
labels the Operator puts on its pods (`SERVING_LABELS`), or when the whole selector fits the pod
labels of exactly one resource in the Service's namespace. Anything else (a plain Helm chart's
Prometheus next to an Operator one, a Service selecting nothing) is not run by the Operator:
OmniKrux never guesses which resource would load a rule it writes."""

from collections.abc import Awaitable, Callable

GROUP = "monitoring.coreos.com"
MANAGED_BY = "app.kubernetes.io/managed-by"
TARGET_LABEL = "omnikrux.io/target"
# The Service selector labels the Operator (and kube-prometheus-stack) put on a Prometheus's
# pods, naming the Prometheus resource.
SERVING_LABELS = ("operator.prometheus.io/name", "prometheus")

NOT_SERVED = (
    "{source} isn't run by the Prometheus Operator, so OmniKrux can't add rules to it. "
    "Run the rule in OmniKrux."
)
NOT_SERVED_OTHER = (
    "{source} isn't run by the Prometheus Operator, so OmniKrux can't add rules to it. "
    "Run the rule in OmniKrux, or use {other}."
)
NO_RULE_SELECTOR = (
    "This Prometheus doesn't load any PrometheusRule (its ruleSelector is empty). "
    "Run this rule in OmniKrux instead."
)
UNMEETABLE = (
    "This Prometheus selects rules with a pattern OmniKrux can't meet ({expression}). "
    "Run this rule in OmniKrux instead."
)
NAMESPACE_UNMATCHED = (
    "This Prometheus reads rules only from namespaces matching {selector}, and {namespace} "
    "doesn't match."
)

# Reads the object at an API path; None when the cluster says it isn't there.
Read = Callable[[str], Awaitable[dict | None]]


def pod_labels(prometheus: dict) -> dict[str, str]:
    """The labels the Operator puts on the pods of a Prometheus resource."""
    name = str((prometheus.get("metadata") or {}).get("name") or "")
    spec = prometheus.get("spec") or {}
    own = (spec.get("podMetadata") or {}).get("labels") or {}
    labels = {str(k): str(v) for k, v in own.items()} if isinstance(own, dict) else {}
    labels |= {
        "app.kubernetes.io/name": "prometheus",
        MANAGED_BY: "prometheus-operator",
        "app.kubernetes.io/instance": name,
        "operator.prometheus.io/name": name,
        "prometheus": name,
    }
    return labels


async def serving_prometheus(read: Read, namespace: str | None, service: str | None):
    """The Prometheus resource that runs the Service `namespace/service`; None when no resource
    does (or OmniKrux can't tell which one)."""
    if not namespace or not service:
        return None
    found = await read(f"/api/v1/namespaces/{namespace}/services/{service}")
    if found is None:
        return None
    selector = (found.get("spec") or {}).get("selector") or {}
    if not isinstance(selector, dict) or not selector:
        return None
    listed = await read(f"/apis/{GROUP}/v1/namespaces/{namespace}/prometheuses") or {}
    items = [i for i in listed.get("items") or [] if isinstance(i, dict)]
    named = next((selector[k] for k in SERVING_LABELS if selector.get(k)), None)
    if named is not None:
        return next((i for i in items if (i.get("metadata") or {}).get("name") == named), None)
    wanted = {str(k): str(v) for k, v in selector.items()}.items()
    fits = [i for i in items if wanted <= pod_labels(i).items()]
    return fits[0] if len(fits) == 1 else None


def _expression_text(expr: dict) -> str:
    key, op = str(expr.get("key", "")), str(expr.get("operator", ""))
    values = expr.get("values") or []
    if op in ("In", "NotIn"):
        return f"{key} {op} ({', '.join(str(v) for v in values)})"
    return f"{key} {op}"


def selector_text(selector: dict) -> str:
    """A label selector as kubectl writes one: `team=x, env In (a, b)`."""
    parts = [f"{k}={v}" for k, v in (selector.get("matchLabels") or {}).items()]
    parts += [_expression_text(e) for e in selector.get("matchExpressions") or []]
    return ", ".join(parts)


def labels_for(selector: dict) -> tuple[dict[str, str], str | None]:
    """The labels that meet a `ruleSelector` (`matchLabels`; `In` with one value; `Exists`),
    or the part OmniKrux can't meet, in words."""
    labels = {str(k): str(v) for k, v in (selector.get("matchLabels") or {}).items()}
    exists: list[str] = []
    for expr in selector.get("matchExpressions") or []:
        if not isinstance(expr, dict):
            return {}, str(expr)
        key, op = str(expr.get("key", "")), expr.get("operator")
        values = expr.get("values") or []
        if op == "In" and len(values) == 1 and labels.get(key, str(values[0])) == str(values[0]):
            labels[key] = str(values[0])
        elif op == "Exists" and key:
            exists.append(key)
        else:
            return {}, _expression_text(expr)
    for key in exists:
        labels.setdefault(key, "true")
    for key in (MANAGED_BY, TARGET_LABEL):
        if key in labels:  # OmniKrux sets these itself
            return {}, f"{key}={labels[key]}"
    return labels, None


def matches(selector: dict, labels: dict) -> bool:
    for k, v in (selector.get("matchLabels") or {}).items():
        if labels.get(k) != v:
            return False
    for expr in selector.get("matchExpressions") or []:
        if not isinstance(expr, dict):
            return False
        key, op = expr.get("key"), expr.get("operator")
        values = [str(v) for v in expr.get("values") or []]
        if op == "In" and not (key in labels and labels[key] in values):
            return False
        if op == "NotIn" and key in labels and labels[key] in values:
            return False
        if op == "Exists" and key not in labels:
            return False
        if op == "DoesNotExist" and key in labels:
            return False
        if op not in ("In", "NotIn", "Exists", "DoesNotExist"):
            return False
    return True


async def rule_labels(
    read: Read, prometheus: dict, namespace: str
) -> tuple[dict[str, str], str | None]:
    """The labels a PrometheusRule in `namespace` needs so `prometheus` loads it, or why it
    can't load one there, in words. A `ruleNamespaceSelector` that is missing or empty means
    the resource's own namespace (or all of them), which is where OmniKrux puts its rules."""
    spec = prometheus.get("spec") or {}
    selector = spec.get("ruleSelector")
    if not isinstance(selector, dict):
        return {}, NO_RULE_SELECTOR
    labels, unmet = labels_for(selector)
    if unmet is not None:
        return {}, UNMEETABLE.format(expression=unmet)
    ns_selector = spec.get("ruleNamespaceSelector")
    if isinstance(ns_selector, dict) and (
        ns_selector.get("matchLabels") or ns_selector.get("matchExpressions")
    ):
        found = await read(f"/api/v1/namespaces/{namespace}") or {}
        ns_labels = (found.get("metadata") or {}).get("labels") or {}
        if not matches(ns_selector, ns_labels):
            return {}, NAMESPACE_UNMATCHED.format(
                selector=selector_text(ns_selector), namespace=namespace
            )
    return labels, None
