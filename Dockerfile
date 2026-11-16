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
    OMNIKRUX_OCI_DIR=/cloud/oci
VOLUME /data
EXPOSE 8080 30000-30019
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health')"]
CMD ["uvicorn", "omnikrux.main:app", "--host", "0.0.0.0", "--port", "8080"]
