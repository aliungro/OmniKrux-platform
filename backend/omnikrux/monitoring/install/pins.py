"""The Helm version and chart archives OmniKrux installs with. The Dockerfile's
`monitoring-tools` stage downloads the same files and checks the same SHA-256 sums (a test keeps
them equal); each sum was read from the chart repository's index `digest` and recomputed on the
downloaded archive."""

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

HELM_VERSION = "4.3.1"

ChartKey = Literal["kube-prometheus-stack", "loki", "alloy"]


@dataclass(frozen=True)
class ChartPin:
    key: ChartKey
    version: str
    app_version: str
    sha256: str
    url: str

    @property
    def file(self) -> str:
        return f"{self.key}-{self.version}.tgz"


CHARTS = MappingProxyType(
    {
        "kube-prometheus-stack": ChartPin(
            key="kube-prometheus-stack",
            version="93.1.1",
            app_version="v0.95.1",
            sha256="b34c1267e469ef1ab5d39028d682d6b106eca7e98231e3bf4c0faf9922875ae3",
            url=(
                "https://github.com/prometheus-community/helm-charts/releases/download/"
                "kube-prometheus-stack-93.1.1/kube-prometheus-stack-93.1.1.tgz"
            ),
        ),
        "loki": ChartPin(
            key="loki",
            version="7.5.0",
            app_version="3.6.16",
            sha256="bb8b254a57afc6b31ab23a6061216760c91c8ad3499d340442398b88ec603ca8",
            url=(
                "https://github.com/grafana/helm-charts/releases/download/"
                "helm-loki-7.5.0/loki-7.5.0.tgz"
            ),
        ),
        "alloy": ChartPin(
            key="alloy",
            version="1.15.0",
            app_version="v1.21.3",
            sha256="2ecc96c05004cc01a45ab23cb390194ad5259ec9d02b42bf148d4468d013aaa3",
            url=(
                "https://github.com/grafana/helm-charts/releases/download/"
                "alloy-1.15.0/alloy-1.15.0.tgz"
            ),
        ),
    }
)


# --- Docker hosts and servers -------------------------------------------------------------------
# The same tools as the charts, for a docker-compose file and a systemd install script. The tags
# are the Docker Hub images of the versions the pinned charts deploy (kube-prometheus-stack runs
# `quay.io/prometheus/prometheus:v3.16.0-distroless`; the compose file uses the Hub tag of the
# same version).

IMAGES = MappingProxyType(
    {
        "prometheus": "prom/prometheus:v3.16.0",
        "alertmanager": "prom/alertmanager:v0.34.2",
        "node_exporter": "prom/node-exporter:v1.12.1",
        "loki": "grafana/loki:3.6.16",
        "alloy": "grafana/alloy:v1.21.3",
    }
)

# The version each pinned chart deploys, as recorded when the pins were chosen: what `IMAGES` and
# `SERVER_BINARIES` must follow.
CHART_IMAGE_VERSIONS = MappingProxyType(
    {
        "prometheus": "3.16.0",
        "alertmanager": "0.34.2",
        "node_exporter": "1.12.1",
        "loki": "3.6.16",
        "alloy": "1.21.3",
    }
)

Arch = Literal["amd64", "arm64"]
ARCHES: tuple[Arch, ...] = ("amd64", "arm64")


@dataclass(frozen=True)
class BinaryPin:
    tool: str
    version: str
    url_template: str  # {V} the version, {arch} amd64 or arm64
    sha256: Mapping[Arch, str]  # of the downloaded file, read from the release's official sums

    def file(self, arch: Arch) -> str:
        return self.url(arch).rsplit("/", 1)[1]

    def url(self, arch: Arch) -> str:
        return self.url_template.format(V=self.version, arch=arch)


_PROMETHEUS_URL = "https://github.com/prometheus/{tool}/releases/download/v{{V}}/{tool}-{{V}}.linux-{{arch}}.tar.gz"
_GRAFANA_URL = (
    "https://github.com/grafana/{tool}/releases/download/v{{V}}/{tool}-linux-{{arch}}.zip"
)

SERVER_BINARIES = MappingProxyType(
    {
        "prometheus": BinaryPin(
            "prometheus",
            "3.16.0",
            _PROMETHEUS_URL.format(tool="prometheus"),
            {
                "amd64": "68727009472a2c02e1ff7f062fd5b3e637285bffc8fc2d340c76fb449d6e0f34",
                "arm64": "fd8571b8162f4020232d886f17340bcf92e1722985ae3b4c1d096157826c0fbe",
            },
        ),
        "alertmanager": BinaryPin(
            "alertmanager",
            "0.34.2",
            _PROMETHEUS_URL.format(tool="alertmanager"),
            {
                "amd64": "17ee14acd0f6ba6e25a436ff223d9c17ddd5cf484f543ad12f0932eaa89ba186",
                "arm64": "5aaad82e3d167c30c06ce7d38677d2892a6f66f4c3613ea17af7481750fdd0b0",
            },
        ),
        "node_exporter": BinaryPin(
            "node_exporter",
            "1.12.1",
            _PROMETHEUS_URL.format(tool="node_exporter"),
            {
                "amd64": "b51d8a76aa2a9156a55d501aca6276fae09e262259a5e4e831d2c2222f084e63",
                "arm64": "ad35b605f9954b9f1ffddf5ba054bdc5a98d790b9eae5291e1eeb83f1ecbd0e7",
            },
        ),
        "loki": BinaryPin(
            "loki",
            "3.6.16",
            _GRAFANA_URL.format(tool="loki"),
            {
                "amd64": "4413e794f93b439d607cd5879686e7abf9934b32bdb5dc95efc5dbcd70e7cb3b",
                "arm64": "ab5b386fbd1f3ccbd1b1f58733df8e99e2b480e71136f13fd69879ae048e4815",
            },
        ),
        "alloy": BinaryPin(
            "alloy",
            "1.21.3",
            _GRAFANA_URL.format(tool="alloy"),
            {
                "amd64": "50d23af2d0f98c00beac6ce9a365693e60f87fb76b6cad6fe1d161e80588af6d",
                "arm64": "ca2f383cc60491877b21aef50c54af6a198f6c861c2c4b80f41ec49ad73b1b93",
            },
        ),
    }
)
