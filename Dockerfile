# syntax=docker/dockerfile:1
FROM node:22-alpine AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS plugins
ARG TARGETARCH
# Azure kubelogin v0.2.22, from the release's linux archive .sha256 files:
# https://github.com/Azure/kubelogin/releases/tag/v0.2.22
ARG KUBELOGIN_VERSION=0.2.22
ARG KUBELOGIN_AMD64_SHA256=716cbcb1880bca8f0e976b8917d06fcfe04de2c1e737eaaabbb26e2782330119
ARG KUBELOGIN_ARM64_SHA256=306a31d80af443d06fb71e04d2feaf65a6c9cf2e7e806e87b895b77fe2093ea6
# SDK 593.0.0, from Google's published component manifest:
# https://dl.google.com/dl/cloudsdk/channels/rapid/components-2.json
ARG GKE_PLUGIN_BUILD=20261030071842
ARG GKE_PLUGIN_AMD64_SHA256=b8d3bf3ebce3aff0146d85457146869ea66da7dc62d291e176cb88b6e73dd452
ARG GKE_PLUGIN_ARM64_SHA256=773ce0d886108cc47d19816449948b4187bc2b54bb26ec55729e2f34e3f45dcc
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/plugins
RUN set -eu; \
    case "${TARGETARCH}" in \
        amd64) \
            kube_sha="$KUBELOGIN_AMD64_SHA256"; \
            gke_arch=x86_64; gke_sha="$GKE_PLUGIN_AMD64_SHA256" ;; \
        arm64) \
            kube_sha="$KUBELOGIN_ARM64_SHA256"; \
            gke_arch=arm; gke_sha="$GKE_PLUGIN_ARM64_SHA256" ;; \
        *) echo "Unsupported plugin architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 3 -o kubelogin.zip \
        "https://github.com/Azure/kubelogin/releases/download/v${KUBELOGIN_VERSION}/kubelogin-linux-${TARGETARCH}.zip"; \
    curl -fsSL --retry 3 -o gke-plugin.tar.gz \
        "https://dl.google.com/dl/cloudsdk/channels/rapid/components/google-cloud-sdk-gke-gcloud-auth-plugin-linux-${gke_arch}-${GKE_PLUGIN_BUILD}.tar.gz"; \
    printf '%s  %s\n' "$kube_sha" kubelogin.zip "$gke_sha" gke-plugin.tar.gz | sha256sum --strict -c -; \
    unzip -q kubelogin.zip; \
    tar -xzf gke-plugin.tar.gz bin/gke-gcloud-auth-plugin; \
    install -Dm755 "bin/linux_${TARGETARCH}/kubelogin" /out/kubelogin; \
    install -Dm755 bin/gke-gcloud-auth-plugin /out/gke-gcloud-auth-plugin

FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS monitoring-tools
ARG TARGETARCH
# Helm 4.3.1, from the release's linux archive .sha256sum files:
# https://get.helm.sh/helm-v4.3.1-linux-amd64.tar.gz.sha256sum (and -linux-arm64)
ARG HELM_VERSION=4.3.1
ARG HELM_AMD64_SHA256=0403a88ae20913d11b10a2467b50087721fea7581736da6b9d3992f5357fe54b
ARG HELM_ARM64_SHA256=8cf8f66ecbc252ac8f7f06cca68aba88508ddfde3a6a34feb1678ad1694b4f88
# kube-prometheus-stack 93.1.1 (app v0.95.1), the archive's digest in
# https://prometheus-community.github.io/helm-charts/index.yaml
ARG KPS_CHART_VERSION=93.1.1
ARG KPS_CHART_SHA256=b34c1267e469ef1ab5d39028d682d6b106eca7e98231e3bf4c0faf9922875ae3
# loki 7.5.0 (app 3.6.16), the archive's digest in https://grafana.github.io/helm-charts/index.yaml
ARG LOKI_CHART_VERSION=7.5.0
ARG LOKI_CHART_SHA256=bb8b254a57afc6b31ab23a6061216760c91c8ad3499d340442398b88ec603ca8
# alloy 1.15.0 (app v1.21.3), the archive's digest in https://grafana.github.io/helm-charts/index.yaml
ARG ALLOY_CHART_VERSION=1.15.0
ARG ALLOY_CHART_SHA256=2ecc96c05004cc01a45ab23cb390194ad5259ec9d02b42bf148d4468d013aaa3
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/monitoring-tools
RUN set -eu; \
    case "${TARGETARCH}" in \
        amd64) helm_sha="$HELM_AMD64_SHA256" ;; \
        arm64) helm_sha="$HELM_ARM64_SHA256" ;; \
        *) echo "Unsupported Helm architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    kps="kube-prometheus-stack-${KPS_CHART_VERSION}.tgz"; \
    loki="loki-${LOKI_CHART_VERSION}.tgz"; \
    alloy="alloy-${ALLOY_CHART_VERSION}.tgz"; \
    curl -fsSL --retry 3 -o helm.tar.gz \
        "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz"; \
    curl -fsSL --retry 3 -o "$kps" \
        "https://github.com/prometheus-community/helm-charts/releases/download/kube-prometheus-stack-${KPS_CHART_VERSION}/kube-prometheus-stack-${KPS_CHART_VERSION}.tgz"; \
    curl -fsSL --retry 3 -o "$loki" \
        "https://github.com/grafana/helm-charts/releases/download/helm-loki-${LOKI_CHART_VERSION}/loki-${LOKI_CHART_VERSION}.tgz"; \
    curl -fsSL --retry 3 -o "$alloy" \
        "https://github.com/grafana/helm-charts/releases/download/alloy-${ALLOY_CHART_VERSION}/alloy-${ALLOY_CHART_VERSION}.tgz"; \
    printf '%s  %s\n' "$helm_sha" helm.tar.gz "$KPS_CHART_SHA256" "$kps" "$LOKI_CHART_SHA256" "$loki" "$ALLOY_CHART_SHA256" "$alloy" | sha256sum --strict -c -; \
    tar -xzf helm.tar.gz "linux-${TARGETARCH}/helm"; \
    install -Dm755 "linux-${TARGETARCH}/helm" /out/helm; \
    install -Dm644 -t /out/charts "$kps" "$loki" "$alloy"

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/ ./
RUN uv sync --frozen --no-dev --no-editable
COPY --from=frontend /frontend/dist /app/static
COPY --from=plugins /out/kubelogin /out/gke-gcloud-auth-plugin /usr/local/bin/
COPY --from=monitoring-tools /out/helm /usr/local/bin/helm
COPY --from=monitoring-tools /out/charts /app/charts

RUN useradd --uid 10001 --no-create-home --home-dir /app omnikrux \
    && mkdir /data && chown omnikrux:omnikrux /data
USER omnikrux

ENV PATH="/app/.venv/bin:$PATH" \
    OMNIKRUX_IN_CONTAINER=1 \
    OMNIKRUX_DATA_DIR=/data \
    OMNIKRUX_STATIC_DIR=/app/static \
    OMNIKRUX_AZURE_DIR=/cloud/azure \
    OMNIKRUX_AWS_DIR=/cloud/aws \
    OMNIKRUX_GCLOUD_DIR=/cloud/gcloud \
    OMNIKRUX_OCI_DIR=/cloud/oci \
    OMNIKRUX_HELM_BINARY=/usr/local/bin/helm \
    OMNIKRUX_CHARTS_DIR=/app/charts
VOLUME /data
EXPOSE 8080 30000-30019
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health')"]
CMD ["uvicorn", "omnikrux.main:app", "--host", "0.0.0.0", "--port", "8080"]
