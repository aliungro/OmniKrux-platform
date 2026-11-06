from collections.abc import Callable
from dataclasses import dataclass

from omnikrux.resources.rows import ResourceRow, pod_row


@dataclass(frozen=True)
class KindSpec:
    key: str
    group: str
    version: str
    plural: str
    kind: str
    to_row: Callable[[dict, str], ResourceRow]


KINDS: dict[str, KindSpec] = {"pods": KindSpec("pods", "", "v1", "pods", "Pod", pod_row)}
