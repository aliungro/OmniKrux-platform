import json
import re
from dataclasses import asdict, dataclass, field
from typing import Literal

from omnikrux.clusters.kubeconfig import guess_environment
from omnikrux.clusters.models import Environment, Provider

CloudProvider = Literal["azure", "aws", "gcp", "oci"]
KUBE_PROVIDER: dict[CloudProvider, Provider] = {
    "azure": Provider.AKS,
    "aws": Provider.EKS,
    "gcp": Provider.GKE,
    "oci": Provider.OKE,
}
CredentialSourceKind = Literal["cli", "entered", "workload"]

GUID = re.compile(r"^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")
AWS_REGION = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d+$")
PROFILE_NAME = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$")
GCP_PROJECT = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
OCI_OCID = re.compile(r"^ocid1\.[a-z0-9]+\.[a-z0-9-]*\.[a-z0-9-]*\.[a-z0-9]+$")
OCI_REGION = re.compile(r"^[a-z]{2}-[a-z]+-\d+$")

_PRODUCTION = {"production", "prod", "prd", "live"}
_DEVELOPMENT = {"development", "dev", "test", "testing", "qa", "staging", "stage", "sandbox"}


@dataclass(frozen=True)
class NodePool:
    name: str
    count: int | None
    machine_type: str | None
    version: str | None


# Node pools are None when the provider's list couldn't be read (or can't show every node, as
# with EKS self-managed and Fargate nodes): unknown, never shown as "0 node pools".
NodePools = tuple[NodePool, ...] | None


def pools_json(pools: NodePools) -> str:
    return json.dumps(None if pools is None else [asdict(pool) for pool in pools])


def pools_from_json(text: str | None) -> NodePools:
    """Stored pools; a row that never had any (file and upload clusters) reads as empty."""
    pools = json.loads(text or "[]")
    return None if pools is None else tuple(NodePool(**pool) for pool in pools)


@dataclass(frozen=True)
class DiscoveredCluster:
    resource_id: str
    name: str
    region: str
    kubernetes_version: str | None
    node_pools: NodePools
    node_count: int | None
    tags: dict[str, str]
    private: bool
    why_not: str | None
    details: dict = field(repr=False)

    @property
    def addable(self) -> bool:
        return not self.private and self.why_not is None


@dataclass(frozen=True)
class CloudClusterRef:
    account_id: str
    provider: CloudProvider
    resource_id: str
    name: str
    region: str
    details: dict = field(repr=False)


@dataclass
class AccountConfig:
    id: str
    provider: CloudProvider
    source: CredentialSourceKind
    scope: str
    settings: dict
    secret: dict | None = field(repr=False)


def environment_from_tags(tags: dict[str, str], name: str, provider: Provider) -> Environment:
    for key, value in tags.items():
        if key.lower() not in {"environment", "env"}:
            continue
        value = value.lower()
        if value in _PRODUCTION:
            return Environment.PRODUCTION
        if value in _DEVELOPMENT:
            return Environment.DEVELOPMENT
    return guess_environment(name, provider)
