"""What a chart creates with our values (`helm template`) and what the Prometheus Operator
chart ships as CustomResourceDefinitions (`helm show crds`)."""

import asyncio
import tempfile
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.helm import (
    HelmResult,
    HelmRunner,
    helm_error_message,
    show_crds_args,
    template_args,
)
from omnikrux.monitoring.install.tools import ToolsStatus
from omnikrux.monitoring.install.values import ReleaseSpec

API_VERSIONS = ("monitoring.coreos.com/v1", "monitoring.coreos.com/v1alpha1")
RENDER_TIMEOUT_SECONDS = 120.0
CRDS_MAX_OUTPUT = 32 * 1024 * 1024
CRDS_CHART = "kube-prometheus-stack"


class _Loader(getattr(yaml, "CSafeLoader", yaml.SafeLoader)):  # type: ignore[misc]
    """A plain `=` is YAML 1.1's "value" tag, which PyYAML can't build; the CRDs use it as an
    ordinary string (an enum value), so it reads as the text `=`."""


_Loader.add_constructor("tag:yaml.org,2002:value", lambda loader, node: node.value)


class RenderRefused(Exception):
    """Helm (or the pinned tools) couldn't give an answer; the message is in plain words."""


@dataclass(frozen=True)
class ObjectRef:
    kind: str
    name: str
    namespace: str | None


@dataclass(frozen=True)
class Rendered:
    release: str
    objects: tuple[ObjectRef, ...]
    # The parsed documents, for callers that look inside (the tests do; the review doesn't).
    documents: tuple[dict[str, Any], ...] = ()


def _documents(text: str, step: str) -> list[dict[str, Any]]:
    try:
        docs = [d for d in yaml.load_all(text, Loader=_Loader) if d is not None]
    except yaml.YAMLError:
        raise RenderRefused(messages.RENDER_UNREADABLE.format(step=step)) from None
    if not all(isinstance(d, dict) for d in docs):
        raise RenderRefused(messages.RENDER_UNREADABLE.format(step=step))
    return docs


def _accepted(result: HelmResult, step: str) -> str:
    """Helm's output, or RenderRefused: a failure, a timeout, or a cut answer (a cut
    multi-document YAML can still parse, so a partial list is never used)."""
    if result.code != 0 or result.timeout is not None:
        raise RenderRefused(
            helm_error_message(result, step=step, secrets=(), hosts=(), cloud=False)
        )
    if result.truncated:
        raise RenderRefused(messages.RENDER_TOO_LONG.format(step=step))
    return result.stdout


def _chart(tools: ToolsStatus, key: str) -> Path:
    if not tools.available or key not in tools.charts:
        raise RenderRefused(tools.message or messages.TOOLS_NO_HELM.format(where=""))
    return tools.charts[key]


async def render(
    helm: HelmRunner,
    tools: ToolsStatus,
    release: ReleaseSpec,
    values: dict,
    *,
    namespace: str,
    kube_version: str,
) -> Rendered:
    chart = _chart(tools, release.chart)
    step = messages.RENDER_STEP.format(chart=release.chart)
    with tempfile.TemporaryDirectory(prefix="omnikrux-render-") as folder:
        path = Path(folder) / "values.yaml"
        path.write_text(yaml.safe_dump(values, sort_keys=False), encoding="utf-8")
        result = await helm.run(
            template_args(
                release.release,
                chart,
                namespace,
                path,
                kube_version=kube_version,
                api_versions=API_VERSIONS,
            ),
            kubeconfig=None,
            timeout=RENDER_TIMEOUT_SECONDS,
        )
    docs = await asyncio.to_thread(_documents, _accepted(result, step), step)
    objects = []
    for doc in docs:
        meta = doc.get("metadata") or {}
        objects.append(
            ObjectRef(str(doc.get("kind", "")), str(meta.get("name", "")), meta.get("namespace"))
        )
    return Rendered(release.release, tuple(objects), tuple(docs))


async def chart_crds(helm: HelmRunner, tools: ToolsStatus) -> list[dict]:
    """Every CustomResourceDefinition kube-prometheus-stack ships (10 at the pinned version)."""
    chart = _chart(tools, CRDS_CHART)
    step = messages.CRDS_STEP.format(chart=CRDS_CHART)
    result = await helm.run(
        show_crds_args(chart),
        kubeconfig=None,
        timeout=RENDER_TIMEOUT_SECONDS,
        max_output=CRDS_MAX_OUTPUT,
    )
    return await asyncio.to_thread(_documents, _accepted(result, step), step)


# (kinds, singular, plural), in the order the sentence reads.
_GROUPS: tuple[tuple[tuple[str, ...], str, str], ...] = (
    (("Deployment",), "Deployment", "Deployments"),
    (("StatefulSet",), "StatefulSet", "StatefulSets"),
    (("DaemonSet",), "DaemonSet", "DaemonSets"),
    (("Service",), "Service", "Services"),
    (("ConfigMap",), "ConfigMap", "ConfigMaps"),
    (("Secret",), "Secret", "Secrets"),
    (("ServiceAccount",), "ServiceAccount", "ServiceAccounts"),
    (
        ("ClusterRole", "ClusterRoleBinding"),
        "cluster-wide role or binding",
        "cluster-wide roles and bindings",
    ),
    (("Role", "RoleBinding"), "role or binding", "roles and bindings"),
    (("ServiceMonitor",), "ServiceMonitor", "ServiceMonitors"),
    (("PrometheusRule",), "PrometheusRule", "PrometheusRules"),
    (("Prometheus",), "Prometheus", "Prometheus"),
    (("Alertmanager",), "Alertmanager", "Alertmanager"),
)


def objects_sentence(objects: Sequence[ObjectRef]) -> str:
    """e.g. `2 Deployments, 1 DaemonSet and 3 other objects`."""
    counts: dict[str, int] = {}
    for obj in objects:
        counts[obj.kind] = counts.get(obj.kind, 0) + 1
    parts: list[str] = []
    named: set[str] = set()
    for kinds, singular, plural in _GROUPS:
        named.update(kinds)
        n = sum(counts.get(k, 0) for k in kinds)
        if n:
            parts.append(f"{n} {singular if n == 1 else plural}")
    other = sum(n for kind, n in counts.items() if kind not in named)
    if other:
        parts.append(f"{other} other {'object' if other == 1 else 'objects'}")
    if not parts:
        return "no objects"
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " and " + parts[-1]
