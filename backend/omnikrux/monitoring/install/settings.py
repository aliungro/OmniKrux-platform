"""What the user can set for an install, what OmniKrux knows about the cluster, and the words
for a setting that doesn't fit."""

import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Literal

from omnikrux.monitoring.install import messages

Component = Literal["metrics", "logs"]
COMPONENT_ORDER: tuple[Component, ...] = ("metrics", "logs")


@dataclass(frozen=True)
class Resources:
    cpu_request: str
    memory_request: str
    memory_limit: str


@dataclass(frozen=True)
class InstallSettings:
    namespace: str = "monitoring"
    retention_days: int = 7
    persist: bool = True
    prometheus_storage: str = "20Gi"
    loki_storage: str = "10Gi"
    alertmanager_storage: str = "1Gi"
    prometheus: Resources = Resources("200m", "512Mi", "2Gi")
    alertmanager: Resources = Resources("10m", "32Mi", "128Mi")
    loki: Resources = Resources("100m", "256Mi", "1Gi")
    alloy: Resources = Resources("50m", "128Mi", "512Mi")


@dataclass(frozen=True)
class ReleaseRef:
    name: str
    revision: int
    status: str
    owner_label: str | None


@dataclass(frozen=True)
class ClusterFacts:
    cluster_id: str
    cluster_name: str
    kube_version: str
    default_storage_class: str | None
    namespace_exists: bool
    # CRD name -> its `operator.prometheus.io/version` annotation (None when it has none).
    served_monitoring_crds: Mapping[str, str | None]
    foreign_operator: str | None  # "{namespace}/{name}"
    releases: Mapping[str, ReleaseRef]
    environment: str


@dataclass(frozen=True)
class SettingProblem:
    field: str
    message: str


_NAMESPACE = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$")
_STORAGE = re.compile(r"^[1-9][0-9]*(Mi|Gi|Ti)$")
_CPU = re.compile(r"^([1-9][0-9]*m|[0-9]+(\.[0-9]+)?)$")
_MEMORY = re.compile(r"^[1-9][0-9]*(Ki|Mi|Gi)$")
_MEMORY_UNITS = {"Ki": 1024, "Mi": 1024**2, "Gi": 1024**3}
RESOURCE_COMPONENTS = ("prometheus", "alertmanager", "loki", "alloy")


def _memory_bytes(text: str) -> int:
    return int(text[:-2]) * _MEMORY_UNITS[text[-2:]]


def _namespace_problem(namespace: str) -> str | None:
    if len(namespace) > 63 or not _NAMESPACE.match(namespace):
        return messages.SETTING_NAMESPACE
    if namespace == "default" or namespace.startswith("kube-"):
        return messages.SETTING_NAMESPACE_RESERVED.format(namespace=namespace)
    return None


def validate_settings(s: InstallSettings) -> list[SettingProblem]:
    problems: list[SettingProblem] = []
    if (message := _namespace_problem(s.namespace)) is not None:
        problems.append(SettingProblem("namespace", message))
    days = s.retention_days
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= 90:
        problems.append(SettingProblem("retention_days", messages.SETTING_RETENTION))
    for name in ("prometheus_storage", "loki_storage", "alertmanager_storage"):
        if not _STORAGE.match(getattr(s, name)):
            problems.append(SettingProblem(name, messages.SETTING_STORAGE))
    for component in RESOURCE_COMPONENTS:
        resources: Resources = getattr(s, component)
        if not _CPU.match(resources.cpu_request):
            problems.append(SettingProblem(f"{component}.cpu_request", messages.SETTING_CPU))
        request_ok = _MEMORY.match(resources.memory_request) is not None
        limit_ok = _MEMORY.match(resources.memory_limit) is not None
        if not request_ok:
            problems.append(SettingProblem(f"{component}.memory_request", messages.SETTING_MEMORY))
        if not limit_ok:
            problems.append(SettingProblem(f"{component}.memory_limit", messages.SETTING_MEMORY))
        if (
            request_ok
            and limit_ok
            and _memory_bytes(resources.memory_limit) < _memory_bytes(resources.memory_request)
        ):
            problems.append(
                SettingProblem(
                    f"{component}.memory_limit",
                    messages.SETTING_LIMIT_BELOW_REQUEST.format(request=resources.memory_request),
                )
            )
    return problems


def effective_settings(
    s: InstallSettings, facts: ClusterFacts
) -> tuple[InstallSettings, list[str]]:
    """The settings the install really uses, and warnings for what the cluster changed."""
    if s.persist and facts.default_storage_class is None:
        return replace(s, persist=False), [messages.NO_STORAGE_CLASS]
    return s, []
