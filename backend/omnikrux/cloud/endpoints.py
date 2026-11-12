import json
from dataclasses import dataclass, fields

from yarl import URL

from omnikrux.cloud.messages import CLOUD_CLUSTER_ENDPOINT_INVALID
from omnikrux.cloud.types import CloudProvider

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "host.docker.internal"}
_OVERRIDE_COPY = (
    "OMNIKRUX_CLOUD_ENDPOINTS may only point at this machine "
    "(127.0.0.1, localhost, [::1] or host.docker.internal): it exists for testing against fake clouds"
)
_CLUSTER_API_ENDPOINTS = {
    "azure": "azure_arm",
    "aws": "aws_eks",
    "gcp": "gcp_container",
    "oci": "oci_containerengine",
}


class InvalidClusterEndpoint(ValueError):
    """The cluster server URL cannot be stored or used for cloud credentials."""


def _http_url(value: str) -> URL:
    if not isinstance(value, str) or any(char.isspace() or ord(char) < 32 for char in value):
        raise ValueError
    if "\\" in value or "#" in value:
        raise ValueError
    url = URL(value)
    if (
        url.scheme not in {"http", "https"}
        or not url.raw_host
        or url.raw_user is not None
        or url.raw_password is not None
        or not 1 <= (url.port or 0) <= 65535
    ):
        raise ValueError
    return url


def same_origin(url: str, expected: str) -> bool:
    try:
        actual_url = _http_url(url)
        expected_url = _http_url(expected)
    except (TypeError, ValueError):
        return False
    return (actual_url.scheme, actual_url.raw_host, actual_url.port) == (
        expected_url.scheme,
        expected_url.raw_host,
        expected_url.port,
    )


@dataclass(frozen=True)
class CloudEndpoints:
    azure_login: str = "https://login.microsoftonline.com"
    azure_arm: str = "https://management.azure.com"
    aws_sts: str = "https://sts.{region}.amazonaws.com"
    aws_eks: str = "https://eks.{region}.amazonaws.com"
    aws_sso: str = "https://portal.sso.{region}.amazonaws.com"
    gcp_oauth: str = "https://oauth2.googleapis.com/token"
    gcp_container: str = "https://container.googleapis.com"
    oci_identity: str = "https://identity.{region}.oci.oraclecloud.com"
    oci_containerengine: str = "https://containerengine.{region}.oci.oraclecloud.com"
    oci_cluster_request: str = "https://containerengine.{region}.oraclecloud.com"

    def url(self, name: str, region: str | None = None) -> str:
        if name not in _ENDPOINT_NAMES:
            raise ValueError("Unknown cloud endpoint.")
        endpoint: str = getattr(self, name)
        if "{region}" in endpoint:
            if not region:
                raise ValueError("A region is required for this cloud endpoint.")
            return endpoint.replace("{region}", region)
        return endpoint

    def validate_cluster_server(self, provider: CloudProvider, server: str) -> None:
        try:
            url = _http_url(server)
            if "?" in server:
                raise ValueError
            if url.scheme == "http":
                # The provider fake and its Kubernetes API can run on separate ports.
                fake = _http_url(self.url(_CLUSTER_API_ENDPOINTS[provider], "test-region"))
                if url.raw_host not in _LOCAL_HOSTS or url.raw_host != fake.raw_host:
                    raise ValueError
        except (TypeError, ValueError):
            raise InvalidClusterEndpoint(CLOUD_CLUSTER_ENDPOINT_INVALID) from None

    @classmethod
    def from_json(cls, text: str) -> "CloudEndpoints":
        try:
            overrides = json.loads(text)
            if not isinstance(overrides, dict):
                raise TypeError
        except (TypeError, ValueError, RecursionError):
            raise ValueError("OMNIKRUX_CLOUD_ENDPOINTS must be a JSON object of URLs.") from None
        if overrides.keys() - _ENDPOINT_NAMES:
            raise ValueError("OMNIKRUX_CLOUD_ENDPOINTS contains an unknown endpoint name.")
        for value in overrides.values():
            try:
                url = _http_url(value)
                if "?" in value:
                    raise ValueError
            except (ValueError, TypeError):
                raise ValueError(f"{_OVERRIDE_COPY}. Check the endpoint URL.") from None
            if url.raw_host not in _LOCAL_HOSTS:
                raise ValueError(f"{_OVERRIDE_COPY}, not {url.origin()}.")
        return cls(**overrides)


_ENDPOINT_NAMES = frozenset(item.name for item in fields(CloudEndpoints))
