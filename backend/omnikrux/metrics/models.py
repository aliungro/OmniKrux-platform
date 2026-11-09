"""What the metrics routes answer with."""

from typing import Literal

from pydantic import BaseModel

State = Literal["ok", "unavailable", "error"]


class Usage(BaseModel):
    cpu_m: int
    memory_b: int
    at: str  # metrics-server's own timestamp for the measurement
    window_s: float
    stale: bool  # metrics-server has nothing newer than STALE_SECONDS before we asked


class NodeSize(BaseModel):
    cpu_m: int | None
    memory_b: int | None


class ClusterMetrics(BaseModel):
    state: State
    message: str | None = None
    fetched_at: str | None = None
    # "ns/name" for pods, "name" for nodes. Empty unless `state` is ok.
    items: dict[str, Usage] = {}
    nodes: dict[str, NodeSize] = {}


class MetricsOut(BaseModel):
    kind: Literal["pods", "nodes"]
    clusters: dict[str, ClusterMetrics]


class ContainerUsage(BaseModel):
    name: str
    cpu_m: int
    memory_b: int
    cpu_request_m: int | None = None
    cpu_limit_m: int | None = None
    memory_request_b: int | None = None
    memory_limit_b: int | None = None


class PodMetrics(BaseModel):
    state: State
    message: str | None = None
    at: str | None = None
    window_s: float | None = None
    stale: bool = False
    containers: list[ContainerUsage] = []


class NodeMetrics(BaseModel):
    state: State
    message: str | None = None
    at: str | None = None
    window_s: float | None = None
    stale: bool = False
    cpu_m: int | None = None
    memory_b: int | None = None
    allocatable_cpu_m: int | None = None
    allocatable_memory_b: int | None = None
    capacity_cpu_m: int | None = None
    capacity_memory_b: int | None = None
