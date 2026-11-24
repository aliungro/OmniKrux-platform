"""The Helm version and chart archives OmniKrux installs with. The Dockerfile's
`monitoring-tools` stage downloads the same files and checks the same SHA-256 sums (a test keeps
them equal); each sum was read from the chart repository's index `digest` and recomputed on the
downloaded archive."""

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
