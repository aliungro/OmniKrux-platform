from dataclasses import dataclass
from typing import Literal, Protocol

from omnikrux.cloud.dirs import CloudDirs
from omnikrux.cloud.endpoints import CloudEndpoints
from omnikrux.cloud.http import CloudHttp
from omnikrux.cloud.types import AccountConfig, CloudClusterRef, CloudProvider, DiscoveredCluster
from omnikrux.kube.tokens import TokenFetch


@dataclass(frozen=True)
class AccountIdentity:
    scope: str
    name: str
    principal: str


@dataclass
class DiscoveryResult:
    clusters: list[DiscoveredCluster]
    problems: list[str]


@dataclass(frozen=True)
class ClusterAccess:
    server: str
    ca_data: str | None


@dataclass(frozen=True)
class Choice:
    value: str
    label: str


@dataclass(frozen=True)
class CliLoginInfo:
    provider: CloudProvider
    path: str
    state: Literal["found", "missing", "unreadable"]
    note: str | None
    choices: list[Choice]


class ProviderAdapter(Protocol):
    provider: CloudProvider

    async def cli_login(self) -> CliLoginInfo: ...

    async def verify(self, account: AccountConfig) -> AccountIdentity: ...

    async def discover(self, account: AccountConfig) -> DiscoveryResult: ...

    async def access(self, account: AccountConfig, found: DiscoveredCluster) -> ClusterAccess: ...

    def token_fetch(self, account: AccountConfig, ref: CloudClusterRef) -> TokenFetch: ...

    def forget(self, account_id: str) -> None: ...


def make_adapters(
    http: CloudHttp, endpoints: CloudEndpoints, dirs: CloudDirs
) -> dict[CloudProvider, ProviderAdapter]:
    from omnikrux.cloud.aws import AwsAdapter
    from omnikrux.cloud.azure import AzureAdapter
    from omnikrux.cloud.gcp import GcpAdapter

    return {
        "azure": AzureAdapter(http, endpoints, dirs.azure),
        "aws": AwsAdapter(endpoints, dirs.aws),
        "gcp": GcpAdapter(http, endpoints, dirs.gcloud),
    }
